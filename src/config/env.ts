/**
 * 環境変数の読み取りと検査。
 *
 * APIキーはサーバー側だけで読む。NEXT_PUBLIC_ を使わない（ADR-008）。
 * schema本体は `env-schema.ts`（server-onlyを付けない）にあり、scriptsと共有する。
 */

import "server-only";
import { databaseUrlSchema, serverEnvSchema, type ServerEnv } from "./env-schema";

export { serverEnvSchema, databaseUrlSchema };
export type { ServerEnv };

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    // 値そのものは出さない。欠けている項目名だけを示す。
    throw new Error(`環境変数の検査に失敗しました:\n  ${detail}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * DATABASE_URL だけを取り出す。
 *
 * 他の環境変数の不正で接続できなくならないよう、全体検査を経由しない。
 */
export function getDatabaseUrl(): string {
  const parsed = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "DATABASE_URL が不正です。");
  }
  return parsed.data;
}

/** テスト用。読み込み済みの値を破棄する。 */
export function resetServerEnvCache(): void {
  cached = undefined;
}
