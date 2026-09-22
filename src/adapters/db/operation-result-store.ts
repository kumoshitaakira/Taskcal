/**
 * 操作結果の保存（ADR-006 / RFC-009 D07）。
 *
 * 同じ操作IDで内容が異なれば拒否し、同一内容なら保存済み結果を返す。判定と登録を
 * 1文で行う——先に select して後で insert すると、その間に別の実行が入り込み、
 * 二つの経路が同時に「新規」と判断する。
 */

import "server-only";
import type {
  OperationKind,
  OperationResultStore,
  OperationStatus,
  StoredOperationResult,
} from "../../contracts/repository";
import { OPERATION_MATCH } from "../../contracts/operation";
import type { Tx } from "./transaction";

interface BeginRow {
  readonly operation_id: string;
  readonly status: OperationStatus;
  readonly result: unknown;
  readonly inserted: boolean;
}

export function createPgOperationResultStore(): OperationResultStore {
  return {
    async begin(handle, input) {
      const tx = handle as Tx;
      // on conflict の where が偽になると更新対象が無く、0行が返る。
      // これが「同じIDで内容が違う」＝ CONFLICT。
      // xmax = 0 は、この文が挿入した行であることを示す（＝新規）。
      const { rows } = await tx.query<BeginRow>(
        `insert into operation_result
           (operation_id, request_hash, operation_kind, connection_id, case_id, status)
         values ($1, $2, $3, $4, $5, 'IN_PROGRESS')
         on conflict (operation_id) do update set updated_at = now()
          where operation_result.request_hash = excluded.request_hash
         returning operation_id, status, result, (xmax = 0) as inserted`,
        [
          input.operation.operationId,
          input.operation.requestHash,
          input.kind satisfies OperationKind,
          input.connectionId ?? null,
          input.caseId ?? null,
        ],
      );

      const row = rows[0];
      if (!row) {
        return { match: OPERATION_MATCH.CONFLICT };
      }
      if (row.inserted) {
        return { match: OPERATION_MATCH.NEW };
      }
      const stored: StoredOperationResult = {
        operationId: row.operation_id,
        status: row.status,
        result: row.result,
      };
      return { match: OPERATION_MATCH.REPLAY, stored };
    },

    async findById(handle, operationId) {
      const tx = handle as Tx;
      const { rows } = await tx.query<{
        operation_id: string;
        status: StoredOperationResult["status"];
        result: unknown;
      }>(`select operation_id, status, result from operation_result where operation_id = $1`, [
        operationId,
      ]);
      const row = rows[0];
      if (!row) return "NOT_FOUND";
      return { operationId: row.operation_id, status: row.status, result: row.result };
    },

    async complete(handle, input) {
      const tx = handle as Tx;
      // 内容ハッシュは触らない。書き換えはトリガが拒否する。
      await tx.query(
        `update operation_result set status = $2, result = $3, updated_at = now()
          where operation_id = $1`,
        [input.operationId, input.status, JSON.stringify(input.result ?? null)],
      );
    },
  };
}
