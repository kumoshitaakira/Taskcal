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
  /**
   * 1呼出しの費用見積り（JPY）。単価が未確認のため呼出し側が与える。
   * 0を渡すと予算検査が無効になるため、`BudgetGuard` が拒否する。
   */
  readonly estimatedJpyPerCall: number;
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const env = getServerEnv();

  if (!env.ORCA_BASE_URL || !env.ORCA_API_KEY) {
    return new UnconfiguredModelGateway();
  }
  if (env.ORCA_BUDGET_JPY_PER_CASE === undefined || env.ORCA_BUDGET_JPY_TOTAL === undefined) {
    // 接続できても、金額予算が無ければ有料呼出しを開始しない。
    return new UnconfiguredModelGateway();
  }

  return new OrcaRouterClient({
    baseUrl: env.ORCA_BASE_URL,
    apiKey: env.ORCA_API_KEY,
    budget: new BudgetGuard(
      {
        perCaseJpy: env.ORCA_BUDGET_JPY_PER_CASE,
        totalJpy: env.ORCA_BUDGET_JPY_TOTAL,
        maxCallsPerCase: env.ORCA_MAX_CALLS_PER_CASE,
      },
      deps.ledger,
    ),
    estimatedJpyPerCall: deps.estimatedJpyPerCall,
  });
}

export * from "./budget";
export * from "./model-gateway";
export * from "./usage";
