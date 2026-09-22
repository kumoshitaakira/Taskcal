import { OPERATION_MATCH, type OperationMatch, type RequestHash } from "@/contracts/operation";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import {
  EXTERNAL_ATTEMPT_DECISION,
  OUTBOUND_OPERATION_STATE,
  type ExternalAttemptDecision,
  type OutboundOperationState,
} from "./types";

/**
 * DBから取得した操作と、新しく受け取った要求を比較する。
 *
 * 一意制約は「同じIDの行が2つできない」ことだけを守るため、同じIDで異なる
 * requestHashを拒否する意味判断はrepository境界で明示的に行う。
 */
export function matchStoredRequest(
  storedRequestHash: RequestHash | undefined,
  requestedRequestHash: RequestHash,
): OperationMatch {
  if (storedRequestHash === undefined) {
    return OPERATION_MATCH.NEW;
  }
  if (storedRequestHash === requestedRequestHash) {
    return OPERATION_MATCH.REPLAY;
  }
  throw new TaskcalError(
    ERROR_CODES.OPERATION_CONFLICT,
    "同じoperationIdで内容が異なる要求です。保存済み結果を照合してください。",
  );
}

/** 外部作用を開始してよいかを、保存済み状態から決める。providerは呼ばない。 */
export function decideExternalAttempt(
  state: OutboundOperationState,
  storedRequestHash: RequestHash,
  requestedRequestHash: RequestHash,
): ExternalAttemptDecision {
  matchStoredRequest(storedRequestHash, requestedRequestHash);

  switch (state) {
    case OUTBOUND_OPERATION_STATE.NEW:
      return EXTERNAL_ATTEMPT_DECISION.START;
    case OUTBOUND_OPERATION_STATE.IN_FLIGHT:
    case OUTBOUND_OPERATION_STATE.UNKNOWN:
    case OUTBOUND_OPERATION_STATE.RECONCILE_REQUIRED:
      return EXTERNAL_ATTEMPT_DECISION.LOOKUP_REQUIRED;
    case OUTBOUND_OPERATION_STATE.ACCEPTED:
    case OUTBOUND_OPERATION_STATE.FAILED:
      return EXTERNAL_ATTEMPT_DECISION.REPLAY;
  }
}

export function isAllowedOutboundTransition(
  from: OutboundOperationState,
  to: OutboundOperationState,
): boolean {
  // 同じ状態の同一結果はcaller側のREPLAY判定を通る。内容が違う同状態の結果は
  // 新しい事実として上書きせず、照合待ちへ回す。
  if (from === to) return false;
  switch (from) {
    case OUTBOUND_OPERATION_STATE.NEW:
      return to === OUTBOUND_OPERATION_STATE.IN_FLIGHT;
    case OUTBOUND_OPERATION_STATE.IN_FLIGHT:
    case OUTBOUND_OPERATION_STATE.UNKNOWN:
      return (
        to === OUTBOUND_OPERATION_STATE.ACCEPTED ||
        to === OUTBOUND_OPERATION_STATE.FAILED ||
        to === OUTBOUND_OPERATION_STATE.UNKNOWN ||
        to === OUTBOUND_OPERATION_STATE.RECONCILE_REQUIRED
      );
    case OUTBOUND_OPERATION_STATE.RECONCILE_REQUIRED:
      return to === OUTBOUND_OPERATION_STATE.ACCEPTED || to === OUTBOUND_OPERATION_STATE.FAILED;
    case OUTBOUND_OPERATION_STATE.ACCEPTED:
    case OUTBOUND_OPERATION_STATE.FAILED:
      return false;
  }
}
