/**
 * transaction helper の結合確認。実PostgreSQLを必要とする。
 *
 * 受入ケースの検証ではない。取引境界の基本動作だけを見る。
 */

import { describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、統合テストを実行していません。\n\n",
  );
}

describe.skipIf(!connectionString)("withTransaction（DATABASE_URL 必須）", () => {
  it("lockTimeoutMs を指定しても取引が失敗しない（SETはパラメーターを取れない）", async () => {
    const { withTransaction } = await import("@/adapters/db/transaction");
    const value = await withTransaction(
      async (tx) => {
        const { rows } = await tx.query<{ lock_timeout: string }>("show lock_timeout");
        return rows[0]?.lock_timeout;
      },
      { lockTimeoutMs: 5_000 },
    );
    expect(value).toBe("5s");
  });

  it("入れ子呼出しは同じ取引へ参加する（一括性を2つの取引に割らない）", async () => {
    const { withTransaction } = await import("@/adapters/db/transaction");
    const [outer, inner] = await withTransaction(async (tx) => {
      const a = await tx.query<{ id: string }>("select txid_current()::text as id");
      const b = await withTransaction(async (inner) =>
        inner.query<{ id: string }>("select txid_current()::text as id"),
      );
      return [a.rows[0]?.id, b.rows[0]?.id];
    });
    expect(inner).toBe(outer);
  });

  it("例外で ROLLBACK し、変更が残らない", async () => {
    const { withTransaction } = await import("@/adapters/db/transaction");
    const { getPool } = await import("@/adapters/db/pool");

    await expect(
      withTransaction(async (tx) => {
        await tx.query("create temp table rollback_probe (n int)");
        await tx.query("insert into rollback_probe values (1)");
        throw new Error("意図的な失敗");
      }),
    ).rejects.toThrow("意図的な失敗");

    const { rows } = await getPool().query<{ exists: boolean }>(
      "select to_regclass('pg_temp.rollback_probe') is not null as exists",
    );
    expect(rows[0]?.exists).toBe(false);
  });
});
