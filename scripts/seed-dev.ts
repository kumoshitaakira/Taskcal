/**
 * 開発・デモ用の架空データ。担当A。
 *
 * **CSV原本の取込み経路ではない。** 正規化・安定IDの往復・月内完全性の検査は担当Bの
 * `src/adapters/csv/` が行う（未実装）。ここはその結果が入るはずの表へ、手で作った
 * 架空データを置くだけ。`authoritative_schedule_ref.source_revision` にも、CSVの
 * 内容hashではなく seed の目印を入れる。**取込み済みと読まないこと。**
 *
 * IDは担当Bのfixture（fixtures/dev/month-2026-09/）と揃えてある。CSV経路が入った
 * ときに同じ勤務を指すため。
 *
 * 実在スタッフのデータを入れない（AGENTS.md）。
 *
 * 使い方: npm run seed:dev
 */

import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { Pool, type PoolClient } from "pg";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

const STORE_ID = "00000001-0000-4000-8000-000000000001";
const MONTH = "2026-09";
const ROLE = "FLOOR";
const CONNECTION_ID = "mock:demo";
/** CSVの内容hashではない。取込みが未実装であることを値の形でも示す。 */
const SOURCE_REVISION = `seed:${MONTH}:1`;

/** Q06：月次割当上限。単価・実績が無いためのMVP既定値であり、採用済みの業務条件ではない。 */
const MONTHLY_CAP_MINUTES = 9_600;

const STAFF = [
  { id: "00000004-0000-4000-8000-000000000001", name: "架空 あかり" },
  { id: "00000004-0000-4000-8000-000000000002", name: "架空 いつき" },
  { id: "00000004-0000-4000-8000-000000000003", name: "架空 うみ" },
  { id: "00000004-0000-4000-8000-000000000004", name: "架空 えいた" },
] as const;

/** 担当BのCSV fixture と同じ7勤務。 */
const SHIFTS = [
  {
    id: "00000003-0000-4000-8000-000000000001",
    date: "2026-09-01",
    staff: 0,
    from: "10:00",
    to: "18:00",
    status: "COMPLETED",
  },
  {
    id: "00000003-0000-4000-8000-000000000002",
    date: "2026-09-01",
    staff: 1,
    from: "18:00",
    to: "22:00",
    status: "COMPLETED",
  },
  {
    id: "00000003-0000-4000-8000-000000000003",
    date: "2026-09-10",
    staff: 2,
    from: "18:00",
    to: "22:00",
    status: "CANCELLED",
  },
  {
    id: "00000003-0000-4000-8000-000000000004",
    date: "2026-09-21",
    staff: 0,
    from: "18:00",
    to: "22:00",
    status: "SCHEDULED",
  },
  {
    id: "00000003-0000-4000-8000-000000000005",
    date: "2026-09-21",
    staff: 1,
    from: "12:00",
    to: "16:00",
    status: "SCHEDULED",
  },
  {
    id: "00000003-0000-4000-8000-000000000006",
    date: "2026-09-22",
    staff: 2,
    from: "18:00",
    to: "22:00",
    status: "SCHEDULED",
  },
  // 固定CSVと同じ通常勤務。案件由来は持たない。
  {
    id: "00000003-0000-4000-8000-000000000007",
    date: "2026-09-25",
    staff: 3,
    from: "18:00",
    to: "20:00",
    status: "SCHEDULED",
  },
] as const;

function scheduleIdOf(date: string): string {
  const day = Number(date.slice(8, 10));
  return `00000002-0000-4000-8000-${String(day).padStart(12, "0")}`;
}

function at(date: string, time: string): string {
  return `${date}T${time}:00+09:00`;
}

function monthDates(): string[] {
  const [year, month] = MONTH.split("-").map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * 進行中の案件だけを消す。確定した事実（採用済みの勤務・完了した案件）は消さない。
 * デモを何度も動かすために、前回の途中状態だけを片付ける。
 */
async function clearInProgress(tx: PoolClient): Promise<void> {
  const { rows } = await tx.query<{ case_id: string }>(
    `select case_id from absence_case
      where store_id = $1 and state not in ('COMPLETED', 'HANDED_OFF', 'CANCELLED')`,
    [STORE_ID],
  );
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.case_id);
  process.stdout.write(`seed: 進行中の案件 ${ids.length} 件を片付けます。\n`);

  await tx.query(
    `update shift_assignment set source_case_id = null where source_case_id = any($1)`,
    [ids],
  );
  await tx.query(
    `delete from mock_inbox_item where outreach_id in
                    (select outreach_id from outreach where case_id = any($1))`,
    [ids],
  );
  await tx.query(`delete from schedule_update where case_id = any($1)`, [ids]);
  await tx.query(
    `delete from selection_item where selection_id in
                    (select selection_id from selection_result where case_id = any($1))`,
    [ids],
  );
  await tx.query(`delete from selection_result where case_id = any($1)`, [ids]);
  await tx.query(`delete from commitment where case_id = any($1)`, [ids]);
  await tx.query(`delete from reply_interpretation where case_id = any($1)`, [ids]);
  await tx.query(`delete from inbound_event where case_id = any($1)`, [ids]);
  await tx.query(
    `delete from message_delivery where message_id in
                    (select message_id from outreach_message where case_id = any($1))`,
    [ids],
  );
  await tx.query(
    `delete from mock_inbox_item where message_id in
                    (select message_id from outreach_message where case_id = any($1))`,
    [ids],
  );
  await tx.query(`delete from notification_outbox where case_id = any($1)`, [ids]);
  await tx.query(`delete from outreach_message where case_id = any($1)`, [ids]);
  await tx.query(`delete from outreach where case_id = any($1)`, [ids]);
  await tx.query(`delete from case_processing_event where case_id = any($1)`, [ids]);
  await tx.query(`delete from absence_case where case_id = any($1)`, [ids]);
}

async function seed(tx: PoolClient): Promise<void> {
  await clearInProgress(tx);

  await tx.query(
    `insert into store (store_id, name, timezone, role_code)
     values ($1, '架空ダイニング 1号店', 'Asia/Tokyo', $2)
     on conflict (store_id) do update set name = excluded.name`,
    [STORE_ID, ROLE],
  );

  for (const staff of STAFF) {
    await tx.query(
      `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
       values ($1, $2, $3, $4, $5)
       on conflict (staff_id) do update set display_name = excluded.display_name`,
      [staff.id, STORE_ID, staff.name, ROLE, MONTHLY_CAP_MINUTES],
    );
    await tx.query(
      `insert into contact_endpoint (provider, connection_id, endpoint_key, staff_id)
       values ('mock', $1, $2, $3)
       on conflict (provider, connection_id, endpoint_key) do nothing`,
      [CONNECTION_ID, `staff:${staff.id}`, staff.id],
    );
  }

  // 月内の全営業日を作る。欠けた日を0と推定しないため、空の日も行として持つ（Q06 / A09）。
  for (const date of monthDates()) {
    await tx.query(
      `insert into schedule (schedule_id, store_id, business_date)
       values ($1, $2, $3) on conflict (schedule_id) do nothing`,
      [scheduleIdOf(date), STORE_ID, date],
    );
    await tx.query(
      `insert into authoritative_schedule_ref
         (connection_id, schedule_id, source_revision, artifact_ref, adopted_at)
       values ($1, $2, $3, $4, now())
       on conflict (connection_id, schedule_id) do nothing`,
      [CONNECTION_ID, scheduleIdOf(date), SOURCE_REVISION, `seed://${MONTH}`],
    );
  }

  for (const shift of SHIFTS) {
    await tx.query(
      `insert into shift_assignment
         (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
          start_at, end_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (shift_assignment_id) do update set status = excluded.status`,
      [
        shift.id,
        scheduleIdOf(shift.date),
        STORE_ID,
        STAFF[shift.staff].id,
        ROLE,
        at(shift.date, shift.from),
        at(shift.date, shift.to),
        shift.status,
      ],
    );
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL が未設定です。.env.example を .env.local へ複製してください。");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await seed(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  process.stdout.write(
    `seed: 架空データを投入しました（店舗1・スタッフ${STAFF.length}・勤務${SHIFTS.length}）。\n` +
      "seed: これはCSV取込みではありません。正規化・安定IDの往復・月内完全性の検査は未実装です。\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
