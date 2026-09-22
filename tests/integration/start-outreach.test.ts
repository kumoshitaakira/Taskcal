/**
 * 同時個別打診の開始と送信（RFC-011 §2、D01、A11）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、一人の送信失敗で案件が閉じないこと、未送信と配送失敗の区別が
 * 打診の状態に正しく反映されること、結果不明を再送しないこと。
 *
 * 勤務表は**本物のCSV管理版ストア**（一時ディレクトリ）から読む。打診先は名簿だけでなく、
 * 担当Bの規則（同日の勤務との重複・月次上限）で絞る。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCsvFixture, type CsvFixture } from "../stubs/csv-fixture";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write("\n[integration] DATABASE_URL が未設定のため、打診を確認していません。\n\n");
}

const CONNECTION = "mock:outreach";

describe.skipIf(!connectionString)("同時個別打診（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let start: ReturnType<typeof import("@/application/start-outreach").startOutreach>;
  let drain: ReturnType<typeof import("@/application/send-outbox").sendOutbox>;
  let buildStart: (
    gateway: import("@/contracts/schedule-gateway").ScheduleGateway,
  ) => ReturnType<typeof import("@/application/start-outreach").startOutreach>;
  let fixture: CsvFixture;
  const extraFixtures: CsvFixture[] = [];

  const storeId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const staff = Array.from({ length: 4 }, () => randomUUID());
  let caseId: string;
  const now = "2026-09-26T09:00:00+09:00";
  const SHIFT_START = "2026-09-26T18:00:00+09:00";
  const SHIFT_END = "2026-09-26T22:00:00+09:00";

  /** 正式版参照を指定の版へ向ける（D11：勤務表は参照から読む）。 */
  async function pointAuthoritativeAt(target: CsvFixture): Promise<void> {
    await withTransaction((tx) =>
      tx.query(
        `insert into authoritative_schedule_ref
           (connection_id, schedule_id, source_revision, artifact_ref, adopted_at, version)
         values ($1, $2, $3, $4, $5, 1)
         on conflict (connection_id, schedule_id)
           do update set source_revision = excluded.source_revision,
                         artifact_ref = excluded.artifact_ref`,
        [CONNECTION, scheduleId, target.sourceRevision, target.artifactRef, now],
      ),
    );
  }

  async function caseEvents(kind: string): Promise<Record<string, unknown>[]> {
    const { rows } = await withTransaction((tx) =>
      tx.query<{ detail: Record<string, unknown> }>(
        "select detail from case_processing_event where case_id = $1 and kind = $2",
        [caseId, kind],
      ),
    );
    return rows.map((r) => r.detail);
  }

  function endpointKeyOf(staffId: string): string {
    return `staff:${staffId}`;
  }

  async function setFaultMode(staffId: string, mode: string): Promise<void> {
    await withTransaction((tx) =>
      tx.query(
        `update contact_endpoint set mock_fault_mode = $2
          where connection_id = $3 and endpoint_key = $1`,
        [endpointKeyOf(staffId), mode, CONNECTION],
      ),
    );
  }

  async function outreachStates(): Promise<Record<string, string>> {
    const { rows } = await withTransaction((tx) =>
      tx.query<{ staff_id: string; state: string }>(
        "select staff_id, state from outreach where case_id = $1",
        [caseId],
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.staff_id, r.state]));
  }

  async function outboxStates(): Promise<Record<string, string>> {
    const { rows } = await withTransaction((tx) =>
      tx.query<{ staff_id: string; status: string }>(
        `select o.staff_id, b.status
           from notification_outbox b join outreach o on o.outreach_id = b.outreach_id
          where b.case_id = $1`,
        [caseId],
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.staff_id, r.status]));
  }

  async function drainAll(limit = 20): Promise<void> {
    for (let i = 0; i < limit; i += 1) {
      const outcome = await drain();
      if (!outcome.handled) return;
    }
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    const { startOutreach } = await import("@/application/start-outreach");
    const { sendOutbox } = await import("@/application/send-outbox");
    const { createRosterEligibility } = await import("@/application/roster-eligibility");
    const { createOutreachEligibility } = await import("@/application/outreach-eligibility");
    const { createPgAbsenceCaseRepository } = await import("@/adapters/db/case-repository");
    const { createPgStoreRepository, createPgStaffRepository } =
      await import("@/adapters/db/store-repository");
    const { createPgOutreachRepository } = await import("@/adapters/db/outreach-repository");
    const { createPgOutboxRepository } = await import("@/adapters/db/outbox-repository");
    const { createPgOperationResultStore } = await import("@/adapters/db/operation-result-store");
    const { createPgAuthoritativeScheduleRefRepository } =
      await import("@/adapters/db/authoritative-ref-repository");
    const { createDefaultMessagingGateway } = await import("@/adapters/channel");

    const operations = createPgOperationResultStore();
    const outreaches = createPgOutreachRepository();
    const outbox = createPgOutboxRepository();

    // 本物のCSV管理版ストア。欠勤対象の元勤務だけを持つ9月の勤務表。
    fixture = await createCsvFixture({
      connectionId: CONNECTION,
      storeId,
      month: "2026-09",
      roleCode: "FLOOR",
      staffIds: staff,
      shifts: [
        {
          shiftAssignmentId: absentShift,
          staffId: staff[0],
          startAt: SHIFT_START,
          endAt: SHIFT_END,
        },
      ],
      scheduleIds: { "2026-09-26": scheduleId },
    });

    buildStart = (gateway) =>
      startOutreach({
        cases: createPgAbsenceCaseRepository(),
        outreaches,
        outbox,
        operations,
        roster: createRosterEligibility(),
        stores: createPgStoreRepository(),
        staff: createPgStaffRepository(),
        authoritative: createPgAuthoritativeScheduleRefRepository(),
        gateway,
        eligibility: createOutreachEligibility(),
        clock: { now: () => now },
        ids: { next: () => randomUUID() },
      });
    start = buildStart(fixture.gateway);
    drain = sendOutbox({
      outbox,
      outreaches,
      messaging: createDefaultMessagingGateway({ operations }),
    });

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '打診テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const [i, id] of staff.entries()) {
        await tx.query(
          `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
           values ($1, $2, $3, 'FLOOR', 9600)`,
          [id, storeId, `架空 ${i + 1}`],
        );
        await tx.query(
          `insert into contact_endpoint (provider, connection_id, endpoint_key, staff_id)
           values ('mock', $2, $1, $3)`,
          [endpointKeyOf(id), CONNECTION, id],
        );
      }
      await tx.query(
        `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, '2026-09-26')`,
        [scheduleId, storeId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR',
                 '2026-09-26T18:00:00+09:00', '2026-09-26T22:00:00+09:00', 'SCHEDULED')`,
        [absentShift, scheduleId, storeId, staff[0]],
      );
    });
  });

  beforeEach(async () => {
    caseId = randomUUID();
    // 正式版参照を基準の版へ戻す。適格性のテストが別の版へ向けるため。
    await pointAuthoritativeAt(fixture);
    await withTransaction(async (tx) => {
      await tx.query(
        `delete from message_delivery where message_id in
           (select message_id from outreach_message where case_id in
              (select case_id from absence_case where store_id = $1))`,
        [storeId],
      );
      await tx.query(
        `delete from mock_inbox_item where message_id in
           (select message_id from outreach_message where case_id in
              (select case_id from absence_case where store_id = $1))`,
        [storeId],
      );
      await tx.query(
        `delete from notification_outbox where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from outreach_message where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from outreach where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from case_processing_event where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query("delete from absence_case where store_id = $1", [storeId]);
      await tx.query("delete from operation_result where connection_id = $1", [CONNECTION]);
      await tx.query(
        `update contact_endpoint set mock_fault_mode = 'NONE', contact_allowed = true
          where connection_id = $1`,
        [CONNECTION],
      );
      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, '2026-09-26', $5, $6, 'FLOOR',
                 '2026-09-26T18:00:00+09:00', '2026-09-26T22:00:00+09:00',
                 '2026-09-26T16:00:00+09:00', 'COORDINATING', 'run-outreach')`,
        [caseId, storeId, CONNECTION, scheduleId, absentShift, staff[0]],
      );
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      await tx.query("delete from operation_result where connection_id = $1", [CONNECTION]);
      await tx.query(
        `delete from message_delivery where message_id in
           (select message_id from outreach_message where case_id in
              (select case_id from absence_case where store_id = $1))`,
        [storeId],
      );
      await tx.query(
        `delete from mock_inbox_item where message_id in
           (select message_id from outreach_message where case_id in
              (select case_id from absence_case where store_id = $1))`,
        [storeId],
      );
      await tx.query(
        `delete from notification_outbox where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from outreach_message where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from outreach where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from case_processing_event where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query("delete from absence_case where store_id = $1", [storeId]);
      await tx.query("delete from authoritative_schedule_ref where connection_id = $1", [
        CONNECTION,
      ]);
      await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from contact_endpoint where connection_id = $1", [CONNECTION]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
    await fixture.cleanup();
    await Promise.all(extraFixtures.map((f) => f.cleanup()));
  });

  it("D01：欠勤者本人を除いた全員へ個別に打診を積む（送信はまだしない）", async () => {
    const result = await start({ operationId: `so-${randomUUID()}`, caseId });
    expect(result).toMatchObject({ ok: true, started: 3, excluded: 0 });

    const states = await outreachStates();
    expect(Object.keys(states)).toHaveLength(3);
    expect(states[staff[0]]).toBeUndefined();
    // 積んだ時点ではまだ送っていない。
    expect(Object.values(states).every((s) => s === "PENDING_SEND")).toBe(true);
  });

  it("送信が受け付けられた打診だけが返信待ちへ進む", async () => {
    await start({ operationId: `so-${randomUUID()}`, caseId });
    await drainAll();

    const states = await outreachStates();
    expect(Object.values(states)).toEqual(["AWAITING_REPLY", "AWAITING_REPLY", "AWAITING_REPLY"]);

    const inbox = await withTransaction((tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from mock_inbox_item where outreach_id in
           (select outreach_id from outreach where case_id = $1)`,
        [caseId],
      ),
    );
    expect(inbox.rows[0]?.n).toBe(3);
  });

  it("A11：一人が配送失敗でも、他の打診は進み案件は閉じない", async () => {
    await setFaultMode(staff[1], "FAILED");
    await start({ operationId: `so-${randomUUID()}`, caseId });
    await drainAll();

    const states = await outreachStates();
    // 届いたと確認できない相手は送信待ちのまま。他は返信待ちへ進む。
    expect(states[staff[1]]).toBe("PENDING_SEND");
    expect(states[staff[2]]).toBe("AWAITING_REPLY");
    expect(states[staff[3]]).toBe("AWAITING_REPLY");
    expect((await outboxStates())[staff[1]]).toBe("FAILED");

    const caseRow = await withTransaction((tx) =>
      tx.query<{ state: string }>("select state from absence_case where case_id = $1", [caseId]),
    );
    expect(caseRow.rows[0]?.state).toBe("COORDINATING");
  });

  it("A15：宛先の版が変わった相手は未送信として記録する（配送失敗と区別する）", async () => {
    await start({ operationId: `so-${randomUUID()}`, caseId });
    await withTransaction((tx) =>
      tx.query(
        `update contact_endpoint set endpoint_version = endpoint_version + 1
          where connection_id = $1 and endpoint_key = $2`,
        [CONNECTION, endpointKeyOf(staff[2])],
      ),
    );
    await drainAll();

    expect((await outboxStates())[staff[2]]).toBe("REFUSED");
    expect((await outreachStates())[staff[2]]).toBe("PENDING_SEND");
    // 未送信なので配送の記録を作らない。
    const delivery = await withTransaction((tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from message_delivery d
           join outreach_message m on m.message_id = d.message_id
          where m.case_id = $1`,
        [caseId],
      ),
    );
    expect(delivery.rows[0]?.n).toBe(2);
    await withTransaction((tx) =>
      tx.query(`update contact_endpoint set endpoint_version = 1 where connection_id = $1`, [
        CONNECTION,
      ]),
    );
  });

  it("結果不明の項目は再送しない（照合するまで取り出さない）", async () => {
    await setFaultMode(staff[1], "UNKNOWN");
    await start({ operationId: `so-${randomUUID()}`, caseId });
    await drainAll();
    expect((await outboxStates())[staff[1]]).toBe("UNKNOWN");

    // もう一度流しても取り出さない。
    await setFaultMode(staff[1], "NONE");
    const again = await drain();
    expect(again.handled).toBe(false);
    expect((await outboxStates())[staff[1]]).toBe("UNKNOWN");
  });

  it("同じ操作IDの再実行で打診を作り直さない", async () => {
    const operationId = `so-${randomUUID()}`;
    const first = await start({ operationId, caseId });
    const second = await start({ operationId, caseId });
    expect(first).toMatchObject({ ok: true, started: 3, replayed: false });
    expect(second).toMatchObject({ ok: true, started: 3, replayed: true });
    expect(Object.keys(await outreachStates())).toHaveLength(3);
  });

  it("別の操作IDでも、すでに打診済みの案件で二重に打診しない", async () => {
    await start({ operationId: `so-${randomUUID()}`, caseId });
    const second = await start({ operationId: `so-${randomUUID()}`, caseId });
    expect(second).toMatchObject({ ok: false, code: "OPERATION_CONFLICT" });
    expect(Object.keys(await outreachStates())).toHaveLength(3);
  });

  it("D10：停止済みの案件では新規の打診を始めない", async () => {
    await withTransaction((tx) =>
      tx.query(
        `update absence_case set stop_cause = 'MANAGER_STOP', stopped_at = now()
          where case_id = $1`,
        [caseId],
      ),
    );
    const result = await start({ operationId: `so-${randomUUID()}`, caseId });
    expect(result).toMatchObject({ ok: false, code: "CASE_STOPPED" });
  });

  it("期限を過ぎた案件では打診を始めない", async () => {
    await withTransaction((tx) =>
      tx.query(
        `update absence_case set deadline_at = '2026-09-26T08:00:00+09:00' where case_id = $1`,
        [caseId],
      ),
    );
    const result = await start({ operationId: `so-${randomUUID()}`, caseId });
    expect(result).toMatchObject({ ok: false, code: "DEADLINE_EXCEEDED" });
  });

  it("打診先の適格性：同日の勤務と重なる相手は名簿に居ても打診せず、理由を記録する", async () => {
    // staff[3] が 19〜21時に別の勤務を持つ版。必要枠 18〜22時と重なる。
    const overlapping = await createCsvFixture({
      connectionId: CONNECTION,
      storeId,
      month: "2026-09",
      roleCode: "FLOOR",
      staffIds: staff,
      shifts: [
        {
          shiftAssignmentId: absentShift,
          staffId: staff[0],
          startAt: SHIFT_START,
          endAt: SHIFT_END,
        },
        {
          shiftAssignmentId: randomUUID(),
          staffId: staff[3],
          startAt: "2026-09-26T19:00:00+09:00",
          endAt: "2026-09-26T21:00:00+09:00",
        },
      ],
      scheduleIds: { "2026-09-26": scheduleId },
    });
    extraFixtures.push(overlapping);
    await pointAuthoritativeAt(overlapping);

    const result = await buildStart(overlapping.gateway)({
      operationId: `so-${randomUUID()}`,
      caseId,
    });
    expect(result).toMatchObject({ ok: true, started: 2, excluded: 1 });

    const states = await outreachStates();
    expect(states[staff[3]]).toBeUndefined();
    expect(states[staff[1]]).toBe("PENDING_SEND");
    expect(states[staff[2]]).toBe("PENDING_SEND");
    // 打診されなかった人が記録から消えない。
    expect(await caseEvents("CANDIDATES_EXCLUDED")).toEqual([
      { excluded: [{ staffId: staff[3], reason: "EXISTING_ASSIGNMENT_OVERLAP" }] },
    ]);
  });

  it("進行中のまま残った同じ操作は、打診が1件も無ければ続きを進める（案件を塞がない）", async () => {
    // 取引Aの後・取引Bの前でプロセスが落ちた状態を作る：操作だけが IN_PROGRESS で残る。
    const operationId = `outreach:${caseId}`;
    const { computeRequestHash } = await import("@/contracts/operation");
    const { createPgOperationResultStore } = await import("@/adapters/db/operation-result-store");
    await withTransaction((tx) =>
      createPgOperationResultStore().begin(tx, {
        operation: { operationId, requestHash: computeRequestHash({ caseId }) },
        kind: "START_OUTREACH",
        caseId,
      }),
    );
    const result = await start({ operationId, caseId });
    expect(result).toMatchObject({ ok: true, started: 3, replayed: false });
    // 打診が積まれた後の同じ操作は再生になる。
    const again = await start({ operationId, caseId });
    expect(again).toMatchObject({ ok: true, started: 3, replayed: true });
  });

  it("A09の入口：月内入力が完全でなければ打診を始めない（欠けた日を0と推定しない）", async () => {
    // 範囲宣言から1日を落とした版。COMPLETE でなくなる。
    const { buildCsvInput } = await import("../stubs/csv-fixture");
    const { importRevision, artifactRefOf } = await import("@/adapters/csv/csv-store");
    const input = buildCsvInput({
      connectionId: CONNECTION,
      storeId,
      month: "2026-09",
      roleCode: "FLOOR",
      staffIds: staff,
      shifts: [
        {
          shiftAssignmentId: absentShift,
          staffId: staff[0],
          startAt: SHIFT_START,
          endAt: SHIFT_END,
        },
      ],
      scheduleIds: { "2026-09-26": scheduleId },
    });
    input.manifest.days = input.manifest.days?.filter((day) => day.date !== "2026-09-30");
    const { parsed } = await importRevision(fixture.root, CONNECTION, input);
    expect(parsed.completeness).toBe("INCOMPLETE");
    await withTransaction((tx) =>
      tx.query(
        `update authoritative_schedule_ref set source_revision = $3, artifact_ref = $4
          where connection_id = $1 and schedule_id = $2`,
        [CONNECTION, scheduleId, parsed.sourceRevision, artifactRefOf(parsed.sourceRevision)],
      ),
    );

    const result = await start({ operationId: `so-${randomUUID()}`, caseId });
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(Object.keys(await outreachStates())).toHaveLength(0);
  });
});
