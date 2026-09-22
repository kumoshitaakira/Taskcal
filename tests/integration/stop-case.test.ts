/**
 * 案件の停止（RFC-012 §5 A18、RFC-009 D10、ADR-022 / Q13）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、停止の結果が**DBの中でどう確定したか**。
 *   - 店長停止は `CANCELLED`、期限・上限は `HANDED_OFF`（理由と時刻つき）
 *   - 打診と承諾が失効し、届いたと確認できた相手にだけ募集終了が積まれること（Q07）
 *   - 準備中は、未決の更新があるあいだ**行き先を決めない**こと（Q13）
 *   - 停止後に新規の打診も正式採用も起きないこと（D10）
 *   - 確定済みの勤務を消さないこと（D10 / D09）
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STOP_CAUSE } from "@/contracts/case-state";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write("\n[integration] DATABASE_URL が未設定のため、停止を確認していません。\n\n");
}

const CONNECTION = "mock:stop";
const REVISION = "seed:2026-09:stop";
const NOW = "2026-09-26T09:00:00+09:00";
const DEADLINE = "2026-09-26T16:00:00+09:00";
const PAST_DEADLINE = "2026-09-26T08:00:00+09:00";
const SHIFT_START = "2026-09-26T18:00:00+09:00";
const SHIFT_END = "2026-09-26T22:00:00+09:00";
const BUSINESS_DATE = "2026-09-26";

describe.skipIf(!connectionString)("案件の停止（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let stopCase: typeof import("@/application/stop-case").stopCase;
  let detectDeadline: typeof import("@/application/detect-deadline").detectDeadline;
  let startOutreach: typeof import("@/application/start-outreach").startOutreach;
  let repos: Record<string, never> & {
    cases: import("@/contracts/repository").AbsenceCaseRepository;
    outreaches: import("@/contracts/repository").OutreachRepository;
    commitments: import("@/contracts/repository").CommitmentRepository;
    outbox: import("@/contracts/repository").OutboxRepository;
    scheduleUpdates: import("@/contracts/repository").ScheduleUpdateRepository;
    operations: import("@/contracts/repository").OperationResultStore;
    stores: import("@/contracts/repository").StoreRepository;
  };

  const storeId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const absentStaff = randomUUID();
  /** 返信して承諾まで進んだ相手。 */
  const answeredStaff = randomUUID();
  /** 打診は届いたが返信が無い相手。募集終了通知（Q07）の宛先になる。 */
  const silentStaff = randomUUID();
  /** 打診がまだ送信待ちの相手。**募集終了を送らない。** */
  const undeliveredStaff = randomUUID();

  let caseId: string;
  let answeredOutreach: string;
  let silentOutreach: string;
  let undeliveredOutreach: string;
  let commitmentId: string;

  function build() {
    return stopCase({
      ...repos,
      clock: { now: () => NOW },
      ids: { next: () => randomUUID() },
    });
  }

  async function query<R extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const { rows } = await withTransaction((tx) => tx.query<R>(text, values));
    return rows;
  }

  async function caseRow() {
    const rows = await query<{
      state: string;
      adoption_fact: string;
      stop_cause: string | null;
      stopped_at: string | null;
      handoff_reason: string | null;
      handed_off_at: string | null;
      version: number;
    }>(
      `select state, adoption_fact, stop_cause, stopped_at, handoff_reason, handed_off_at, version
         from absence_case where case_id = $1`,
      [caseId],
    );
    return rows[0];
  }

  async function outreachStates(): Promise<Record<string, string>> {
    const rows = await query<{ outreach_id: string; state: string }>(
      "select outreach_id, state from outreach where case_id = $1",
      [caseId],
    );
    return Object.fromEntries(rows.map((r) => [r.outreach_id, r.state]));
  }

  async function outboxRows(): Promise<{ kind: string; outreach_id: string; status: string }[]> {
    return query("select kind, outreach_id, status from notification_outbox where case_id = $1", [
      caseId,
    ]);
  }

  /** 準備中の案件を作る。`openUpdate` が真なら未決の勤務表更新も置く。 */
  async function toPreparing(options: {
    openUpdate: boolean;
    adoptionFact?: "NOT_ADOPTED" | "ADOPTED" | "UNKNOWN";
  }): Promise<void> {
    await withTransaction(async (tx) => {
      await tx.query(
        `update absence_case set state = 'PREPARING', version = version + 1,
            adoption_fact = $2 where case_id = $1`,
        [caseId, options.adoptionFact ?? "NOT_ADOPTED"],
      );
      if (!options.openUpdate) return;
      const selectionId = randomUUID();
      const operationId = `apply:${selectionId}`;
      await tx.query(
        `insert into selection_result
           (selection_id, case_id, case_version, rules_version, outcome, connection_id,
            schedule_id, source_revision, monthly_completeness, decided_at)
         values ($1, $2, 1, 'test/0.0.0', 'FEASIBLE', $3, $4, $5, 'COMPLETE', $6)`,
        [selectionId, caseId, CONNECTION, scheduleId, REVISION, NOW],
      );
      await tx.query(
        `insert into operation_result
           (operation_id, request_hash, operation_kind, connection_id, case_id, status)
         values ($1, repeat('a', 64), 'APPLY_UPDATE', $2, $3, 'UNKNOWN')`,
        [operationId, CONNECTION, caseId],
      );
      await tx.query(
        `insert into schedule_update
           (schedule_update_id, case_id, selection_id, operation_id, connection_id,
            schedule_id, expected_source_revision, state, case_version)
         values ($1, $2, $3, $4, $5, $6, $7, 'PREPARED', 2)`,
        [randomUUID(), caseId, selectionId, operationId, CONNECTION, scheduleId, REVISION],
      );
    });
  }

  async function cleanup(tx: import("@/adapters/db/transaction").Tx): Promise<void> {
    const cases = "(select case_id from absence_case where connection_id = $1)";
    await tx.query(
      `update authoritative_schedule_ref set adopted_by_schedule_update_id = null
        where connection_id = $1`,
      [CONNECTION],
    );
    await tx.query(`delete from schedule_update where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from selection_result where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from shift_assignment where source_case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from commitment where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from reply_interpretation where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from inbound_event where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from notification_outbox where case_id in ${cases}`, [CONNECTION]);
    await tx.query(
      `delete from message_delivery where message_id in
         (select message_id from outreach_message where case_id in ${cases})`,
      [CONNECTION],
    );
    await tx.query(
      `delete from mock_inbox_item where message_id in
         (select message_id from outreach_message where case_id in ${cases})`,
      [CONNECTION],
    );
    await tx.query(`delete from outreach_message where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from outreach where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from case_processing_event where case_id in ${cases}`, [CONNECTION]);
    await tx.query("delete from authoritative_schedule_ref where connection_id = $1", [CONNECTION]);
    await tx.query("delete from absence_case where connection_id = $1", [CONNECTION]);
    await tx.query(
      `delete from operation_result where connection_id = $1 or operation_id like 'stop:%'`,
      [CONNECTION],
    );
    await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    ({ stopCase } = await import("@/application/stop-case"));
    ({ detectDeadline } = await import("@/application/detect-deadline"));
    ({ startOutreach } = await import("@/application/start-outreach"));

    repos = {
      cases: (await import("@/adapters/db/case-repository")).createPgAbsenceCaseRepository(),
      outreaches: (await import("@/adapters/db/outreach-repository")).createPgOutreachRepository(),
      commitments: (
        await import("@/adapters/db/commitment-repository")
      ).createPgCommitmentRepository(),
      outbox: (await import("@/adapters/db/outbox-repository")).createPgOutboxRepository(),
      scheduleUpdates: (
        await import("@/adapters/db/schedule-update-repository")
      ).createPgScheduleUpdateRepository(),
      operations: (
        await import("@/adapters/db/operation-result-store")
      ).createPgOperationResultStore(),
      stores: (await import("@/adapters/db/store-repository")).createPgStoreRepository(),
    } as typeof repos;

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '停止テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const [i, id] of [absentStaff, answeredStaff, silentStaff, undeliveredStaff].entries()) {
        await tx.query(
          `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
           values ($1, $2, $3, 'FLOOR', 9600)`,
          [id, storeId, `架空 ${i + 1}`],
        );
        await tx.query(
          `insert into contact_endpoint (provider, connection_id, endpoint_key, staff_id)
           values ('mock', $2, $1, $3)`,
          [`staff:${id}`, CONNECTION, id],
        );
      }
      await tx.query(
        `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, $3)`,
        [scheduleId, storeId, BUSINESS_DATE],
      );
    });
  });

  beforeEach(async () => {
    caseId = randomUUID();
    answeredOutreach = randomUUID();
    silentOutreach = randomUUID();
    undeliveredOutreach = randomUUID();
    commitmentId = randomUUID();

    await withTransaction(async (tx) => {
      await cleanup(tx);
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR', $5, $6, 'SCHEDULED')`,
        [absentShift, scheduleId, storeId, absentStaff, SHIFT_START, SHIFT_END],
      );
      await tx.query(
        `insert into authoritative_schedule_ref
           (connection_id, schedule_id, source_revision, artifact_ref, adopted_at, version)
         values ($1, $2, $3, 'var/test/base.csv', $4, 1)`,
        [CONNECTION, scheduleId, REVISION, NOW],
      );
      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'FLOOR', $8, $9, $10, 'COORDINATING', 'run-stop')`,
        [
          caseId,
          storeId,
          CONNECTION,
          scheduleId,
          BUSINESS_DATE,
          absentShift,
          absentStaff,
          SHIFT_START,
          SHIFT_END,
          DEADLINE,
        ],
      );

      const rows: [string, string, string][] = [
        [answeredOutreach, answeredStaff, "ANSWERED"],
        [silentOutreach, silentStaff, "AWAITING_REPLY"],
        [undeliveredOutreach, undeliveredStaff, "PENDING_SEND"],
      ];
      for (const [i, [outreachId, staffId, state]] of rows.entries()) {
        await tx.query(
          `insert into outreach
             (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
              endpoint_key, endpoint_version, offered_start_at, offered_end_at,
              state, last_applied_seq, anonymous_staff_ref)
           values ($1, $2, $3, 'mock', $4, $5, 1, $6, $7, $8, 0, $9)`,
          [
            outreachId,
            caseId,
            staffId,
            CONNECTION,
            `staff:${staffId}`,
            SHIFT_START,
            SHIFT_END,
            state,
            `staff-${i + 1}`,
          ],
        );
      }

      // 送信待ちのまま残った初回打診。停止後に送られてはいけない（D10）。
      await tx.query(
        `insert into notification_outbox
           (outbox_id, case_id, outreach_id, kind, body, operation_id, request_hash, connection_id)
         values ($1, $2, $3, 'INITIAL_OFFER', '打診', $4, repeat('b', 64), $5)`,
        [
          randomUUID(),
          caseId,
          undeliveredOutreach,
          `send:${undeliveredOutreach}:INITIAL_OFFER`,
          CONNECTION,
        ],
      );

      const messageId = randomUUID();
      const inboundId = randomUUID();
      const interpretationId = randomUUID();
      await tx.query(
        `insert into outreach_message (message_id, case_id, outreach_id, direction, kind, body)
         values ($1, $2, $3, 'OUTBOUND', 'INITIAL_OFFER', '打診')`,
        [messageId, caseId, answeredOutreach],
      );
      await tx.query(
        `insert into inbound_event
           (inbound_event_id, case_id, outreach_id, received_seq, provider, connection_id,
            provider_event_id, occurred_at, received_at, from_provider, from_connection_id,
            from_endpoint_key, from_endpoint_version, body, channel_verified,
            sender_identity, message_id)
         values ($1, $2, $3, 1, 'mock', $4, $5, $6, $6, 'mock', $4, $7, 1, '大丈夫です',
                 true, 'VERIFIED_OUTREACH_TARGET', $8)`,
        [
          inboundId,
          caseId,
          answeredOutreach,
          CONNECTION,
          `evt-${caseId}`,
          NOW,
          `staff:${answeredStaff}`,
          messageId,
        ],
      );
      await tx.query(
        `insert into reply_interpretation
           (interpretation_id, case_id, message_id, inbound_event_id, received_seq,
            case_version, request_id, output, masked_reply_text, applied)
         values ($1, $2, $3, $4, 1, 1, $5, '{}'::jsonb, '大丈夫です', 'APPLIED')`,
        [interpretationId, caseId, messageId, inboundId, `req-${inboundId}`],
      );
      await tx.query(
        `insert into commitment
           (commitment_id, case_id, staff_id, outreach_id, version,
            accepted_interpretation_id, role_code, start_at, end_at, status,
            source_received_seq)
         values ($1, $2, $3, $4, 1, $5, 'FLOOR', $6, $7, 'ACTIVE', 1)`,
        [
          commitmentId,
          caseId,
          answeredStaff,
          answeredOutreach,
          interpretationId,
          SHIFT_START,
          SHIFT_END,
        ],
      );
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      await cleanup(tx);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from contact_endpoint where connection_id = $1", [CONNECTION]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  it("A18：店長が停止すると、案件はCANCELLEDになり、打診と承諾が失効する", async () => {
    const result = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });

    expect(result).toMatchObject({ ok: true, to: "CANCELLED" });
    const row = await caseRow();
    expect(row.state).toBe("CANCELLED");
    expect(row.stop_cause).toBe("MANAGER_STOP");
    expect(row.stopped_at).not.toBeNull();
    // 店長停止は引き継ぎではない。引き継ぎ理由を付けない。
    expect(row.handoff_reason).toBeNull();
    // 採用事実は動かさない。停止＝未採用の断定ではない。
    expect(row.adoption_fact).toBe("NOT_ADOPTED");

    const states = await outreachStates();
    expect(states[answeredOutreach]).toBe("EXPIRED");
    expect(states[silentOutreach]).toBe("EXPIRED");
    expect(states[undeliveredOutreach]).toBe("EXPIRED");

    const commitments = await query<{ status: string }>(
      "select status from commitment where commitment_id = $1",
      [commitmentId],
    );
    expect(commitments[0].status).toBe("EXPIRED");
  });

  it("A18／Q07：募集終了は、届いたと確認できた相手にだけ積む", async () => {
    const result = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });
    expect(result).toMatchObject({ ok: true, notified: 2 });

    const closed = (await outboxRows()).filter((r) => r.kind === "CASE_CLOSED");
    expect(closed.map((r) => r.outreach_id).sort()).toEqual(
      [answeredOutreach, silentOutreach].sort(),
    );
    // 送信待ちのままの相手へは送らない。理由を記録する。
    const skipped = await query<{ detail: { reason: string; outreachId: string } }>(
      "select detail from case_processing_event where case_id = $1 and kind = 'CASE_CLOSED_SKIPPED'",
      [caseId],
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].detail.outreachId).toBe(undeliveredOutreach);
  });

  it("D10：停止後、送信待ちの初回打診は取り出されない。募集終了は取り出される", async () => {
    await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });

    // 取り出しは接続範囲を持たない。他のテストが残した項目が混ざるので自分の案件で絞る。
    const kinds: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const claimed = await withTransaction((tx) =>
        repos.outbox.claimNext(tx, { leaseMs: 60_000 }),
      );
      if (claimed === "NONE") break;
      if (claimed.caseId === caseId) kinds.push(claimed.kind);
    }
    // 停止済みの案件の初回打診は出てこない。募集終了だけが出る。
    expect(kinds).not.toContain("INITIAL_OFFER");
    expect(kinds.filter((k) => k === "CASE_CLOSED")).toHaveLength(2);
    // 送信待ちの初回打診は消えずに残る。送らないだけで、記録は消さない。
    const remaining = (await outboxRows()).filter((r) => r.kind === "INITIAL_OFFER");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe("PENDING");
  });

  it("A18：期限到達はHANDED_OFFで、引き継ぎ理由と時刻を持つ", async () => {
    const result = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.DEADLINE,
    });

    expect(result).toMatchObject({ ok: true, to: "HANDED_OFF" });
    const row = await caseRow();
    expect(row.state).toBe("HANDED_OFF");
    expect(row.stop_cause).toBe("DEADLINE");
    expect(row.handoff_reason).toBe("DEADLINE_REACHED");
    expect(row.handed_off_at).not.toBeNull();
    // 「未確定」ではない。採用事実は別に保つ（ADR-022）。
    expect(row.adoption_fact).toBe("NOT_ADOPTED");
  });

  it("A18：期限を過ぎた案件を、workerの1ステップが止める", async () => {
    await withTransaction((tx) =>
      tx.query("update absence_case set deadline_at = $2 where case_id = $1", [
        caseId,
        PAST_DEADLINE,
      ]),
    );

    // 取り出しは接続範囲を持たない（期限は全案件に効く）。他のテストが残した案件も
    // 拾うので、自分の案件が処理されるまで回す。
    const step = detectDeadline({ stopCase: build(), clock: { now: () => NOW } });
    const handled: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const outcome = await step();
      if (!outcome.handled) break;
      handled.push(outcome.caseId);
      if (outcome.caseId === caseId) break;
    }
    expect(handled).toContain(caseId);
    expect((await caseRow()).state).toBe("HANDED_OFF");

    // 止めた案件は二度と拾わない（`stopped_at is null` で外れる）。
    const after: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const outcome = await step();
      if (!outcome.handled) break;
      after.push(outcome.caseId);
    }
    expect(after).not.toContain(caseId);
  });

  it("A18／Q13：準備中に未決の更新があれば、行き先を決めず停止だけ記録する", async () => {
    await toPreparing({ openUpdate: true });

    const result = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.DEADLINE,
    });

    expect(result).toMatchObject({ ok: true, to: "DEFERRED" });
    const row = await caseRow();
    // **引き継がない。** 並行する正式採用の結果を先に確定させる。
    expect(row.state).toBe("PREPARING");
    expect(row.stop_cause).toBe("DEADLINE");
    expect(row.stopped_at).not.toBeNull();
    expect(row.handoff_reason).toBeNull();
    // 版は進める。並行する採用の直前再検査が変更に気付く（D08）。
    expect(row.version).toBeGreaterThan(1);
  });

  it("A18／Q13：準備中でも未決の更新が無ければ、採用事実どおりの行き先へ進む", async () => {
    await toPreparing({ openUpdate: false, adoptionFact: "ADOPTED" });

    const result = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });

    // すでに採用済み。停止理由によらず確定事実を保持して通常の経路へ進む。
    expect(result).toMatchObject({ ok: true, to: "COMMITTED" });
    const row = await caseRow();
    expect(row.state).toBe("COMMITTED");
    expect(row.adoption_fact).toBe("ADOPTED");
    expect(row.stop_cause).toBe("MANAGER_STOP");
  });

  it("A18／Q13：準備中で成否不明なら、引き継がず照合へ回す", async () => {
    await toPreparing({ openUpdate: false, adoptionFact: "UNKNOWN" });

    const result = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.DEADLINE,
    });

    expect(result).toMatchObject({ ok: true, to: "RECONCILE_REQUIRED" });
    expect((await caseRow()).state).toBe("RECONCILE_REQUIRED");
  });

  it("D10：確定済みの案件は停止できず、勤務も消えない", async () => {
    const additionalShift = randomUUID();
    await withTransaction(async (tx) => {
      await tx.query(
        `update absence_case set state = 'COMMITTED', adoption_fact = 'ADOPTED',
            version = version + 1 where case_id = $1`,
        [caseId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status, source_case_id, source_commitment_id)
         values ($1, $2, $3, $4, 'FLOOR', $5, $6, 'SCHEDULED', $7, $8)`,
        [
          additionalShift,
          scheduleId,
          storeId,
          answeredStaff,
          SHIFT_START,
          SHIFT_END,
          caseId,
          commitmentId,
        ],
      );
    });

    const result = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });

    expect(result.ok).toBe(false);
    const row = await caseRow();
    expect(row.state).toBe("COMMITTED");
    expect(row.stopped_at).toBeNull();
    const shifts = await query<{ shift_assignment_id: string }>(
      "select shift_assignment_id from shift_assignment where source_case_id = $1",
      [caseId],
    );
    expect(shifts).toHaveLength(1);
  });

  it("D10：停止後は新規の打診を開始できない", async () => {
    await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });

    const start = startOutreach({
      cases: repos.cases,
      outreaches: repos.outreaches,
      outbox: repos.outbox,
      operations: repos.operations,
      roster: (await import("@/application/roster-eligibility")).createRosterEligibility(),
      stores: repos.stores,
      clock: { now: () => NOW },
      ids: { next: () => randomUUID() },
    });
    const result = await start({ operationId: `outreach:${caseId}`, caseId });
    expect(result).toMatchObject({ ok: false, code: "CASE_STOPPED" });
  });

  it("A18：二度目の停止は理由を上書きしない", async () => {
    await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.DEADLINE,
    });
    const again = await build()({
      operationId: `stop:${caseId}:${randomUUID()}`,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });

    expect(again).toMatchObject({ ok: false, code: "CASE_STOPPED" });
    expect((await caseRow()).stop_cause).toBe("DEADLINE");
  });

  it("D07：同じ操作IDで理由が違えば拒否し、同じ理由なら保存済み結果を返す", async () => {
    const operationId = `stop:${caseId}:fixed`;
    const first = await build()({ operationId, caseId, cause: STOP_CAUSE.DEADLINE });
    expect(first).toMatchObject({ ok: true, to: "HANDED_OFF", replayed: false });

    const conflicting = await build()({
      operationId,
      caseId,
      cause: STOP_CAUSE.MANAGER_STOP,
    });
    expect(conflicting).toMatchObject({ ok: false, code: "OPERATION_CONFLICT" });

    const replay = await build()({ operationId, caseId, cause: STOP_CAUSE.DEADLINE });
    expect(replay).toMatchObject({ ok: true, to: "HANDED_OFF", replayed: true });
  });
});
