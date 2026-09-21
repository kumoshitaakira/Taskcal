/**
 * ModelGateway の組み立て。
 *
 * 既定は安全側：接続情報・金額予算のどちらかが欠けていれば、実呼出しを行わない
 * `UnconfiguredModelGateway` を返す（ADR-007、Q10）。
 */

import "server-only";
import { getServerEnv } from "@/config/env";
import { MAX_OUTPUT_TOKENS, MAX_REPLY_CHARS } from "@/config/mvp-policy";
import type { BudgetLedger, ModelCallStore } from "./budget";
import { BudgetGuard } from "./budget";
import type { ModelGateway } from "./model-gateway";
import { OrcaRouterClient } from "./orca-client";
import { UnconfiguredModelGateway } from "./unconfigured-gateway";

export interface ModelGatewayDeps {
  readonly ledger: BudgetLedger;
  /** 保存済み結果の照会先。再試行を再送にしないために必須。 */
  readonly callStore: ModelCallStore;
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const env = getServerEnv();

  // 未設定でも callStore は渡す。新規呼出しは止めるが、保存済み結果の再生は
  // 外部呼出しを要さないため許す（設定復元まで復旧を止めない）。
  if (!env.ORCA_BASE_URL || !env.ORCA_API_KEY) {
    return new UnconfiguredModelGateway(deps.callStore);
  }
  if (
    env.ORCA_CASE_SPEND_LIMIT_MICRO_USD === undefined ||
    env.ORCA_RUN_SPEND_LIMIT_MICRO_USD === undefined ||
    env.ORCA_INPUT_MICRO_USD_PER_KTOK === undefined ||
    env.ORCA_OUTPUT_MICRO_USD_PER_KTOK === undefined
  ) {
    // 接続できても、金額上限または単価が無ければ有料呼出しを開始しない（RFC-004 §7）。
    // 単価が無ければ保守的な見積りを作れず、予約が実費を下回り得る。
    return new UnconfiguredModelGateway(deps.callStore);
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
    callStore: deps.callStore,
    bounds: {
      maxReplyChars: env.ORCA_MAX_REPLY_CHARS ?? MAX_REPLY_CHARS,
      maxOutputTokens: env.ORCA_MAX_OUTPUT_TOKENS ?? MAX_OUTPUT_TOKENS,
    },
    prices: {
      inputMicroUsdPerKiloToken: env.ORCA_INPUT_MICRO_USD_PER_KTOK,
      outputMicroUsdPerKiloToken: env.ORCA_OUTPUT_MICRO_USD_PER_KTOK,
    },
  });
}

export * from "./budget";
export * from "./estimate";
export * from "./model-gateway";
export * from "./usage";
