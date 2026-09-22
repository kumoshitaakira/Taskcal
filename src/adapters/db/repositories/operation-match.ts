import { OPERATION_MATCH, type OperationMatch, type RequestHash } from "@/contracts/operation";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";

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
