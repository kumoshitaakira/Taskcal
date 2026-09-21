/**
 * 未処理の返信の取り出し（workerの1ステップ）。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、解釈に失敗した受信が後続の返信を止めないこと、モデルが未設定でも
 * 保存済み結果の再生を妨げないこと。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TaskcalError } from "@/contracts/errors";
import type { InboundEvent } from "@/contracts/messaging-gateway";
import { createFakeModelGateway, replyOutput } from "../fakes/model-gateway";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、取り出しを確認していません。\n\n",
  );
}

const CONNECTION = "mock:pending";
const OFFER_START = "2026-09-29T18:00:00+09:00";
const OFFER_END = "2026-09-29T22:00:00+09:00";

describe.skipIf(!connectionString)("未処理の返信の取り出し（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let receive: ReturnType<typeof import("@/application/receive-inbound-event").receiveInboundEvent>;
  let makePending: (
    gateway: ReturnType<typeof createFakeModelGateway>,
  ) => ReturnType<typeof import("@/application/interpret-pending").interpretPending>;

  const storeId = randomUUID();
  const absentStaffId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const staff = [randomUUID(), randomUUID()];
  const endpointKeys = staff.map((id) => `staff:${id}`);
  let caseId: string;
  const outreachIds: string[] = [];
  const messageIds: string[] = [];

  function event(index: number, body: string): InboundEvent {
    const at = new Date().toISOString();
    return {
      provider: "mock",
      connectionId: CONNECTION,
      eventId: `evt-${randomUUID()}`,
      occurredAt: at,
      receivedAt: at,
      from: {
        provider: "mock",
        connectionId: CONNECTION,
        endpointKey: endpointKeys[index],
        endpointVersion: 1,
      },
      inReplyToMessageId: messageIds[index],
      body,
      channelVerified: false,
    };
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    const { receiveInboundEvent } = await import("@/application/receive-inbound-event");
    const { interpretPending } = await import("@/application/interpret-pending");
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
    makePending = (model) =>
      interpretPending({
        model,
        inbound,
        interpret: interpretReply({
          model,
          cases: createPgAbsenceCaseRepository(),
          outreaches,
          inbound,
          interpretations: createPgReplyInterpretationRepository(),
          commitments: createPgCommitmentRepository(),
          outbox: createPgOutboxRepository(),
          clock: { now: () => "2026-09-29T09:00:00+09:00" },
          ids: { next: () => randomUUID() },
        }),
      });

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '取り出しテスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const id of [...staff, absentStaffId]) {
        await tx.query(
          `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
           values ($1, $2, '架空', 'FLOOR', 9600)`,
          [id, storeId],
        );
      }
      await tx.query(
        `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, '2026-09-29')`,
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
    outreachIds.length = 0;
    messageIds.length = 0;
    await withTransaction(async (tx) => {
      for (const table of ["commitment", "reply_interpretation"]) {
        await tx.query(
          `delete from ${table} where case_id in
             (select case_id from absence_case where store_id = $1)`,
          [storeId],
        );
      }
      await tx.query("delete from inbound_event where connection_id = $1", [CONNECTION]);
      for (const table of [
        "notification_outbox",
        "outreach_message",
        "outreach",
        "case_processing_event",
      ]) {
        await tx.query(
          `delete from ${table} where case_id in
             (select case_id from absence_case where store_id = $1)`,
          [storeId],
        );
      }
      await tx.query("delete from absence_case where store_id = $1", [storeId]);

      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, '2026-09-29', $5, $6, 'FLOOR', $7, $8,
                 '2026-09-29T16:00:00+09:00', 'COORDINATING', 'run-pending')`,
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
      for (const [index, staffId] of staff.entries()) {
        const outreachId = randomUUID();
        const messageId = randomUUID();
        outreachIds.push(outreachId);
        messageIds.push(messageId);
        await tx.query(
          `insert into outreach
             (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
              endpoint_key, endpoint_version, offered_start_at, offered_end_at,
              state, anonymous_staff_ref)
           values ($1, $2, $3, 'mock', $4, $5, 1, $6, $7, 'AWAITING_REPLY', $8)`,
          [
            outreachId,
            caseId,
            staffId,
            CONNECTION,
            endpointKeys[index],
            OFFER_START,
            OFFER_END,
            `staff-${index + 1}`,
          ],
        );
        await tx.query(
          `insert into outreach_message (message_id, case_id, outreach_id, direction, kind, body)
           values ($1, $2, $3, 'OUTBOUND', 'INITIAL_OFFER', '打診')`,
          [messageId, caseId, outreachId],
        );
      }
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      for (const table of ["commitment", "reply_interpretation"]) {
        await tx.query(
          `delete from ${table} where case_id in
             (select case_id from absence_case where store_id = $1)`,
          [storeId],
        );
      }
      await tx.query("delete from inbound_event where connection_id = $1", [CONNECTION]);
      for (const table of [
        "notification_outbox",
        "outreach_message",
        "outreach",
        "case_processing_event",
      ]) {
        await tx.query(
          `delete from ${table} where case_id in
             (select case_id from absence_case where store_id = $1)`,
          [storeId],
        );
      }
      await tx.query("delete from absence_case where store_id = $1", [storeId]);
      await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  const accepting = () =>
    replyOutput({
      intent: "ACCEPT",
      ranges: [{ startAt: OFFER_START, endAt: OFFER_END }],
      action: "RECORD_COMMITMENT_CANDIDATE",
    });

  it("解釈に失敗した受信が、後続のスタッフの返信を止めない", async () => {
    // 1人目の返信は解釈できない（未設定）。2人目は承諾になるはず。
    await receive(event(0, "大丈夫です"));
    await receive(event(1, "大丈夫です"));

    const unavailable = createFakeModelGateway({
      configured: false,
      fallback: new TaskcalError("NOT_CONFIGURED", "実推論を行いません"),
    });
    const blockedRun = makePending(unavailable);

    const first = await blockedRun();
    expect(first).toMatchObject({ handled: true, blocked: "NOT_CONFIGURED" });

    // 同じ受信を選び直さず、次の受信へ進む。
    const second = await blockedRun();
    expect(second).toMatchObject({ handled: true, blocked: "NOT_CONFIGURED" });
    expect((second as { inboundEventId: string }).inboundEventId).not.toBe(
      (first as { inboundEventId: string }).inboundEventId,
    );

    // 全部保留になれば、取り出すものは無い。worker が空回りしない。
    expect(await blockedRun()).toEqual({ handled: false, reason: "NONE" });
  });

  it("設定が戻ったら、設定が理由の保留だけを取り出し直す", async () => {
    await receive(event(0, "大丈夫です"));
    const blockedRun = makePending(
      createFakeModelGateway({
        configured: false,
        fallback: new TaskcalError("NOT_CONFIGURED", "実推論を行いません"),
      }),
    );
    expect(await blockedRun()).toMatchObject({ blocked: "NOT_CONFIGURED" });

    const configuredRun = makePending(createFakeModelGateway({ fallback: accepting() }));
    const result = await configuredRun();
    expect(result).toMatchObject({ handled: true, applied: "APPLIED" });

    const commitments = await withTransaction((tx) =>
      tx.query<{ n: number }>("select count(*)::int as n from commitment where case_id = $1", [
        caseId,
      ]),
    );
    expect(commitments.rows[0]?.n).toBe(1);
  });

  it("Gatewayの例外も保留にする（後続の返信を止めない）", async () => {
    // タイムアウト（結果不明）と契約違反の出力は例外で返る。素通りすると保留が
    // 付かず、同じ受信を選び続けて2人目の返信が処理できない。
    const { UnknownOutcomeError, InvalidModelOutputError } =
      await import("@/adapters/orca/orca-client");
    const usage = {
      requestId: "r",
      caseId,
      runId: "run-pending",
      step: "INTERPRET_REPLY",
      outcome: "UNKNOWN",
      modelMeasurement: "UNKNOWN",
      routingSource: "UNKNOWN",
      promptVersion: "p",
      rulesVersion: "r",
      tokenMeasurement: "UNKNOWN",
      costKind: "UNKNOWN_CHARGE",
      validationResult: "NOT_EVALUATED",
      startedAt: "2026-09-29T00:00:00.000Z",
      finishedAt: "2026-09-29T00:00:01.000Z",
    } as const;

    await receive(event(0, "大丈夫です"));
    await receive(event(1, "大丈夫です"));

    const unknown = makePending(
      createFakeModelGateway({ fallback: new UnknownOutcomeError(usage, "応答が無い") }),
    );
    const first = await unknown();
    // 結果不明は確定失敗にしない。意味を保ったまま保留にする。
    expect(first).toMatchObject({ handled: true, blocked: "RECONCILE_REQUIRED" });

    const invalid = makePending(
      createFakeModelGateway({ fallback: new InvalidModelOutputError(usage, "契約に合わない") }),
    );
    const second = await invalid();
    expect(second).toMatchObject({ handled: true, blocked: "INVALID_INPUT" });
    expect((second as { inboundEventId: string }).inboundEventId).not.toBe(
      (first as { inboundEventId: string }).inboundEventId,
    );

    expect(await invalid()).toEqual({ handled: false, reason: "NONE" });
  });

  it("想定していない例外も、確定失敗と断定せず保留にする", async () => {
    await receive(event(0, "大丈夫です"));
    const broken = makePending(createFakeModelGateway({ fallback: new Error("想定外") }));
    expect(await broken()).toMatchObject({ handled: true, blocked: "RECONCILE_REQUIRED" });
    expect(await broken()).toEqual({ handled: false, reason: "NONE" });
  });

  it("予算超過の保留は、設定が戻っても自動では戻さない（止めた理由が別）", async () => {
    await receive(event(0, "大丈夫です"));
    const exceeded = makePending(
      createFakeModelGateway({ fallback: new TaskcalError("BUDGET_EXCEEDED", "上限に達しました") }),
    );
    expect(await exceeded()).toMatchObject({ blocked: "BUDGET_EXCEEDED" });

    const configuredRun = makePending(createFakeModelGateway({ fallback: accepting() }));
    expect(await configuredRun()).toEqual({ handled: false, reason: "NONE" });
  });

  it("モデルが未設定でも、保存済み結果があれば適用できる（再生を止めない）", async () => {
    await receive(event(0, "大丈夫です"));
    // isConfigured() は false だが、gateway は結果を返す（保存済み結果の再生に相当）。
    const replaying = makePending(
      createFakeModelGateway({ configured: false, fallback: accepting() }),
    );
    const result = await replaying();
    expect(result).toMatchObject({ handled: true, applied: "APPLIED" });
  });

  it("空本文の受信は取り出さない（解釈できないものを選び続けない）", async () => {
    await receive({ ...event(0, ""), body: "" });
    const run = makePending(createFakeModelGateway({ fallback: accepting() }));
    expect(await run()).toEqual({ handled: false, reason: "NONE" });
  });
});
