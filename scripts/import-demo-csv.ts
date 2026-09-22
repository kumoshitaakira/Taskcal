/** 固定の架空CSVを初回だけ取り込む。seed:dev の seed: 参照をCSV版へ置き換える。 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";
import { FileCsvArtifactStore } from "../src/adapters/csv/schedule-gateway";
import { parseMonthlyCsv } from "../src/adapters/csv/monthly-csv";
import { createMonthlyScheduleSnapshot } from "../src/application/monthly-schedule";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL が未設定です。");
  const base = path.join(process.cwd(), "fixtures", "dev", "month-2026-09");
  const [csv, manifestText] = await Promise.all([
    readFile(path.join(base, "schedule.csv"), "utf8"),
    readFile(path.join(base, "manifest.json"), "utf8"),
  ]);
  const parsed = parseMonthlyCsv(csv, JSON.parse(manifestText) as unknown);
  createMonthlyScheduleSnapshot(parsed);
  const artifactRef = `csv://initial/${parsed.sourceRevision}`;
  const connectionId = "mock:demo";
  const artifacts = new FileCsvArtifactStore(path.join(process.cwd(), "var", "csv", "artifacts"));
  const written = await artifacts.write({
    connectionId,
    artifactRef,
    csv: parsed.normalizedCsv,
    manifest: parsed.manifest,
  });
  if (written === "CONFLICT") throw new Error("初回CSV成果物が既存内容と一致しません。");
  const back = await artifacts.read({ connectionId, artifactRef });
  if (
    typeof back === "string" ||
    parseMonthlyCsv(back.csv, back.manifest).sourceRevision !== parsed.sourceRevision
  ) {
    throw new Error("初回CSV成果物の読戻しが一致しません。");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const active = await client.query("select case_id from absence_case limit 1");
    if (active.rowCount) throw new Error("案件があるDBへ初回CSVを取り込めません。");
    const store = await client.query(
      "select 1 from store where store_id=$1 and timezone=$2 and role_code=$3",
      [parsed.manifest.storeId, parsed.manifest.timezone, parsed.manifest.roleCode],
    );
    if (store.rowCount !== 1) throw new Error("固定CSVとDBの店舗条件が一致しません。");
    const staff = await client.query<{ staff_id: string }>(
      "select staff_id from staff where store_id = $1 order by staff_id",
      [parsed.manifest.storeId],
    );
    if (
      JSON.stringify(staff.rows.map((r) => r.staff_id)) !==
      JSON.stringify([...parsed.manifest.staffIds].sort())
    ) {
      throw new Error(
        "固定CSVとDBのスタッフ集合が一致しません。先に seed:dev を実行してください。",
      );
    }
    const existing = await client.query<{ shift_assignment_id: string }>(
      `select a.shift_assignment_id from shift_assignment a join schedule s on s.schedule_id = a.schedule_id
        where s.store_id = $1 and s.business_date >= $2::date
          and s.business_date < ($2::date + interval '1 month') order by a.shift_assignment_id`,
      [parsed.manifest.storeId, `${parsed.manifest.month}-01`],
    );
    if (
      JSON.stringify(existing.rows.map((r) => r.shift_assignment_id)) !==
      JSON.stringify(parsed.assignments.map((a) => a.shiftAssignmentId).sort())
    ) {
      throw new Error("固定CSVとDBの勤務ID集合が一致しません。");
    }
    for (const assignment of parsed.assignments) {
      const updated = await client.query(
        `update shift_assignment set staff_id=$2, role_code=$3, start_at=$4, end_at=$5,
           status=$6, source_case_id=$8 where shift_assignment_id=$1 and schedule_id=$7`,
        [
          assignment.shiftAssignmentId,
          assignment.staffId,
          assignment.roleCode,
          assignment.startAt,
          assignment.endAt,
          assignment.status,
          assignment.scheduleId,
          assignment.sourceCaseId ?? null,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("固定CSVの勤務IDとDB勤務表が一致しません。");
    }
    for (const day of parsed.manifest.days ?? []) {
      const schedule = await client.query(
        "select 1 from schedule where schedule_id=$1 and store_id=$2 and business_date=$3",
        [day.scheduleId, parsed.manifest.storeId, day.date],
      );
      if (schedule.rowCount !== 1) throw new Error("固定CSVとDBの営業日が一致しません。");
      const updated = await client.query(
        `update authoritative_schedule_ref set source_revision=$3, artifact_ref=$4,
           adopted_at=now(), version=version+1
          where connection_id=$1 and schedule_id=$2 and source_revision like 'seed:%'`,
        [connectionId, day.scheduleId, parsed.sourceRevision, artifactRef],
      );
      if (updated.rowCount !== 1) {
        const same = await client.query(
          `select 1 from authoritative_schedule_ref where connection_id=$1 and schedule_id=$2
             and source_revision=$3 and artifact_ref=$4`,
          [connectionId, day.scheduleId, parsed.sourceRevision, artifactRef],
        );
        if (same.rowCount !== 1) throw new Error("正式版参照を初回CSVと一致させられません。");
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  process.stdout.write(`CSV初回取込み完了: ${parsed.sourceRevision}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
