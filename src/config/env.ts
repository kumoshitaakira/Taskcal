/**
 * 環境変数の読み取りと検査。
 *
 * 方針：
 *   - 必須値が欠けたら起動時に失敗させる。黙って既定値で動かさない。
 *   - APIキーはサーバー側だけで読む。NEXT_PUBLIC_ を使わない（ADR-008）。
 *   - 金額予算は「未設定」と「0円」を区別する（ADR-007）。
 */

import "server-only";
import { z } from "zod";

/**
 * 空文字と未設定を同じ「未設定」として扱う。0 は有効な値として残さない
 * （金額・回数の上限に 0 を設定する意味がないため）。
 */
const optionalPositiveNumber = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.addIssue({ code: "custom", message: "正の数を指定してください。" });
      return z.NEVER;
    }
    return parsed;
  });

const optionalPositiveInt = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({ code: "custom", message: "正の整数を指定してください。" });
      return z.NEVER;
    }
    return parsed;
  });

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value));

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL が未設定です。.env.example を参照してください。"),
  ORCA_BASE_URL: optionalText,
  ORCA_API_KEY: optionalText,
  ORCA_BUDGET_JPY_PER_CASE: optionalPositiveNumber,
  ORCA_BUDGET_JPY_TOTAL: optionalPositiveNumber,
  ORCA_MAX_CALLS_PER_CASE: optionalPositiveInt,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

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
