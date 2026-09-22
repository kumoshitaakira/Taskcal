/**
 * 期限に達した案件を止める（RFC-012 §5 A18、ADR-022 / Q13）。
 *
 * workerの1ステップ。1回の呼出しで1件だけ扱う。
 *
 * **判定と実行を分けない。** 「期限を過ぎた案件の一覧」を先に作ってから順に止めると、
 * 一覧を作った後・止める前に正式採用が通った案件まで止めてしまう。1件を
 * `for update skip locked` で取ったまま `stopCase` まで進め、`stopCase` の側でも
 * 停止済みと状態を**同じロックの下で**再検査する。
 *
 * ここで期限そのものを再検査しないのは、操作IDが案件ごとに固定だから。期限前だと
 * いう理由で拒否を保存すると、本当に期限へ達したときに保存済みの拒否が返り続け、
 * その案件を二度と期限停止できなくなる。期限の判定はこの取り出しの `where` が持つ。
 *
 * `withTransaction` は入れ子を検出して外側の取引へ合流する（`transaction.ts`）。
 * `stopCase` は外部作用を持たない（積むだけで送らない）ので、合流して安全。
 */

import "server-only";
import { withTransaction, type Tx } from "../adapters/db/transaction";
import { STOP_CAUSE } from "../contracts/case-state";
import type { Clock } from "../contracts/repository";
import type { StopCaseResult } from "./stop-case";

export type DetectDeadlineOutcome =
  | { readonly handled: false }
  | { readonly handled: true; readonly caseId: string; readonly result: StopCaseResult };

export interface DetectDeadlineDeps {
  readonly stopCase: (command: {
    operationId: string;
    caseId: string;
    cause: typeof STOP_CAUSE.DEADLINE;
  }) => Promise<StopCaseResult>;
  readonly clock: Clock;
}

/**
 * 期限停止の操作ID。案件ごとに一つで、乱数を使わない（ADR-006）。
 *
 * workerが再起動しても同じIDになるため、二度目は保存済み結果を返す。停止できない
 * 案件についても `REFUSED` が保存され、`IN_PROGRESS` のまま塞がらない。
 */
export function deadlineStopOperationId(caseId: string): string {
  return `stop:${caseId}:deadline`;
}

export function detectDeadline(deps: DetectDeadlineDeps) {
  return async function runOnce(): Promise<DetectDeadlineOutcome> {
    const now = deps.clock.now();

    return withTransaction(async (tx: Tx) => {
      const { rows } = await tx.query<{ case_id: string }>(
        `select case_id from absence_case
          where deadline_at <= $1::timestamptz
            and stopped_at is null
            and state in ('COORDINATING', 'PREPARING')
          order by created_at
          for update skip locked
          limit 1`,
        [now],
      );
      const caseId = rows[0]?.case_id;
      if (!caseId) return { handled: false as const };

      // 同じ取引の中で止める。合流するので、ここで取ったロックはそのまま効く。
      const result = await deps.stopCase({
        operationId: deadlineStopOperationId(caseId),
        caseId,
        cause: STOP_CAUSE.DEADLINE,
      });
      return { handled: true as const, caseId, result };
    });
  };
}
