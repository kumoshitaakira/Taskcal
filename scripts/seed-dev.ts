/**
 * 開発・デモ用の架空データ。担当A（取込み経路はDay 4で担当Bのストアへ接続）。
 *
 * 固定fixture（`fixtures/dev/month-2026-09/`）をCSV経路で取り込む。内容は
 * `scripts/lib/dev-seed.ts`。**初回だけ**内部勤務表と正式版参照を作り、以後は進行中の
 * 案件を片付けるだけ。初期状態へ戻すのは `npm run reset:dev`。
 *
 * 使い方: npm run seed:dev
 */

import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";
import { DEFAULT_CSV_STORE_ROOT } from "../src/adapters/csv/csv-store";
import { DEV_FIXTURE_DIR, seedDev } from "./lib/dev-seed";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL が未設定です。.env.example を .env.local へ複製してください。");
  }
  const log = (line: string) => process.stdout.write(`${line}\n`);

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const outcome = await seedDev(client, {
        root: DEFAULT_CSV_STORE_ROOT,
        fixtureDir: DEV_FIXTURE_DIR,
        log,
      });
      await client.query("commit");
      log(
        `seed: ${outcome.imported ? "CSVを取り込みました" : "取込み済みの状態を確認しました"}` +
          `（店舗1・スタッフ${outcome.staff}・勤務${outcome.assignments}・版 ${outcome.sourceRevision.slice(0, 12)}…）。`,
      );
      log(
        "seed: 正式版参照は管理版ストア（var/schedule）のCSVを指します。取込みは正式採用ではありません。",
      );
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
