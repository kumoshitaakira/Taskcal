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

const optionalHttpUrl = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") return undefined;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "絶対URLを指定してください（例: https://example.com）。",
      });
      return z.NEVER;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "http または https のURLを指定してください。" });
      return z.NEVER;
    }
    return value;
  });

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value));

export const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL が未設定です。.env.example を参照してください。"),
  // 空文字は「未設定」。値があるなら絶対HTTP(S) URLでなければならない。
  // 任意の文字列を通すと、typo が check:orca を素通りしてgatewayが作られ、
  // 最初の推論で「予約 → fetchが送信前に失敗 → UNKNOWN_CHARGE」となり、
  // 一度も送っていない呼出しの照合が必要になる（RFC-004 §7）。
  ORCA_BASE_URL: optionalHttpUrl,
  ORCA_API_KEY: optionalText,
  // RFC-004 §7：金額はUSDの整数micro単位。円換算は表示時のみ。
  ORCA_CASE_SPEND_LIMIT_MICRO_USD: optionalPositiveInt,
  ORCA_RUN_SPEND_LIMIT_MICRO_USD: optionalPositiveInt,
  ORCA_CASE_CALL_LIMIT: optionalPositiveInt,
  // RFC-004 §7：固定額ではなく、入力長・出力上限・候補モデル単価から見積もる。
  // 単価は候補モデルのうち**最も高い**ものを入れる（振り先が変わっても不足しないため）。
  ORCA_INPUT_MICRO_USD_PER_KTOK: optionalPositiveInt,
  ORCA_OUTPUT_MICRO_USD_PER_KTOK: optionalPositiveInt,
  ORCA_MAX_REPLY_CHARS: optionalPositiveInt,
  ORCA_MAX_OUTPUT_TOKENS: optionalPositiveInt,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * OrcaRouter関連だけのschema。
 *
 * `DATABASE_URL` を含めない。OrcaRouterの設定を点検するのに、DBの設定を
 * 要求する理由はない。全体検査に混ぜると、無関係な項目の不足で
 * 「OrcaRouterの設定が不正」と報告してしまう（`check:orca`／CIの静的検査）。
 */
export const orcaEnvSchema = serverEnvSchema.pick({
  ORCA_BASE_URL: true,
  ORCA_API_KEY: true,
  ORCA_CASE_SPEND_LIMIT_MICRO_USD: true,
  ORCA_RUN_SPEND_LIMIT_MICRO_USD: true,
  ORCA_CASE_CALL_LIMIT: true,
  ORCA_INPUT_MICRO_USD_PER_KTOK: true,
  ORCA_OUTPUT_MICRO_USD_PER_KTOK: true,
  ORCA_MAX_REPLY_CHARS: true,
  ORCA_MAX_OUTPUT_TOKENS: true,
});

export type OrcaEnv = z.infer<typeof orcaEnvSchema>;

/**
 * DATABASE_URL だけの検査。
 *
 * 環境変数全体の検査とは**独立**させる。Orcaの設定値が不正なだけでDBへ
 * 接続できなくなると、`/api/health` が「DB未設定」という誤った復旧案を示す。
 */
export const databaseUrlSchema = z
  .string()
  .min(1, "DATABASE_URL が未設定です。.env.example を参照してください。");
