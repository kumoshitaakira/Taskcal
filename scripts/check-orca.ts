/**
 * OrcaRouterの接続設定を点検する。**実呼出しは行わない。**
 *
 * 未設定を「成功」と表示しない（AGENTS.md「品質と証拠」）。
 * 判定にはアプリと同じschemaを使う。存在の有無だけを見ると、`abc` や `-1` のような
 * 不正値でも CONFIGURED と表示され、実際には createModelGateway の手前で起動が失敗する。
 *
 * 検査する範囲は OrcaRouter 関連だけ。DATABASE_URL の有無で結果を変えない。
 *
 * 使い方: npm run check:orca
 */

import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { orcaEnvSchema } from "@/config/env-schema";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

const KEYS = [
  "ORCA_BASE_URL",
  "ORCA_API_KEY",
  "ORCA_MODEL",
  "ORCA_CASE_SPEND_LIMIT_MICRO_USD",
  "ORCA_RUN_SPEND_LIMIT_MICRO_USD",
  "ORCA_CASE_CALL_LIMIT",
  "ORCA_INPUT_MICRO_USD_PER_KTOK",
  "ORCA_OUTPUT_MICRO_USD_PER_KTOK",
  "ORCA_MAX_REPLY_CHARS",
  "ORCA_MAX_OUTPUT_TOKENS",
  "ORCA_TIMEOUT_MS",
] as const;

// OrcaRouter関連だけを見る。DATABASE_URL の有無で結果を変えない。
const parsed = orcaEnvSchema.safeParse(process.env);

process.stdout.write("OrcaRouter 接続設定の点検（実呼出しは行いません）\n");

if (!parsed.success) {
  const issues = new Map<string, string>();
  for (const issue of parsed.error.issues) {
    issues.set(String(issue.path[0]), issue.message);
  }
  for (const key of KEYS) {
    const problem = issues.get(key);
    // 値そのものは出さない（ADR-008）。
    process.stdout.write(`  ${key.padEnd(33)}: ${problem ? `不正（${problem}）` : "—"}\n`);
  }
  process.stdout.write("\n結果: INVALID（設定値が契約に合いません）\n");
  process.stdout.write("  この状態ではアプリが起動しません。値を修正してください。\n");
  process.exitCode = 1;
} else {
  const env = parsed.data;
  for (const key of KEYS) {
    // 値そのものは出さない（ADR-008）。設定の有無だけを示す。
    process.stdout.write(
      `  ${key.padEnd(33)}: ${env[key] === undefined ? "未設定" : "設定済み"}\n`,
    );
  }

  // モデルIDも接続情報のうち。どれを呼ぶか決まっていなければ単価も決まらない。
  const connectionReady = Boolean(env.ORCA_BASE_URL && env.ORCA_API_KEY && env.ORCA_MODEL);
  const budgetReady =
    env.ORCA_CASE_SPEND_LIMIT_MICRO_USD !== undefined &&
    env.ORCA_RUN_SPEND_LIMIT_MICRO_USD !== undefined &&
    env.ORCA_INPUT_MICRO_USD_PER_KTOK !== undefined &&
    env.ORCA_OUTPUT_MICRO_USD_PER_KTOK !== undefined;

  if (!connectionReady) {
    process.stdout.write("\n結果: UNCONFIGURED（接続情報が未取得）\n");
    process.stdout.write("  実使用モデル・単価・費用は UNKNOWN のままです。\n");
  } else if (!budgetReady) {
    process.stdout.write("\n結果: BUDGET_NOT_CONFIGURED（Q10未確定）\n");
    process.stdout.write(
      "  case_spend_limit / run_spend_limit / 候補モデルの単価が揃うまで、\n" +
        "  有料呼出しを開始しません（RFC-004 §7 / ADR-007）。\n",
    );
  } else {
    process.stdout.write(
      "\n結果: CONFIGURED（設定あり。実接続の成否はここでは確認していません）\n",
    );
  }
}
