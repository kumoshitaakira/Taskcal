/**
 * 環境変数のschema。
 *
 * `server-only` を**付けない**。scripts（`check:orca` 等）からも同じ判定を使うため。
 * 実際の値の読み取りとキャッシュは `env.ts`（server-only）が行う。
 *
 * 方針：
 *   - 必須値が欠けたら起動時に失敗させる。黙って既定値で動かさない。
 *   - 金額はUSDの整数micro単位（RFC-004 §7）。円換算は表示時のみ。
 *   - 「未設定」と「0」を区別する（ADR-007）。
 */

import { z } from "zod";

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

export const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL が未設定です。.env.example を参照してください。"),
  ORCA_BASE_URL: optionalText,
  ORCA_API_KEY: optionalText,
  // RFC-004 §7：金額はUSDの整数micro単位。円換算は表示時のみ。
  ORCA_CASE_SPEND_LIMIT_MICRO_USD: optionalPositiveInt,
  ORCA_RUN_SPEND_LIMIT_MICRO_USD: optionalPositiveInt,
  ORCA_CASE_CALL_LIMIT: optionalPositiveInt,
  ORCA_ESTIMATED_MICRO_USD_PER_CALL: optionalPositiveInt,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * DATABASE_URL だけの検査。
 *
 * 環境変数全体の検査とは**独立**させる。Orcaの設定値が不正なだけでDBへ
 * 接続できなくなると、`/api/health` が「DB未設定」という誤った復旧案を示す。
 */
export const databaseUrlSchema = z
  .string()
  .min(1, "DATABASE_URL が未設定です。.env.example を参照してください。");
