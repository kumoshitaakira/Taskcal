/**
 * 返信の解釈と承諾の生成（A12、D04、Q03〜Q05、Q09）。
 *   docker compose up -d db && npm run migrate
 *
 * モデルは注入した fake を使う。**モデルの品質を確かめるものではない。**
 * 決定的検査・状態遷移・A12のガードが働くことだけを見る（AGENTS.md：決定的テストと
 * 実モデル評価を分ける）。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TaskcalError } from "@/contracts/errors";
import type { InboundEvent } from "@/contracts/messaging-gateway";
import type { ModelReplyOutput } from "@/contracts/model-output";
import { createFakeModelGateway, replyOutput } from "../fakes/model-gateway";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write("\n[integration] DATABASE_URL が未設定のため、解釈を確認していません。\n\n");
}

const CONNECTION = "mock:interpret";
const OFFER_START = "2026-09-28T18:00:00+09:00";
const OFFER_END = "2026-09-28T22:00:00+09:00";

/**
 * 外部キーの依存順に消す。承諾→解釈→受信→メッセージ→打診→案件。
 * 逆順で消すと参照が残り、次のテストの準備が落ちる。
 *
 * 店舗IDは実行ごとに変わるので、接続範囲からも案件を集める。前の実行が途中で
 * 落ちて残した行は、店舗だけを見ると届かない。
 */
async function clearCaseDataWith(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { case_id: string }[] }> },
  storeId: string,
  connectionId: string,
): Promise<void> {
  const { rows } = await tx.query(
    `select case_id from absence_case where store_id = $1
     union
     select case_id from inbound_event where connection_id = $2 and case_id is not null`,
    [storeId, connectionId],
  );
  const ids = rows.map((row) => row.case_id);
  if (ids.length === 0) return;

  const byCase = (table: string) => tx.query(`delete from ${table} where case_id = any($1)`, [ids]);

  await byCase("commitment");
  await byCase("reply_interpretation");
  await tx.query("delete from inbound_event where connection_id = $1 or case_id = any($2)", [
    connectionId,
    ids,
  ]);
  await byCase("notification_outbox");
  await tx.query(
    `delete from mock_inbox_item where message_id in
       (select message_id from outreach_message where case_id = any($1))`,
    [ids],
  );
  await tx.query(
    `delete from message_delivery where message_id in
       (select message_id from outreach_message where case_id = any($1))`,
    [ids],
  );
  await byCase("outreach_message");
  await byCase("outreach");
  await byCase("case_processing_event");
  await tx.query("delete from absence_case where case_id = any($1)", [ids]);
}

describe.skipIf(!connectionString)("返信の解釈（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let receive: ReturnType<typeof import("@/application/receive-inbound-event").receiveInboundEvent>;
  let makeInterpret: (
    gateway: ReturnType<typeof createFakeModelGateway>,
  ) => ReturnType<typeof import("@/application/interpret-reply").interpretReply>;
  /** モデル応答の直後、適用の直前に割り込む。並行更新の再現に使う。 */
  let interpretWithHook: (
    gateway: ReturnType<typeof createFakeModelGateway>,
    afterModel: () => Promise<void>,
  ) => ReturnType<typeof import("@/application/interpret-reply").interpretReply>;

  const storeId = randomUUID();
  const staffId = randomUUID();
  const absentStaffId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const endpointKey = `staff:${randomUUID()}`;
  let caseId: string;
  let outreachId: string;
  let offerMessageId: string;
  const now = "2026-09-28T09:00:00+09:00";

  const clearCaseData = (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) =>
    clearCaseDataWith(tx, storeId, CONNECTION);

  function event(body: string): InboundEvent {
    const at = new Date().toISOString();
    return {
      provider: "mock",
      connectionId: CONNECTION,
      eventId: `evt-${randomUUID()}`,
      occurredAt: at,
      receivedAt: at,
      from: { provider: "mock", connectionId: CONNECTION, endpointKey, endpointVersion: 1 },
      inReplyToMessageId: offerMessageId,
      body,
      channelVerified: false,
    };
  }

  /** 返信を入れて、その受信IDを返す。 */
  async function reply(body: string): Promise<string> {
    const result = await receive(event(body));
    if (!result.ok) throw new Error("受信に失敗しました");
    return result.inboundEventId;
  }

  async function commitments() {
    const { rows } = await withTransaction((tx) =>
      tx.query<{ status: string; start_at: Date; end_at: Date; version: number }>(
        "select status, start_at, end_at, version from commitment where case_id = $1 order by version",
        [caseId],
      ),
    );
    return rows;
  }

  async function outreachState(): Promise<string> {
    const { rows } = await withTransaction((tx) =>
      tx.query<{ state: string }>("select state from outreach where outreach_id = $1", [
        outreachId,
      ]),
    );
    return rows[0]?.state ?? "";
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    const { receiveInboundEvent } = await import("@/application/receive-inbound-event");
    const { interpretReply } = await import("@/application/interpret-reply");
    const { createPgInboundEventRepository } = await import("@/adapters/db/inbound-repository");
    const { createPgOutreachRepository } = await import("@/adapters/db/outreach-repository");
    const { createPgAbsenceCaseRepository } = await import("@/adapters/db/case-repository");
    const { createPgCommitmentRepository } = await import("@/adapters/db/commitment-repository");
    const { createPgReplyInterpretationRepository } =
      await import("@/adapters/db/interpretation-repository");
    const { createPgOutboxRepository } = await import("@/adapters/db/outbox-repository");

    const inbound = createPgInboundEventRepository();
    const outreaches = createPgOutreachRepository();
    receive = receiveInboundEvent({ inbound, outreaches });
    interpretWithHook = (model, afterModel) =>
      interpretReply({
        model: {
          isConfigured: () => model.isConfigured(),
          async interpretReply(request) {
            const result = await model.interpretReply(request);
            await afterModel();
            return result;
          },
        },
        cases: createPgAbsenceCaseRepository(),
        outreaches,
        inbound,
        interpretations: createPgReplyInterpretationRepository(),
        commitments: createPgCommitmentRepository(),
        outbox: createPgOutboxRepository(),
        clock: { now: () => now },
        ids: { next: () => randomUUID() },
      });
    makeInterpret = (model) =>
      interpretReply({
        model,
        cases: createPgAbsenceCaseRepository(),
        outreaches,
        inbound,
        interpretations: createPgReplyInterpretationRepository(),
        commitments: createPgCommitmentRepository(),
        outbox: createPgOutboxRepository(),
        clock: { now: () => now },
        ids: { next: () => randomUUID() },
      });

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '解釈テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const id of [staffId, absentStaffId]) {
        await tx.query(
          `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
           values ($1, $2, '架空', 'FLOOR', 9600)`,
          [id, storeId],
        );
      }
      await tx.query(
        `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, '2026-09-28')`,
        [scheduleId, storeId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR', $5, $6, 'SCHEDULED')`,
        [absentShift, scheduleId, storeId, absentStaffId, OFFER_START, OFFER_END],
      );
    });
  });

  beforeEach(async () => {
    caseId = randomUUID();
    outreachId = randomUUID();
    offerMessageId = randomUUID();
    await withTransaction(async (tx) => {
      await clearCaseData(tx);
      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, '2026-09-28', $5, $6, 'FLOOR', $7, $8,
                 '2026-09-28T16:00:00+09:00', 'COORDINATING', 'run-interpret')`,
        [
          caseId,
          storeId,
          CONNECTION,
          scheduleId,
          absentShift,
          absentStaffId,
          OFFER_START,
          OFFER_END,
        ],
      );
      await tx.query(
        `insert into outreach
           (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
            endpoint_key, endpoint_version, offered_start_at, offered_end_at,
            state, anonymous_staff_ref)
         values ($1, $2, $3, 'mock', $4, $5, 1, $6, $7, 'AWAITING_REPLY', 'staff-1')`,
        [outreachId, caseId, staffId, CONNECTION, endpointKey, OFFER_START, OFFER_END],
      );
      await tx.query(
        `insert into outreach_message (message_id, case_id, outreach_id, direction, kind, body)
         values ($1, $2, $3, 'OUTBOUND', 'INITIAL_OFFER', '打診')`,
        [offerMessageId, caseId, outreachId],
      );
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      await clearCaseData(tx);
      await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  function accepting(ranges: { startAt: string; endAt: string }[]): ModelReplyOutput {
    return replyOutput({ intent: "ACCEPT", ranges, action: "RECORD_COMMITMENT_CANDIDATE" });
  }

  it("提示の範囲に収まる全時間の承諾は Commitment になる", async () => {
    const id = await reply("大丈夫です");
    const interpret = makeInterpret(
      createFakeModelGateway({
        fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]),
      }),
    );
    const result = await interpret({ inboundEventId: id });

    expect(result).toMatchObject({ ok: true, applied: "APPLIED", intent: "ACCEPT" });
    const rows = await commitments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ACTIVE");
    expect(await outreachState()).toBe("ANSWERED");
  });

  it("訂正は旧版を置き換え、上書きしない（RFC-011 §4）", async () => {
    const first = await reply("大丈夫です");
    await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: first });

    const second = await reply("19時からでお願いします");
    await makeInterpret(
      createFakeModelGateway({
        fallback: replyOutput({
          intent: "CORRECTION",
          ranges: [{ startAt: "2026-09-28T19:00:00+09:00", endAt: OFFER_END }],
        }),
      }),
    )({ inboundEventId: second });

    const rows = await commitments();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("SUPERSEDED");
    expect(rows[1]?.status).toBe("ACTIVE");
    expect(rows[1]?.start_at.toISOString()).toBe("2026-09-28T10:00:00.000Z");
  });

  it("A12：遅れて返った古い結果で、新しい承諾を戻さない", async () => {
    const first = await reply("大丈夫です");
    const second = await reply("19時からでお願いします");

    // 新しい返信を先に適用する。
    await makeInterpret(
      createFakeModelGateway({
        fallback: accepting([{ startAt: "2026-09-28T19:00:00+09:00", endAt: OFFER_END }]),
      }),
    )({ inboundEventId: second });

    // 古い返信の解釈が後から返ってくる。
    const late = await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: first });

    expect(late).toMatchObject({ ok: true, applied: "DISCARDED_STALE" });
    const rows = await commitments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.start_at.toISOString()).toBe("2026-09-28T10:00:00.000Z");

    // 捨てずに保存はしている（なぜ採用しなかったかを説明できるように）。
    const saved = await withTransaction((tx) =>
      tx.query<{ applied: string }>(
        "select applied from reply_interpretation where case_id = $1 order by received_seq",
        [caseId],
      ),
    );
    expect(saved.rows.map((r) => r.applied)).toEqual(["DISCARDED_STALE", "APPLIED"]);
  });

  it("Q03：分断した可能時間は範囲外として明示的に拒否する（追加確認へ畳まない）", async () => {
    const id = await reply("18時と21時なら空いてます");
    const result = await makeInterpret(
      createFakeModelGateway({
        fallback: accepting([
          { startAt: OFFER_START, endAt: "2026-09-28T19:00:00+09:00" },
          { startAt: "2026-09-28T21:00:00+09:00", endAt: OFFER_END },
        ]),
      }),
    )({ inboundEventId: id });

    expect(result).toMatchObject({ ok: true, applied: "REJECTED_BY_CHECK" });
    expect(await commitments()).toHaveLength(0);
    // 聞き直しても結果が変わらないので追加確認を送らない。
    expect(await outreachState()).toBe("ANSWERED");
    const outbox = await withTransaction((tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from notification_outbox where case_id = $1",
        [caseId],
      ),
    );
    expect(outbox.rows[0]?.n).toBe(0);
    const events = await withTransaction((tx) =>
      tx.query<{ kind: string }>("select kind from case_processing_event where case_id = $1", [
        caseId,
      ]),
    );
    expect(events.rows.map((r) => r.kind)).toContain("REPLY_OUT_OF_SCOPE");
  });

  it("期限を過ぎた返信に、過ぎた期限を書いた追加確認を送り返さない（RFC-011 §4）", async () => {
    await withTransaction((tx) =>
      tx.query(
        "update absence_case set deadline_at = '2026-09-28T08:00:00+09:00' where case_id = $1",
        [caseId],
      ),
    );
    const id = await reply("大丈夫です");
    const result = await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: id });

    expect(result).toMatchObject({ applied: "REJECTED_BY_CHECK" });
    expect(await commitments()).toHaveLength(0);
    const outbox = await withTransaction((tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from notification_outbox where case_id = $1",
        [caseId],
      ),
    );
    expect(outbox.rows[0]?.n).toBe(0);
  });

  it("案件版が動いていたら、受信順を進めずに破棄する（未処理のまま残す）", async () => {
    const id = await reply("大丈夫です");
    const interpret = interpretWithHook(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
      async () => {
        // モデル応答の後、適用の直前に案件版が進む（停止・状態遷移・正式採用で起きる）。
        await withTransaction((tx) =>
          tx.query("update absence_case set version = version + 1 where case_id = $1", [caseId]),
        );
      },
    );
    const result = await interpret({ inboundEventId: id });

    expect(result).toMatchObject({ applied: "DISCARDED_STALE" });
    expect(await commitments()).toHaveLength(0);
    // 適用していないので「未処理の返信あり」のまま残す。ここを進めると、撤回や
    // 訂正が無かったことになる（D04 / A05）。
    const applied = await withTransaction((tx) =>
      tx.query<{ last_applied_seq: string }>(
        "select last_applied_seq from outreach where outreach_id = $1",
        [outreachId],
      ),
    );
    expect(Number(applied.rows[0]?.last_applied_seq)).toBe(0);
  });

  it("終了した打診への返信は記録するが、承諾も遷移も作らず前へ進む", async () => {
    const first = await reply("今回は難しいです");
    await makeInterpret(createFakeModelGateway({ fallback: replyOutput({ intent: "DECLINE" }) }))({
      inboundEventId: first,
    });
    expect(await outreachState()).toBe("CLOSED");

    const second = await reply("やっぱり行けます");
    const result = await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: second });

    expect(result).toMatchObject({ ok: true, applied: "REJECTED_BY_CHECK" });
    expect(await commitments()).toHaveLength(0);
    expect(await outreachState()).toBe("CLOSED");
    // 受信順は進める。進めないと同じ受信を毎回選び直して前へ進めない。
    const applied = await withTransaction((tx) =>
      tx.query<{ last_applied_seq: string }>(
        "select last_applied_seq from outreach where outreach_id = $1",
        [outreachId],
      ),
    );
    expect(Number(applied.rows[0]?.last_applied_seq)).toBe(2);
  });

  it("保留になった承諾にも撤回が届く（ACTIVE だけを見ない）", async () => {
    const first = await reply("大丈夫です");
    await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: first });

    const second = await reply("やっぱり少し遅れるかも");
    await makeInterpret(createFakeModelGateway({ fallback: replyOutput({ intent: "UNCLEAR" }) }))({
      inboundEventId: second,
    });
    expect((await commitments())[0]?.status).toBe("HELD");

    const third = await reply("取り消します");
    await makeInterpret(createFakeModelGateway({ fallback: replyOutput({ intent: "WITHDRAW" }) }))({
      inboundEventId: third,
    });

    const rows = await commitments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("WITHDRAWN");
  });

  it("提示の範囲外・15分刻みでない・長すぎる時間は承諾にしない", async () => {
    const cases: [string, { startAt: string; endAt: string }][] = [
      ["範囲外", { startAt: "2026-09-28T16:00:00+09:00", endAt: OFFER_END }],
      ["刻み", { startAt: "2026-09-28T18:05:00+09:00", endAt: OFFER_END }],
    ];
    for (const [label, range] of cases) {
      const id = await reply(`${label}の返信`);
      const result = await makeInterpret(createFakeModelGateway({ fallback: accepting([range]) }))({
        inboundEventId: id,
      });
      expect(result, label).toMatchObject({ applied: "REJECTED_BY_CHECK" });
    }
    expect(await commitments()).toHaveLength(0);
  });

  it("未解決の条件が残る返信は承諾にしない（自己申告を同意の証拠にしない）", async () => {
    const id = await reply("たぶん行けます");
    const result = await makeInterpret(
      createFakeModelGateway({
        fallback: replyOutput({
          intent: "CONDITIONAL",
          ranges: [{ startAt: OFFER_START, endAt: OFFER_END }],
          unresolved: ["終了時刻が未確定"],
        }),
      }),
    )({ inboundEventId: id });

    expect(result).toMatchObject({ applied: "REJECTED_BY_CHECK" });
    expect(await outreachState()).toBe("CLARIFYING");
  });

  it("曖昧な返信には追加確認を積む（Q09：返信を無視しない）", async () => {
    const id = await reply("うーん");
    await makeInterpret(createFakeModelGateway({ fallback: replyOutput({ intent: "UNCLEAR" }) }))({
      inboundEventId: id,
    });

    const outbox = await withTransaction((tx) =>
      tx.query<{ kind: string; status: string }>(
        "select kind, status from notification_outbox where case_id = $1",
        [caseId],
      ),
    );
    expect(outbox.rows).toEqual([{ kind: "CLARIFICATION", status: "PENDING" }]);
  });

  it("曖昧な訂正は旧承諾を保留にする（選定へ出さない：D04 / A05の前提）", async () => {
    const first = await reply("大丈夫です");
    await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: first });

    const second = await reply("やっぱり少し遅れるかも");
    await makeInterpret(createFakeModelGateway({ fallback: replyOutput({ intent: "UNCLEAR" }) }))({
      inboundEventId: second,
    });

    const rows = await commitments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("HELD");
    expect(await outreachState()).toBe("CLARIFYING");
  });

  it("辞退は承諾を作らず、この相手との対話を終える", async () => {
    const id = await reply("今回は難しいです");
    const result = await makeInterpret(
      createFakeModelGateway({ fallback: replyOutput({ intent: "DECLINE" }) }),
    )({ inboundEventId: id });

    expect(result).toMatchObject({ intent: "DECLINE" });
    expect(await commitments()).toHaveLength(0);
    expect(await outreachState()).toBe("CLOSED");
  });

  it("撤回は承諾を撤回済みにする", async () => {
    const first = await reply("大丈夫です");
    await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: first });

    const second = await reply("取り消します");
    await makeInterpret(createFakeModelGateway({ fallback: replyOutput({ intent: "WITHDRAW" }) }))({
      inboundEventId: second,
    });

    const rows = await commitments();
    expect(rows[0]?.status).toBe("WITHDRAWN");
  });

  it("A13の一部：確定後の返信は承諾を動かさず、変更申告として記録する", async () => {
    // 「採用済み」は fixture で直接作っている。正式採用の経路は未実装なので、
    // A13 の前半（確定通知失敗からの復旧）は検証していない。
    await withTransaction((tx) =>
      tx.query("update absence_case set adoption_fact = 'ADOPTED' where case_id = $1", [caseId]),
    );
    const id = await reply("やっぱり行けません");
    const result = await makeInterpret(
      createFakeModelGateway({ fallback: replyOutput({ intent: "WITHDRAW" }) }),
    )({ inboundEventId: id });

    expect(result).toMatchObject({ ok: true });
    expect(await commitments()).toHaveLength(0);
    const events = await withTransaction((tx) =>
      tx.query<{ kind: string }>(
        "select kind from case_processing_event where case_id = $1 order by created_at",
        [caseId],
      ),
    );
    expect(events.rows.map((r) => r.kind)).toContain("CHANGE_REQUEST_AFTER_COMMIT");
  });

  it("モデルが未設定なら承諾を作らず、事実だけを記録する（模擬結果を返さない）", async () => {
    const id = await reply("大丈夫です");
    const gateway = createFakeModelGateway({
      configured: false,
      fallback: new TaskcalError("NOT_CONFIGURED", "実推論を行いません"),
    });
    const result = await makeInterpret(gateway)({ inboundEventId: id });

    expect(result).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    expect(await commitments()).toHaveLength(0);
    expect(await outreachState()).toBe("ANSWERED");

    const events = await withTransaction((tx) =>
      tx.query<{ kind: string }>("select kind from case_processing_event where case_id = $1", [
        caseId,
      ]),
    );
    expect(events.rows.map((r) => r.kind)).toContain("INTERPRETATION_UNAVAILABLE");
  });

  it("15分の位置に乗らない時刻を承諾にしない（長さだけを見ない）", async () => {
    const id = await reply("18時7分から19時7分で");
    const result = await makeInterpret(
      createFakeModelGateway({
        // 長さは60分で15分で割り切れるが、開始も終了も15分の位置ではない。
        fallback: accepting([
          { startAt: "2026-09-28T18:07:00+09:00", endAt: "2026-09-28T19:07:00+09:00" },
        ]),
      }),
    )({ inboundEventId: id });

    expect(result).toMatchObject({ applied: "REJECTED_BY_CHECK" });
    expect(await commitments()).toHaveLength(0);
  });

  it("古い結果を棄却した後に同じ返信を再処理しても、承諾を作れる", async () => {
    const id = await reply("大丈夫です");
    // 1回目：適用の直前に案件版が動き、DISCARDED_STALE で保存される。
    await interpretWithHook(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
      async () => {
        await withTransaction((tx) =>
          tx.query("update absence_case set version = version + 1 where case_id = $1", [caseId]),
        );
      },
    )({ inboundEventId: id });
    expect(await commitments()).toHaveLength(0);

    // 2回目：requestId が同じなので解釈行は既にある。今回作ったIDで承諾を作ると
    // 存在しない解釈を指して外部キー違反になる。
    const again = await makeInterpret(
      createFakeModelGateway({ fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]) }),
    )({ inboundEventId: id });

    expect(again).toMatchObject({ ok: true, applied: "APPLIED" });
    const rows = await commitments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ACTIVE");

    // 解釈の行は増えず、適用結果だけが更新されている。
    const saved = await withTransaction((tx) =>
      tx.query<{ applied: string }>("select applied from reply_interpretation where case_id = $1", [
        caseId,
      ]),
    );
    expect(saved.rows.map((r) => r.applied)).toEqual(["APPLIED"]);
  });

  it("同じ受信の再試行は同じ requestId を使う（再送で作り直さない）", async () => {
    const id = await reply("大丈夫です");
    const gateway = createFakeModelGateway({
      fallback: accepting([{ startAt: OFFER_START, endAt: OFFER_END }]),
    });
    const interpret = makeInterpret(gateway);
    await interpret({ inboundEventId: id });
    await interpret({ inboundEventId: id });

    expect(gateway.calls[0]).toBe(gateway.calls[1]);
    expect(gateway.calls[0]).toContain(":INTERPRET_REPLY:1");
    // 二度目は受信順が進まないので適用しない。承諾は増えない。
    expect(await commitments()).toHaveLength(1);
  });
});
