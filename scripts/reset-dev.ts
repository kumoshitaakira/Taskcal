/**
 * 開発DBと管理版ストアを初期状態へ戻し、固定fixtureを取り込み直す。
 *
 * **確定した事実も消す。** `seed:dev` は進行中の案件しか片付けないが、こちらは業務テーブルを
 * 全て空にして `var/schedule` を消す。デモを同じ初期状態から繰り返すための操作で
 * （RFC-012 §4 Day 4「初期化からデモを3回再現」）、本番の運用手順ではない。
 *
 * `schema_migrations`（適用履歴）と `worker_heartbeat` は残す。migration は再適用しない。
 *
 * 使い方: npm run reset:dev
 */

import { rename, rm, stat } from "node:fs/promises";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";
import { DEFAULT_CSV_STORE_ROOT } from "../src/adapters/csv/csv-store";
import { DEV_FIXTURE_DIR, seedDev } from "./lib/dev-seed";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

const KEEP_TABLES = new Set(["schema_migrations", "worker_heartbeat"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 機械的な歯止め（AGENTS.md：人の注意に任せない）。接続先がループバックでなければ、
 * `--yes` を明示したときだけ進む。全public表を truncate する操作なので、開発DB以外へ
 * 向いた `DATABASE_URL` で黙って走らせない。
 */
function assertSafeTarget(connectionString: string): void {
  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    // 解釈できない接続文字列は安全側（非ローカル）として扱う。
  }
  if (LOCAL_HOSTS.has(host)) return;
  if (process.argv.includes("--yes")) {
    process.stderr.write(
      `reset: 警告: 接続先 ${host || "(不明)"} はローカルではありません。--yes により続行します。\n`,
    );
    return;
  }
  throw new Error(
    `reset: 接続先 ${host || "(不明)"} はローカル（localhost / 127.0.0.1）ではありません。` +
      " 開発DB以外を消さないため停止しました。本当に消すなら --yes を付けてください。",
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL が未設定です。.env.example を .env.local へ複製してください。");
  }
  assertSafeTarget(connectionString);
  const log = (line: string) => process.stdout.write(`${line}\n`);

  // 管理版ストアは消す前に退避する。DBの取引が失敗したら戻す——DBが採用後の参照を保った
  // まま管理版だけ消えると、画面から勤務表を読めなくなる。commit できたら退避先を消す。
  const parked = `${DEFAULT_CSV_STORE_ROOT}.reset-${Date.now()}`;
  const hadStore = await stat(DEFAULT_CSV_STORE_ROOT).then(
    () => true,
    () => false,
  );
  if (hadStore) await rename(DEFAULT_CSV_STORE_ROOT, parked);

  const pool = new Pool({ connectionString, max: 1 });
  let committed = false;
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
      );
      const tables = rows.map((r) => r.table_name).filter((name) => !KEEP_TABLES.has(name));
      if (tables.length > 0) {
        // 外部キーの向きを気にせず全件消す。識別子は information_schema 由来だけを使う。
        await client.query(
          `truncate ${tables.map((name) => `"${name.replace(/"/g, '""')}"`).join(", ")} cascade`,
        );
        log(`reset: ${tables.length} テーブルを空にしました。`);
      }
      const outcome = await seedDev(client, {
        root: DEFAULT_CSV_STORE_ROOT,
        fixtureDir: DEV_FIXTURE_DIR,
        log,
      });
      await client.query("commit");
      committed = true;
      log(
        `reset: 初期状態へ戻し、CSVを取り込みました（スタッフ${outcome.staff}・勤務${outcome.assignments}・版 ${outcome.sourceRevision.slice(0, 12)}…）。`,
      );
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    if (hadStore) {
      if (committed) {
        await rm(parked, { recursive: true, force: true });
        log(`reset: 以前の ${DEFAULT_CSV_STORE_ROOT} を消しました。`);
      } else {
        // 新しく書いた版は内容アドレスなので、戻した旧ストアと混ざっても矛盾しない。
        await rm(DEFAULT_CSV_STORE_ROOT, { recursive: true, force: true });
        await rename(parked, DEFAULT_CSV_STORE_ROOT);
        log(`reset: DBを戻せなかったため、${DEFAULT_CSV_STORE_ROOT} も以前の内容へ戻しました。`);
      }
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
