/**
 * 未処理の返信を1件だけ解釈する（workerの1ステップ）。
 *
 * **「適用していない」と「これ以上自動では進められない」を分ける。**
 * 解釈が失敗しても受信順は進めない（適用していないものを適用済みにしないため：A12）。
 * しかしそれだけだと、同じ受信を毎ティック選び直し、後ろに並んだ他のスタッフの返信を
 * 永久に処理できない。失敗した受信は保留の印を付けて取り出し対象から外す。
 *
 * **モデルが未設定でも呼ぶ。** `UnconfiguredModelGateway` は保存済み結果を再生する。
 * 呼び出す前に設定を見て止めると、課金済みで保存された結果が永久に適用されない。
 * 新規の呼出しはgateway側が `NOT_CONFIGURED` で止める。
 */

import "server-only";
import { withTransaction } from "../adapters/db/transaction";
import type { ModelGateway } from "../adapters/orca/model-gateway";
import { ERROR_CODES, TaskcalError, type ErrorCode } from "../contracts/errors";
import type { InboundEventRepository, InterpretationApplication } from "../contracts/repository";
import type { interpretReply } from "./interpret-reply";

export interface InterpretPendingDeps {
  readonly model: ModelGateway;
  readonly inbound: InboundEventRepository;
  readonly interpret: ReturnType<typeof interpretReply>;
}

export type InterpretPendingOutcome =
  | { readonly handled: false; readonly reason: "NONE" }
  | {
      readonly handled: true;
      readonly inboundEventId: string;
      readonly applied: InterpretationApplication;
    }
  | {
      readonly handled: true;
      readonly inboundEventId: string;
      /** 自動では進められないので取り出し対象から外した。 */
      readonly blocked: ErrorCode;
    };

/**
 * 設定が戻ったら、設定が理由の保留だけを戻す。
 *
 * 他の理由（予算超過・結果不明）は自動で戻さない。**戻す条件が別**で、
 * 人の判断か照合が要る（未実装）。ここでまとめて戻すと、止めた理由を無視して
 * 同じ失敗を繰り返す。
 */
async function releaseConfigurationBlocks(deps: InterpretPendingDeps): Promise<number> {
  if (!deps.model.isConfigured()) return 0;
  return withTransaction((tx) =>
    deps.inbound.clearBlocked(tx, { reason: ERROR_CODES.NOT_CONFIGURED }),
  );
}

export function interpretPending(deps: InterpretPendingDeps) {
  let releasedOnce = false;

  return async function runOnce(): Promise<InterpretPendingOutcome> {
    if (!releasedOnce) {
      await releaseConfigurationBlocks(deps);
      releasedOnce = true;
    }

    const next = await withTransaction((tx) => deps.inbound.findNextInterpretable(tx));
    if (next === "NONE") return { handled: false, reason: "NONE" };

    // 例外も保留へ変換する。**素通りさせない。**
    // Gatewayのタイムアウト（結果不明）や契約違反の出力は例外で返る。抜けると
    // 保留が付かず、同じ受信を選び続けて後続のスタッフの返信が処理できない。
    let result: Awaited<ReturnType<typeof deps.interpret>>;
    try {
      result = await deps.interpret({ inboundEventId: next });
    } catch (error) {
      // 意味のある失敗（TaskcalError）はその意味のまま保留にする。
      // それ以外は何が起きたか分からないので、確定失敗と断定せず人の対応へ回す。
      const reason = error instanceof TaskcalError ? error.code : ERROR_CODES.RECONCILE_REQUIRED;
      await withTransaction((tx) => deps.inbound.markBlocked(tx, { inboundEventId: next, reason }));
      return { handled: true, inboundEventId: next, blocked: reason };
    }

    if (result.ok) {
      return { handled: true, inboundEventId: next, applied: result.applied };
    }

    // 失敗。受信順は進めないが、取り出し対象からは外す。理由を残して後から追える
    // ようにする。設定が理由の保留は、設定が戻ったときにだけ自動で戻す。
    await withTransaction((tx) =>
      deps.inbound.markBlocked(tx, { inboundEventId: next, reason: result.code }),
    );
    return { handled: true, inboundEventId: next, blocked: result.code };
  };
}
