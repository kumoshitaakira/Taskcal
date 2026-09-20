/**
 * PostgreSQL接続プール。担当A（ADR-003：pgと番号付きSQL migration）。
 */

import "server-only";
import { Pool } from "pg";
import { getDatabaseUrl } from "@/config/env";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      // 外部API待ちを内側に入れない設計のため、接続待ちは短くてよい。
      connectionTimeoutMillis: 5_000,
      max: 10,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
