/**
 * テスト用の `ModelGateway`。
 *
 * **`src/` へ置かない。** 置くと本番の合成の根へ混入し得る。`UnconfiguredModelGateway`
 * が模擬結果を返さない方針と揃える（AGENTS.md：決定的テストと実モデル評価を分ける）。
 *
 * これはモデルの品質を確かめるものではない。決定的検査・状態遷移・冪等性を確かめる
 * ために、モデル出力を固定するだけ。**実モデルの合格の代わりにしない。**
 */

import type { ModelGateway } from "@/adapters/orca/model-gateway";
import type { ModelReplyOutput } from "@/contracts/model-output";

export interface FakeModelGatewayOptions {
  /** requestId ごとの応答。未登録の requestId は `fallback` を使う。 */
  readonly scripted?: Map<string, ModelReplyOutput | Error>;
  readonly fallback?: ModelReplyOutput | Error;
  readonly configured?: boolean;
}

export interface FakeModelGateway extends ModelGateway {
  /** 呼び出された requestId。再試行や再送を数えるために使う。 */
  readonly calls: readonly string[];
}

export function createFakeModelGateway(options: FakeModelGatewayOptions = {}): FakeModelGateway {
  const calls: string[] = [];
  return {
    calls,
    isConfigured: () => options.configured ?? true,
    async interpretReply(request) {
      calls.push(request.requestId);
      const scripted = options.scripted?.get(request.requestId) ?? options.fallback;
      if (!scripted) {
        throw new Error(`fake: ${request.requestId} の応答が登録されていません。`);
      }
      if (scripted instanceof Error) throw scripted;
      return {
        output: scripted,
        maskedReplyText: request.replyText,
        usage: {
          requestId: request.requestId,
          caseId: request.caseId,
          runId: request.runId,
          step: request.step,
          outcome: "SUCCEEDED",
          modelMeasurement: "UNKNOWN",
          routingSource: "UNKNOWN",
          promptVersion: request.promptVersion,
          rulesVersion: "fake",
          tokenMeasurement: "UNKNOWN",
          // 実測ではない。fake の実行を費用の実績として記録しない。
          costKind: "ESTIMATED",
          validationResult: "VALID",
          startedAt: "2026-09-21T00:00:00.000Z",
          finishedAt: "2026-09-21T00:00:01.000Z",
        },
      };
    },
  };
}

/** よく使う応答の組み立て。根拠spanは本文長に収まる範囲で入れる。 */
export function replyOutput(input: {
  intent: ModelReplyOutput["interpretation"]["intent"];
  ranges?: { startAt: string; endAt: string }[];
  unresolved?: string[];
  action?: ModelReplyOutput["proposedAction"];
}): ModelReplyOutput {
  return {
    interpretation: {
      extractionRuleVersion: "fake/1",
      intent: input.intent,
      offeredRanges: input.ranges ?? [],
      unresolvedConditions: input.unresolved ?? [],
      evidenceSpans: input.intent === "UNCLEAR" ? [] : [{ start: 0, end: 1 }],
    },
    proposedAction: input.action ?? "NO_ACTION",
  };
}
