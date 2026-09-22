/**
 * モデル呼出し結果の保存（RFC-004、ADR-006）。
 *
 * `src/adapters/orca/budget.ts` の `ModelCallStore` を PostgreSQL で実装する。
 *
 * 保存済み結果を上書きしない。上書きすると、同じ requestId の再生が呼ぶたびに
 * 違う結果を返し、冪等性が崩れる。schema不正・結果不明も**確定した記録**として
 * 保存する——保存しないと、課金され得る呼出しを再試行のたびに繰り返す。
 */

import "server-only";
import type { ModelCallStore, StoredModelCall } from "../orca/budget";
import type { UsageRecord } from "../orca/usage";
import { withTransaction, type Tx } from "./transaction";

interface CallRow {
  readonly request_hash: string;
  readonly outcome: StoredModelCall["outcome"];
  readonly output: unknown;
  readonly usage: UsageRecord;
  readonly masked_reply_text: string;
}

export function createPgModelCallStore(): ModelCallStore {
  return {
    async findResult(requestId: string): Promise<StoredModelCall | "NO_RESULT"> {
      return withTransaction(async (tx: Tx) => {
        const { rows } = await tx.query<CallRow>(
          `select request_hash, outcome, output, usage, masked_reply_text
             from model_call where request_id = $1`,
          [requestId],
        );
        const row = rows[0];
        if (!row) return "NO_RESULT";
        return {
          requestId,
          requestHash: row.request_hash,
          outcome: row.outcome,
          // VALID 以外は output を持たない（制約で対にしてある）。
          output: row.output ?? undefined,
          usage: row.usage,
          maskedReplyText: row.masked_reply_text,
        };
      });
    },

    async saveResult(call: StoredModelCall): Promise<void> {
      await withTransaction(async (tx: Tx) => {
        await tx.query(
          `insert into model_call
             (request_id, request_hash, case_id, run_id, step, outcome,
              output, usage, masked_reply_text)
           values ($1, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
           on conflict (request_id) do nothing`,
          [
            call.requestId,
            call.requestHash,
            call.usage.caseId,
            call.usage.runId,
            call.usage.step,
            call.outcome,
            call.output === undefined ? null : JSON.stringify(call.output),
            JSON.stringify(call.usage),
            call.maskedReplyText,
          ],
        );
      });
    },
  };
}
