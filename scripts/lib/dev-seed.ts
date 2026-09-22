/**
 * 開発・デモ用の架空データの取込み。`seed:dev` と `reset:dev` が共有する。
 *
 * **CSV原本の取込み経路（Day 4で接続）。** 担当Bの固定fixture
 * （`fixtures/dev/month-2026-09/`）を `parseMonthlyCsv` で検査・正規化し、
 *
 *   1. 管理版ストア（`var/schedule/<接続>/revisions/<sourceRevision>/`）へ不変の版として置き、
 *   2. 同じ内容を内部勤務表（`schedule` / `shift_assignment`）へ入れ、
 *   3. 対象月の全営業日の正式版参照（`authoritative_schedule_ref`）をその版へ向ける。
 *
 * `source_revision` は CSV の内容hash、`artifact_ref` は管理版の参照（`revisions/<hash>`）。
 * 画面が読む勤務表は、この版からCSV経路で往復したもの（A01／A06の前提）。
 *
 * 取込みは**初回だけ**。正式版参照が既にあれば、内部表も参照も触らない——デモで正式採用した
 * 後に seed を再実行すると、内部表だけ初期状態へ戻って参照と食い違うため。初期状態へ戻すのは
 * `reset:dev`（全消去のうえ再取込み）。
 *
 * 実在スタッフのデータを入れない（AGENTS.md）。表示名はfixtureに無いので、ここで架空の名を付ける。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import {
  artifactRefOf,
  importRevision,
  readRevision,
  registerConnection,
} from "../../src/adapters/csv/csv-store";
import type { MonthlyCsv } from "../../src/adapters/csv/monthly-csv";

export const DEV_CONNECTION_ID = "mock:demo";
export const DEV_FIXTURE_DIR = "fixtures/dev/month-2026-09";

/** Q06：月次割当上限。単価・実績が無いためのMVP既定値であり、採用済みの業務条件ではない。 */
const MONTHLY_CAP_MINUTES = 9_600;

/** fixture の staffIds（昇順）に対応する架空の表示名。 */
const STAFF_NAMES = ["架空 あかり", "架空 いつき", "架空 うみ", "架空 えいた"] as const;

export interface SeedLog {
  (line: string): void;
}

export interface SeedOutcome {
  readonly sourceRevision: string;
  readonly artifactRef: string;
  /** 正式版参照を今回作ったか（初回取込み）。 */
  readonly imported: boolean;
  readonly assignments: number;
  readonly staff: number;
}

export async function readFixture(fixtureDir: string): Promise<{ csv: string; manifest: unknown }> {
  const [csv, manifest] = await Promise.all([
    readFile(path.join(fixtureDir, "schedule.csv"), "utf8"),
    readFile(path.join(fixtureDir, "manifest.json"), "utf8"),
  ]);
  return { csv, manifest: JSON.parse(manifest) as unknown };
}

/**
 * 進行中の案件だけを消す。確定した事実（採用済みの勤務・完了した案件）は消さない。
 * デモを何度も動かすために、前回の途中状態だけを片付ける。
 */
export async function clearInProgress(
  tx: PoolClient,
  storeId: string,
  log: SeedLog,
): Promise<void> {
  // **状態だけで決めない。** 採用事実が未採用のものだけを片付ける（ADR-022）。採用済み・
  // 成否不明の案件は確定した事実を持ち得るので、進行中の状態でも触らない。
  const { rows } = await tx.query<{ case_id: string; adoption_fact: string }>(
    `select case_id, adoption_fact from absence_case
      where store_id = $1 and state not in ('COMPLETED', 'HANDED_OFF', 'CANCELLED')`,
    [storeId],
  );
  const kept = rows.filter((r) => r.adoption_fact !== "NOT_ADOPTED");
  for (const row of kept) {
    log(`seed: 案件 ${row.case_id} は採用事実が ${row.adoption_fact} のため片付けません。`);
  }
  const ids = rows.filter((r) => r.adoption_fact === "NOT_ADOPTED").map((r) => r.case_id);
  if (ids.length === 0) return;
  log(`seed: 進行中の案件 ${ids.length} 件を片付けます。`);

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

async function upsertStoreAndStaff(tx: PoolClient, parsed: MonthlyCsv): Promise<void> {
  const { storeId, roleCode, staffIds } = parsed.manifest;
  await tx.query(
    `insert into store (store_id, name, timezone, role_code)
     values ($1, '架空ダイニング 1号店', $3, $2)
     on conflict (store_id) do update set name = excluded.name`,
    [storeId, roleCode, parsed.manifest.timezone],
  );
  for (const [index, staffId] of staffIds.entries()) {
    const name = STAFF_NAMES[index] ?? `架空 ${index + 1}`;
    await tx.query(
      `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
       values ($1, $2, $3, $4, $5)
       on conflict (staff_id) do update set display_name = excluded.display_name`,
      [staffId, storeId, name, roleCode, MONTHLY_CAP_MINUTES],
    );
    await tx.query(
      `insert into contact_endpoint (provider, connection_id, endpoint_key, staff_id)
       values ('mock', $1, $2, $3)
       on conflict (provider, connection_id, endpoint_key) do nothing`,
      [DEV_CONNECTION_ID, `staff:${staffId}`, staffId],
    );
  }
}

/** 初回取込み：内部勤務表と、対象月の全営業日の正式版参照を管理版へ向ける。 */
async function importIntoDatabase(tx: PoolClient, parsed: MonthlyCsv): Promise<void> {
  const { storeId } = parsed.manifest;
  const days = parsed.manifest.days ?? [];
  // 月内の全営業日を作る。欠けた日を0と推定しないため、空の日も行として持つ（Q06 / A09）。
  for (const day of days) {
    await tx.query(
      `insert into schedule (schedule_id, store_id, business_date)
       values ($1, $2, $3) on conflict (schedule_id) do nothing`,
      [day.scheduleId, storeId, day.date],
    );
  }
  for (const row of parsed.assignments) {
    await tx.query(
      `insert into shift_assignment
         (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
          start_at, end_at, status, source_case_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (shift_assignment_id) do nothing`,
      [
        row.shiftAssignmentId,
        row.scheduleId,
        storeId,
        row.staffId,
        row.roleCode,
        row.startAt,
        row.endAt,
        row.status,
        row.sourceCaseId ?? null,
      ],
    );
  }
  for (const day of days) {
    await tx.query(
      `insert into authoritative_schedule_ref
         (connection_id, schedule_id, source_revision, artifact_ref, adopted_at)
       values ($1, $2, $3, $4, now())
       on conflict (connection_id, schedule_id) do nothing`,
      [
        DEV_CONNECTION_ID,
        day.scheduleId,
        parsed.sourceRevision,
        artifactRefOf(parsed.sourceRevision),
      ],
    );
  }
}

/**
 * 取込み本体。呼出し元が取引を開いて渡す。
 *
 * 管理版ストアへの書込みはDB取引の外の作用だが、内容アドレスで不変なので、DB側が
 * 巻き戻っても矛盾は残らない（同じ内容を再度置くだけ）。
 */
export async function seedDev(
  tx: PoolClient,
  options: { readonly root: string; readonly fixtureDir: string; readonly log: SeedLog },
): Promise<SeedOutcome> {
  const fixture = await readFixture(options.fixtureDir);
  await registerConnection(options.root, DEV_CONNECTION_ID);
  const { parsed, stored } = await importRevision(options.root, DEV_CONNECTION_ID, fixture);
  options.log(
    `seed: 管理版 ${parsed.sourceRevision.slice(0, 12)}… を${stored === "WRITTEN" ? "保存しました" : "確認しました（既存）"}（${parsed.assignments.length}勤務・${parsed.completeness}）。`,
  );

  const { storeId } = parsed.manifest;
  await clearInProgress(tx, storeId, options.log);
  await upsertStoreAndStaff(tx, parsed);

  const refs = await tx.query<{ n: number; revisions: string[] }>(
    `select count(*)::int as n, coalesce(array_agg(distinct source_revision), '{}') as revisions
       from authoritative_schedule_ref where connection_id = $1`,
    [DEV_CONNECTION_ID],
  );
  const existing = refs.rows[0];
  let imported = false;
  if (!existing || existing.n === 0) {
    await importIntoDatabase(tx, parsed);
    imported = true;
  } else {
    // 既に取り込み済み。内部表と参照は触らない（採用後の状態を壊さない）。
    // ただし参照が指す版がストアに無ければ、読めない状態なので警告する。
    for (const revision of existing.revisions) {
      const found = await readRevision(options.root, DEV_CONNECTION_ID, revision).catch(
        () => "NOT_FOUND" as const,
      );
      if (found === "NOT_FOUND") {
        options.log(
          `seed: 警告: 正式版参照が指す管理版 ${revision.slice(0, 12)}… がストアにありません。` +
            " 画面から勤務表を読めません。初期状態へ戻すなら npm run reset:dev を実行してください。",
        );
      }
    }
    options.log("seed: 正式版参照が既にあるため、内部勤務表と参照は変更しません。");
  }

  return {
    sourceRevision: parsed.sourceRevision,
    artifactRef: artifactRefOf(parsed.sourceRevision),
    imported,
    assignments: parsed.assignments.length,
    staff: parsed.manifest.staffIds.length,
  };
}
