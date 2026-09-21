/**
 * 接続情報が無いときの ModelGateway。
 *
 * 2026-09-21時点でOrcaRouterのAPIキー・接続先・単価は未取得（docs/OPEN-QUESTIONS.md
 * 「外部情報の確認」）。疑似的な解釈結果を返すと、動いていない機能を動いている
 * ように見せることになるため、新規の呼出しは明示的に失敗させる。
 *
 * ただし**保存済み結果の再生は許す**。初回呼出しが `saveResult` まで終わっていれば、
 * その解釈は確定していて外部呼出しを要しない。worker再起動時に一時的にキーが
 * 欠けただけで、確定済みの結果まで `NOT_CONFIGURED` で止めると、永続化した
 * イベントの復旧が設定の復元まで進まない（AGENTS.md：保存済み結果を返すか照合する）。
 */

import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import { modelReplyOutputSchema } from "@/contracts/model-output";
import type { BudgetGuard, ModelCallStore } from "./budget";
import type { InterpretReplyRequest, InterpretReplyResponse, ModelGateway } from "./model-gateway";
import { InvalidModelOutputError, UnknownOutcomeError } from "./orca-client";

export class UnconfiguredModelGateway implements ModelGateway {
  constructor(
    private readonly callStore?: ModelCallStore,
    /**
     * 再生時の精算に使う。接続情報が無くても、**すでに発生した費用の精算は
     * 行える**。未精算の予約が残ると、条件を満たしているのに後続の呼出しを
     * 上限で止めてしまう（D12に反する止まり方）。
     */
    private readonly budget?: BudgetGuard,
  ) {}

  isConfigured(): boolean {
    return false;
  }

  async interpretReply(request: InterpretReplyRequest): Promise<InterpretReplyResponse> {
    const stored = await this.callStore?.findResult(request.requestId);

    if (stored === undefined || stored === "NO_RESULT") {
      // 保存済み結果が無い。新規の呼出しになるため止める。
      throw new TaskcalError(
        ERROR_CODES.NOT_CONFIGURED,
        "OrcaRouterの接続情報が未設定です。実推論は行いません（模擬結果も返しません）。",
      );
    }

    if (stored.requestHash !== request.requestHash) {
      throw new TaskcalError(
        ERROR_CODES.OPERATION_CONFLICT,
        "同じ request_id で内容が異なる要求です。拒否します。",
      );
    }

    // 保存後・精算前に停止していた可能性がある。OrcaRouterClient の再生経路と
    // 同じく、保存済みusageで精算をやり直す（settle は requestId で冪等）。
    await this.budget?.settle({
      requestId: request.requestId,
      actualMicroUsd: stored.usage.costMicroUsd,
      costKind: stored.usage.costKind,
    });

    // 以降の判断も OrcaRouterClient の再生経路と同じにする。
    if (stored.outcome === "SCHEMA_INVALID") {
      throw new InvalidModelOutputError(
        stored.usage,
        "モデル出力がschemaに一致しません（保存済みの結果）。承諾として扱いません。",
      );
    }
    if (stored.outcome === "UNKNOWN") {
      throw new UnknownOutcomeError(
        stored.usage,
        "前回の呼出しの結果が不明のままです（保存済みの記録）。再送しません。",
      );
    }

    const replayed = modelReplyOutputSchema.safeParse(stored.output);
    if (!replayed.success) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        "保存済みの呼出し結果がschemaに一致しません。人の対応へ回します。",
      );
    }
    return {
      output: replayed.data,
      usage: stored.usage,
      maskedReplyText: stored.maskedReplyText,
    };
  }
}
