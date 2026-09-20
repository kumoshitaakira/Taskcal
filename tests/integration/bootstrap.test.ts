/**
 * 起動の結合確認。実PostgreSQLを必要とする。
 *   docker compose up -d db && npm run migrate
 *
 * 受入ケースの検証ではない。Day 1の結合点（DB接続・migration・状態点検）だけを見る。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local", quiet: true });

const execFileAsync = promisify(execFile);
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // 実行しなかったことを黙って緑にしない（AGENTS.md）。
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、統合テストを実行していません。\n" +
      "  実行するには: cp .env.example .env.local && docker compose up -d db && npm run migrate\n\n",
  );
}

describe.skipIf(!connectionString)("起動の結合確認（DATABASE_URL 必須）", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("DBへ接続できる", async () => {
    const { rows } = await pool.query<{ ok: number }>("select 1 as ok");
    expect(rows[0]?.ok).toBe(1);
  });

  it("migrationが適用され、記録されている", async () => {
    const { rows } = await pool.query<{ id: string; checksum: string }>(
      "select id, checksum from schema_migrations order by id",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.id).toBe("0001_worker_runtime");
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("migrateを再実行しても二重適用にならない（同じ操作を繰り返しても結果が変わらない）", async () => {
    const before = await pool.query("select count(*)::int as n from schema_migrations");
    const { stdout } = await execFileAsync("npx", ["tsx", "scripts/migrate.ts"], {
      cwd: process.cwd(),
    });
    expect(stdout).toContain("applied=0");
    const after = await pool.query("select count(*)::int as n from schema_migrations");
    expect(after.rows[0]).toEqual(before.rows[0]);
  }, 60_000);

  it("worker_heartbeat は worker_name で一意（複数行に増えない）", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
        where tc.table_name = 'worker_heartbeat'
          and tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["worker_name"]);
  });
});
