/**
 * 環境変数の読み取りと検査。
 *
 * APIキーはサーバー側だけで読む。NEXT_PUBLIC_ を使わない（ADR-008）。
 * schema本体は `env-schema.ts`（server-onlyを付けない）にあり、scriptsと共有する。
 */

import "server-only";
import { serverEnvSchema, type ServerEnv } from "./env-schema";

export { serverEnvSchema };
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

/** テスト用。読み込み済みの値を破棄する。 */
export function resetServerEnvCache(): void {
  cached = undefined;
}
