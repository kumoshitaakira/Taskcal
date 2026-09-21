/**
 * 予算台帳（RFC-004 §7 / ADR-007 / D12）。
 *
 * `src/adapters/orca/budget.ts` の `BudgetLedger` を PostgreSQL で実装する。
 *
 * 判定と加算を原子的に行う必要がある（`tryReserve` の契約）。1文にするだけでは
 * 足りない：read committed では同時に走る二本が同じ合計を読み、両方が上限内と
 * 判断して両方とも予約できてしまう。実行単位の advisory lock で直列化してから
 * 1文で判定・登録する。
 *
 * ロックは実行（run）単位の1本だけを取る。複数のロックを取ると順序デッドロックの
 * 余地ができる。
 */

import "server-only";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import type {
  BudgetLedger,
  RequiredBudgetLimits,
  Reservation,
  ReservationResult,
} from "../orca/budget";
import type { CostKind } from "../orca/usage";
import { withTransaction, type Tx } from "./transaction";

const RESERVE_SQL = `
with declared as (
  select $5::bigint as call_limit, $6::bigint as case_limit, $7::bigint as run_limit
), existing as (
  select request_hash from budget_reservation where request_id = $1
), totals as (
  select
    count(*) filter (where case_id = $2::uuid) as case_calls,
    -- 未精算は予約額で数える。精算済みは実費で数える。
    -- 予約だけして未精算のものを0にすると、同時実行が上限を超える。
    coalesce(sum(coalesce(settled_micro_usd, estimated_micro_usd))
             filter (where case_id = $2::uuid), 0) as case_spend,
    coalesce(sum(coalesce(settled_micro_usd, estimated_micro_usd))
             filter (where run_id = $3), 0) as run_spend
  from budget_reservation
), decision as (
  select case
    when exists (select 1 from existing)
      then case when (select request_hash from existing) = $4
                then 'ALREADY_RESERVED' else 'HASH_MISMATCH' end
    when t.case_calls + 1 > d.call_limit then 'EXCEEDED_CALLS'
    when t.case_spend + $8::bigint > d.case_limit then 'EXCEEDED_CASE_SPEND'
    when t.run_spend + $8::bigint > d.run_limit then 'EXCEEDED_RUN_SPEND'
    else 'RESERVED' end as result
  from totals t, declared d
), inserted as (
  insert into budget_reservation
    (request_id, case_id, run_id, request_hash, estimated_micro_usd)
  select $1, $2::uuid, $3, $4, $8::bigint
   where (select result from decision) = 'RESERVED'
  returning 1
)
select (select result from decision) as result, (select count(*) from inserted) as inserted
`;

export function createPgBudgetLedger(): BudgetLedger {
  return {
    async tryReserve(
      reservation: Reservation,
      limits: RequiredBudgetLimits,
    ): Promise<ReservationResult> {
      return withTransaction(
        async (tx: Tx) => {
          // 実行単位で直列化する。hashtextextended は同じ文字列から同じ値を返すため、
          // 別プロセスでも同じロックを取れる。取引の終了で自動的に解放される。
          await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `taskcal.budget.run:${reservation.runId}`,
          ]);
          const { rows } = await tx.query<{ result: ReservationResult }>(RESERVE_SQL, [
            reservation.requestId,
            reservation.caseId,
            reservation.runId,
            reservation.requestHash,
            limits.caseCallLimit,
            limits.caseSpendLimitMicroUsd,
            limits.runSpendLimitMicroUsd,
            reservation.estimatedMicroUsd,
          ]);
          const result = rows[0]?.result;
          if (!result) {
            // 判定SQLは必ず1行返す。返らないのは実装の不具合であり、
            // 予約できたか分からないまま呼出しへ進ませない。
            throw new TaskcalError(
              ERROR_CODES.RECONCILE_REQUIRED,
              "予算の予約結果を取得できませんでした。呼出しを開始しません。",
            );
          }
          return result;
        },
        { lockTimeoutMs: 5_000 },
      );
    },

    async settle(input: {
      requestId: string;
      actualMicroUsd?: number;
      costKind: CostKind;
    }): Promise<void> {
      await withTransaction(async (tx: Tx) => {
        // requestId で冪等。二度目は 0 行更新で無害。
        // 実費が取れない場合は予約額をそのまま残す。**0にしない**
        // （AGENTS.md：タイムアウトや結果不明を費用0として記録しない）。
        await tx.query(
          `update budget_reservation
              set settled_micro_usd = coalesce($2::bigint, estimated_micro_usd),
                  cost_kind = $3,
                  settled_at = now()
            where request_id = $1 and settled_at is null`,
          [input.requestId, input.actualMicroUsd ?? null, input.costKind],
        );
      });
    },
  };
}
