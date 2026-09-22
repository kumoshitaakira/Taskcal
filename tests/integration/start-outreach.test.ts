/**
 * 同時個別打診の開始と送信（RFC-011 §2、A11）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、一人の送信失敗で案件が閉じないこと、未送信と配送失敗の区別が
 * 打診の状態に正しく反映されること、結果不明を再送しないこと。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

  const storeId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const staff = Array.from({ length: 4 }, () => randomUUID());
  let caseId: string;
  const now = "2026-09-26T09:00:00+09:00";

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
    const { createPgAbsenceCaseRepository } = await import("@/adapters/db/case-repository");
    const { createPgStoreRepository } = await import("@/adapters/db/store-repository");
    const { createPgOutreachRepository } = await import("@/adapters/db/outreach-repository");
    const { createPgOutboxRepository } = await import("@/adapters/db/outbox-repository");
    const { createPgOperationResultStore } = await import("@/adapters/db/operation-result-store");
    const { createDefaultMessagingGateway } = await import("@/adapters/channel");

    const operations = createPgOperationResultStore();
    const outreaches = createPgOutreachRepository();
    const outbox = createPgOutboxRepository();

    start = startOutreach({
      cases: createPgAbsenceCaseRepository(),
      outreaches,
      outbox,
      operations,
      roster: createRosterEligibility(),
      stores: createPgStoreRepository(),
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
    });
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
      await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from contact_endpoint where connection_id = $1", [CONNECTION]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  it("D01：欠勤者本人を除いた全員へ個別に打診を積む（送信はまだしない）", async () => {
    const result = await start({ operationId: `so-${randomUUID()}`, caseId });
    expect(result).toMatchObject({ ok: true, started: 3 });

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
});
