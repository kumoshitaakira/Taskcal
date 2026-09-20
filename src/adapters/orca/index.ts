/**
 * ModelGateway の組み立て。
 *
 * 既定は安全側：接続情報・金額予算のどちらかが欠けていれば、実呼出しを行わない
 * `UnconfiguredModelGateway` を返す（ADR-007、Q10）。
 */

import "server-only";
import { getServerEnv } from "@/config/env";
import type { BudgetLedger } from "./budget";
import { BudgetGuard } from "./budget";
import type { ModelGateway } from "./model-gateway";
import { OrcaRouterClient } from "./orca-client";
import { UnconfiguredModelGateway } from "./unconfigured-gateway";

export interface ModelGatewayDeps {
  readonly ledger: BudgetLedger;
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const env = getServerEnv();

  if (!env.ORCA_BASE_URL || !env.ORCA_API_KEY) {
    return new UnconfiguredModelGateway();
  }
  if (
    env.ORCA_CASE_SPEND_LIMIT_MICRO_USD === undefined ||
    env.ORCA_RUN_SPEND_LIMIT_MICRO_USD === undefined ||
    env.ORCA_ESTIMATED_MICRO_USD_PER_CALL === undefined
  ) {
    // 接続できても、金額上限または1呼出しの見積りが無ければ有料呼出しを開始しない
    // （RFC-004 §7）。見積り0は予算検査を無効にするため、未設定と同じ扱いにする。
    return new UnconfiguredModelGateway();
  }

  return new OrcaRouterClient({
    baseUrl: env.ORCA_BASE_URL,
    apiKey: env.ORCA_API_KEY,
    budget: new BudgetGuard(
      {
        caseSpendLimitMicroUsd: env.ORCA_CASE_SPEND_LIMIT_MICRO_USD,
        runSpendLimitMicroUsd: env.ORCA_RUN_SPEND_LIMIT_MICRO_USD,
        caseCallLimit: env.ORCA_CASE_CALL_LIMIT,
      },
      deps.ledger,
    ),
    estimatedMicroUsdPerCall: env.ORCA_ESTIMATED_MICRO_USD_PER_CALL,
  });
}

export * from "./budget";
export * from "./model-gateway";
export * from "./usage";
