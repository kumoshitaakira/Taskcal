/**
 * schema が守る不変条件を、実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * コード側の検査が抜けても最後にDBが止めることを確認する。制約の存在を問い合わせる
 * のではなく、実際に違反する行を入れて拒否されることを見る。
 *
 * 後始末：全体を1つの取引で行い、最後に ROLLBACK する。各検査は SAVEPOINT で囲む
 * （制約違反は取引を中断するため）。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、schemaの不変条件を確認していません。\n\n",
  );
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** 制約違反を期待する。SQLSTATE を返す。 */
async function expectRejected(tx: PoolClient, sql: string, params: unknown[]): Promise<string> {
  await tx.query("savepoint probe");
  try {
    await tx.query(sql, params);
  } catch (error) {
    await tx.query("rollback to savepoint probe");
    return (error as { code?: string }).code ?? "";
  }
  await tx.query("rollback to savepoint probe");
  throw new Error("拒否されるはずの書き込みが通りました");
}

describe.skipIf(!connectionString)("schemaの不変条件（DATABASE_URL 必須）", () => {
  let pool: Pool;
  let tx: PoolClient;

  const storeId = randomUUID();
  const staffA = randomUUID();
  const staffB = randomUUID();
  const scheduleId = randomUUID();
  const shiftId = randomUUID();
  const caseId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 2 });
    tx = await pool.connect();
    await tx.query("begin");

    await tx.query(
      `insert into store (store_id, name, timezone, role_code)
       values ($1, 'テスト店', 'Asia/Tokyo', 'FLOOR')`,
      [storeId],
    );
    for (const [id, name] of [
      [staffA, "A"],
      [staffB, "B"],
    ]) {
      await tx.query(
        `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
         values ($1, $2, $3, 'FLOOR', 9600)`,
        [id, storeId, name],
      );
    }
    await tx.query(
      `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, '2026-09-21')`,
      [scheduleId, storeId],
    );
    await tx.query(
      `insert into shift_assignment
         (shift_assignment_id, schedule_id, store_id, staff_id, role_code, start_at, end_at, status)
       values ($1, $2, $3, $4, 'FLOOR',
               '2026-09-21T18:00:00+09:00', '2026-09-21T22:00:00+09:00', 'SCHEDULED')`,
      [shiftId, scheduleId, storeId, staffA],
    );
    await tx.query(
      `insert into absence_case
         (case_id, store_id, connection_id, schedule_id, business_date,
          absent_shift_assignment_id, absent_staff_id, role_code,
          required_start_at, required_end_at, deadline_at, state, run_id)
       values ($1, $2, 'mock:1', $3, '2026-09-21', $4, $5, 'FLOOR',
               '2026-09-21T18:00:00+09:00', '2026-09-21T22:00:00+09:00',
               '2026-09-21T16:00:00+09:00', 'COORDINATING', 'run-1')`,
      [caseId, storeId, scheduleId, shiftId, staffA],
    );
  });

  afterAll(async () => {
    await tx.query("rollback");
    tx.release();
    await pool.end();
  });

  it("D02：同じ欠勤区間で稼働中の案件を二つ作れない", async () => {
    const code = await expectRejected(
      tx,
      `insert into absence_case
         (case_id, store_id, connection_id, schedule_id, business_date,
          absent_shift_assignment_id, absent_staff_id, role_code,
          required_start_at, required_end_at, deadline_at, state, run_id)
       values ($1, $2, 'mock:1', $3, '2026-09-21', $4, $5, 'FLOOR',
               '2026-09-21T18:00:00+09:00', '2026-09-21T22:00:00+09:00',
               '2026-09-21T16:00:00+09:00', 'COORDINATING', 'run-2')`,
      [randomUUID(), storeId, scheduleId, shiftId, staffA],
    );
    expect(code).toBe("23505");
  });

  it("終端の案件は重複検査の対象から外れる（次の案件を始められる）", async () => {
    await tx.query("savepoint closed");
    await tx.query(`update absence_case set state = 'CANCELLED' where case_id = $1`, [caseId]);
    await tx.query(
      `insert into absence_case
         (case_id, store_id, connection_id, schedule_id, business_date,
          absent_shift_assignment_id, absent_staff_id, role_code,
          required_start_at, required_end_at, deadline_at, state, run_id)
       values ($1, $2, 'mock:1', $3, '2026-09-21', $4, $5, 'FLOOR',
               '2026-09-21T18:00:00+09:00', '2026-09-21T22:00:00+09:00',
               '2026-09-21T16:00:00+09:00', 'COORDINATING', 'run-3')`,
      [randomUUID(), storeId, scheduleId, shiftId, staffA],
    );
    await tx.query("rollback to savepoint closed");
  });

  it("ADR-022：HANDED_OFF は理由と時刻を伴わないと保存できない", async () => {
    const code = await expectRejected(
      tx,
      `update absence_case set state = 'HANDED_OFF' where case_id = $1`,
      [caseId],
    );
    expect(code).toBe("23514");
  });

  it("D07：同じ操作IDで内容が異なれば保存されない（取得は0行）", async () => {
    const operationId = `op-${randomUUID()}`;
    await tx.query(
      `insert into operation_result (operation_id, request_hash, operation_kind, status)
       values ($1, $2, 'CREATE_CASE', 'IN_PROGRESS')`,
      [operationId, HASH_A],
    );
    const replay = await tx.query(
      `insert into operation_result (operation_id, request_hash, operation_kind, status)
       values ($1, $2, 'CREATE_CASE', 'IN_PROGRESS')
       on conflict (operation_id) do update set updated_at = now()
        where operation_result.request_hash = excluded.request_hash
       returning operation_id, (xmax = 0) as inserted`,
      [operationId, HASH_A],
    );
    expect(replay.rowCount).toBe(1);
    expect(replay.rows[0]).toMatchObject({ inserted: false });

    const conflict = await tx.query(
      `insert into operation_result (operation_id, request_hash, operation_kind, status)
       values ($1, $2, 'CREATE_CASE', 'IN_PROGRESS')
       on conflict (operation_id) do update set updated_at = now()
        where operation_result.request_hash = excluded.request_hash
       returning operation_id`,
      [operationId, HASH_B],
    );
    expect(conflict.rowCount).toBe(0);

    // 別経路の update でも内容ハッシュを書き換えられない。
    const code = await expectRejected(
      tx,
      `update operation_result set request_hash = $2 where operation_id = $1`,
      [operationId, HASH_B],
    );
    expect(code).toBe("23514");
  });

  it("A15：同じproviderイベントを二度保存しない。接続が違えば別イベントとして入る", async () => {
    const eventId = `evt-${randomUUID()}`;
    const insert = `insert into inbound_event
        (inbound_event_id, provider, connection_id, provider_event_id,
         occurred_at, received_at, from_provider, from_connection_id,
         from_endpoint_key, from_endpoint_version, body, channel_verified, sender_identity)
      values ($1, 'mock', $2, $3, now(), now(), 'mock', $2, 'staff-a', 1, '行けます', true, 'UNMATCHED')`;

    await tx.query(insert, [randomUUID(), "mock:1", eventId]);
    const code = await expectRejected(tx, insert, [randomUUID(), "mock:1", eventId]);
    expect(code).toBe("23505");

    // 接続範囲が違えば別のイベント（A15：重複排除キーに接続を含める）。
    await tx.query(insert, [randomUUID(), "mock:2", eventId]);
  });

  it("案件へ結び付いた受信の順序は重複しない", async () => {
    // 案件へ結び付いた受信は Message も持つ（0009 の対）。
    const messageId = randomUUID();
    await tx.query(
      `insert into outreach_message (message_id, case_id, direction, body)
       values ($1, $2, 'INBOUND', '行けます')`,
      [messageId, caseId],
    );
    const insert = `insert into inbound_event
        (inbound_event_id, case_id, outreach_id, received_seq, provider, connection_id,
         provider_event_id, occurred_at, received_at, from_provider, from_connection_id,
         from_endpoint_key, from_endpoint_version, body, channel_verified, sender_identity,
         message_id)
      values ($1, $2, null, 1, 'mock', 'mock:1', $3, now(), now(), 'mock', 'mock:1',
              'staff-a', 1, '行けます', true, 'UNMATCHED', $4)`;
    await tx.query(insert, [randomUUID(), caseId, `evt-${randomUUID()}`, messageId]);
    const code = await expectRejected(tx, insert, [
      randomUUID(),
      caseId,
      `evt-${randomUUID()}`,
      messageId,
    ]);
    expect(code).toBe("23505");
  });

  it("案件へ結び付いた受信はMessageを伴わないと保存できない（0009）", async () => {
    const code = await expectRejected(
      tx,
      `insert into inbound_event
         (inbound_event_id, case_id, received_seq, provider, connection_id, provider_event_id,
          occurred_at, received_at, from_provider, from_connection_id,
          from_endpoint_key, from_endpoint_version, body, channel_verified, sender_identity)
       values ($1, $2, 99, 'mock', 'mock:1', $3, now(), now(), 'mock', 'mock:1',
               'staff-a', 1, '行けます', true, 'UNMATCHED')`,
      [randomUUID(), caseId, `evt-${randomUUID()}`],
    );
    expect(code).toBe("23514");
  });

  it("ADR-006：同じスタッフの勤務が重なる行を拒否する", async () => {
    const code = await expectRejected(
      tx,
      `insert into shift_assignment
         (shift_assignment_id, schedule_id, store_id, staff_id, role_code, start_at, end_at, status)
       values ($1, $2, $3, $4, 'FLOOR',
               '2026-09-21T20:00:00+09:00', '2026-09-21T23:00:00+09:00', 'SCHEDULED')`,
      [randomUUID(), scheduleId, storeId, staffA],
    );
    expect(code).toBe("23P01");
  });

  it("欠勤にした区間は重複検査から外れる（代替勤務を入れられる）", async () => {
    await tx.query("savepoint absent");
    await tx.query(`update shift_assignment set status = 'ABSENT' where shift_assignment_id = $1`, [
      shiftId,
    ]);
    await tx.query(
      `insert into shift_assignment
         (shift_assignment_id, schedule_id, store_id, staff_id, role_code, start_at, end_at, status)
       values ($1, $2, $3, $4, 'FLOOR',
               '2026-09-21T18:00:00+09:00', '2026-09-21T22:00:00+09:00', 'SCHEDULED')`,
      [randomUUID(), scheduleId, storeId, staffB],
    );
    await tx.query("rollback to savepoint absent");
  });

  it("結果不明の費用を0で保存できない（精算は種別と対で入れる）", async () => {
    const code = await expectRejected(
      tx,
      `insert into budget_reservation
         (request_id, case_id, run_id, request_hash, estimated_micro_usd, settled_at)
       values ($1, $2, 'run-1', $3, 1000, now())`,
      [`req-${randomUUID()}`, caseId, HASH_A],
    );
    expect(code).toBe("23514");
  });
});
