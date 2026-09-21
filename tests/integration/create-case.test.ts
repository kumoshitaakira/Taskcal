/**
 * 欠勤案件の作成（D01 / D02 / Q04 / Q05）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate && npm run seed:dev
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、欠勤案件の作成を確認していません。\n\n",
  );
}

const CONNECTION = "mock:create-case";

describe.skipIf(!connectionString)("欠勤案件の作成（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let run: ReturnType<typeof import("@/application/create-absence-case").createAbsenceCase>;

  const storeId = randomUUID();
  const staffId = randomUUID();
  const scheduleId = randomUUID();
  const scheduledShift = randomUUID();
  const completedShift = randomUUID();
  const unadoptedScheduleId = randomUUID();
  const unadoptedShift = randomUUID();
  let now = "2026-09-23T09:00:00+09:00";

  function command(overrides: Record<string, unknown> = {}) {
    return {
      operationId: `case-${randomUUID()}`,
      storeId,
      connectionId: CONNECTION,
      absentShiftAssignmentId: scheduledShift,
      deadlineAt: "2026-09-23T16:00:00+09:00",
      runId: "run-create",
      ...overrides,
    };
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    const { createAbsenceCase } = await import("@/application/create-absence-case");
    const { createPgAbsenceCaseRepository } = await import("@/adapters/db/case-repository");
    const { createPgScheduleReadRepository } = await import("@/adapters/db/schedule-repository");
    const { createPgOperationResultStore } = await import("@/adapters/db/operation-result-store");

    run = createAbsenceCase({
      cases: createPgAbsenceCaseRepository(),
      schedules: createPgScheduleReadRepository(),
      operations: createPgOperationResultStore(),
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
    });

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '作成テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      await tx.query(
        `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
         values ($1, $2, '架空 テスト', 'FLOOR', 9600)`,
        [staffId, storeId],
      );
      for (const [id, date] of [
        [scheduleId, "2026-09-23"],
        [unadoptedScheduleId, "2026-09-24"],
      ]) {
        await tx.query(
          `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, $3)`,
          [id, storeId, date],
        );
      }
      // 正式版参照があるのは 2026-09-23 だけ。もう一方は「取り込んでいない」。
      await tx.query(
        `insert into authoritative_schedule_ref
           (connection_id, schedule_id, source_revision, artifact_ref, adopted_at)
         values ($1, $2, 'seed:test:1', 'seed://test', now())`,
        [CONNECTION, scheduleId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR',
                 '2026-09-23T18:00:00+09:00', '2026-09-23T22:00:00+09:00', 'SCHEDULED')`,
        [scheduledShift, scheduleId, storeId, staffId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR',
                 '2026-09-23T09:00:00+09:00', '2026-09-23T13:00:00+09:00', 'COMPLETED')`,
        [completedShift, scheduleId, storeId, staffId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR',
                 '2026-09-24T18:00:00+09:00', '2026-09-24T22:00:00+09:00', 'SCHEDULED')`,
        [unadoptedShift, unadoptedScheduleId, storeId, staffId],
      );
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      await tx.query(
        `delete from case_processing_event where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query("delete from absence_case where store_id = $1", [storeId]);
      await tx.query("delete from operation_result where connection_id = $1", [CONNECTION]);
      await tx.query("delete from authoritative_schedule_ref where connection_id = $1", [
        CONNECTION,
      ]);
      await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  async function clearCases(): Promise<void> {
    await withTransaction(async (tx) => {
      await tx.query(
        `delete from case_processing_event where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query("delete from absence_case where store_id = $1", [storeId]);
    });
  }

  it("予定済みの勤務から案件を作れる（必要枠は元勤務と同じ区間: Q04）", async () => {
    await clearCases();
    const result = await run(command());
    expect(result.ok).toBe(true);

    const row = await withTransaction((tx) =>
      tx.query<{
        state: string;
        adoption_fact: string;
        required_start_at: Date;
        required_end_at: Date;
        absent_staff_id: string;
      }>(
        `select state, adoption_fact, required_start_at, required_end_at, absent_staff_id
           from absence_case where store_id = $1`,
        [storeId],
      ),
    );
    expect(row.rows[0]).toMatchObject({
      state: "COORDINATING",
      adoption_fact: "NOT_ADOPTED",
      absent_staff_id: staffId,
    });
    expect(row.rows[0]?.required_start_at.toISOString()).toBe("2026-09-23T09:00:00.000Z");
    expect(row.rows[0]?.required_end_at.toISOString()).toBe("2026-09-23T13:00:00.000Z");
  });

  it("同じ操作IDの再実行は案件を作り直さない（二重クリック・再読込）", async () => {
    await clearCases();
    const cmd = command();
    const first = await run(cmd);
    const second = await run(cmd);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true });
    expect((second as { caseId: string }).caseId).toBe((first as { caseId: string }).caseId);

    const count = await withTransaction((tx) =>
      tx.query<{ n: number }>("select count(*)::int as n from absence_case where store_id = $1", [
        storeId,
      ]),
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("D07：同じ操作IDで内容が違えば作らない", async () => {
    await clearCases();
    const operationId = `case-${randomUUID()}`;
    await run(command({ operationId }));
    const changed = await run(command({ operationId, deadlineAt: "2026-09-23T15:00:00+09:00" }));
    expect(changed).toMatchObject({ ok: false, code: "OPERATION_CONFLICT" });
  });

  it("D02：同じ勤務について稼働中の案件を二つ作らない", async () => {
    await clearCases();
    await run(command());
    const second = await run(command());
    expect(second).toMatchObject({ ok: false, code: "OPERATION_CONFLICT" });
  });

  it("D01：予定済みでない勤務は対象にしない", async () => {
    await clearCases();
    const result = await run(command({ absentShiftAssignmentId: completedShift }));
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("D11：正式版参照の無い営業日は「勤務が無い」ではなく取込み前として断る", async () => {
    await clearCases();
    const result = await run(
      command({
        absentShiftAssignmentId: unadoptedShift,
        deadlineAt: "2026-09-24T16:00:00+09:00",
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((result as { detail: string }).detail).toContain("正式版参照");
  });

  it("期限が現在より前、または勤務開始より後なら作らない", async () => {
    await clearCases();
    expect(await run(command({ deadlineAt: "2026-09-23T08:00:00+09:00" }))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await run(command({ deadlineAt: "2026-09-23T20:00:00+09:00" }))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("存在しない勤務は作らない", async () => {
    await clearCases();
    const result = await run(command({ absentShiftAssignmentId: randomUUID() }));
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("終端の案件は重複検査の対象から外れ、次の案件を始められる（A01の前提）", async () => {
    await clearCases();
    const first = await run(command());
    expect(first.ok).toBe(true);
    await withTransaction((tx) =>
      tx.query(
        `update absence_case
            set state = 'HANDED_OFF', handoff_reason = 'CANDIDATES_EXHAUSTED', handed_off_at = now()
          where store_id = $1`,
        [storeId],
      ),
    );
    now = "2026-09-23T10:00:00+09:00";
    const second = await run(command());
    expect(second.ok).toBe(true);
  });
});
