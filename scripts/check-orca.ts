/**
 * OrcaRouterの接続設定を点検する。**実呼出しは行わない。**
 *
 * 未設定を「成功」と表示しない（AGENTS.md「品質と証拠」）。
 * 使い方: npm run check:orca
 */

import process from "node:process";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

function presence(value: string | undefined): string {
  // 値そのものは出さない（ADR-008）。
  return value && value.trim() !== "" ? "設定済み" : "未設定";
}

const baseUrl = process.env.ORCA_BASE_URL;
const apiKey = process.env.ORCA_API_KEY;
const perCase = process.env.ORCA_BUDGET_JPY_PER_CASE;
const total = process.env.ORCA_BUDGET_JPY_TOTAL;
const maxCalls = process.env.ORCA_MAX_CALLS_PER_CASE;

const connectionReady = Boolean(baseUrl?.trim() && apiKey?.trim());
const budgetReady = Boolean(perCase?.trim() && total?.trim());

process.stdout.write("OrcaRouter 接続設定の点検（実呼出しは行いません）\n");
process.stdout.write(`  ORCA_BASE_URL            : ${presence(baseUrl)}\n`);
process.stdout.write(`  ORCA_API_KEY             : ${presence(apiKey)}\n`);
process.stdout.write(`  ORCA_BUDGET_JPY_PER_CASE : ${presence(perCase)}\n`);
process.stdout.write(`  ORCA_BUDGET_JPY_TOTAL    : ${presence(total)}\n`);
process.stdout.write(`  ORCA_MAX_CALLS_PER_CASE  : ${presence(maxCalls)}\n`);

if (!connectionReady) {
  process.stdout.write("\n結果: UNCONFIGURED（接続情報が未取得）\n");
  process.stdout.write("  実使用モデル・単価・費用は UNKNOWN のままです。\n");
} else if (!budgetReady) {
  process.stdout.write("\n結果: BUDGET_NOT_CONFIGURED（Q10未確定）\n");
  process.stdout.write("  金額予算が未設定のため、有料呼出しを開始しません（ADR-007）。\n");
} else {
  process.stdout.write("\n結果: CONFIGURED（設定あり。実接続の成否はここでは確認していません）\n");
}
