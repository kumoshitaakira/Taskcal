/**
 * 通知待ち（outbox）の永続化。
 *
 * 送信は取引の外で行う。取引の中では積むだけ（RFC-010 §5：外部API待ちを取引に
 * 入れない）。取り出しは `for update skip locked` ＋ lease で、同じ項目を二つの
 * workerが同時に送らないようにする。
 *
 * **`UNKNOWN` と `FAILED` は取り出さない。** 結果不明を失敗として扱わず、`getSendResult`
 * で照合するまで再送しない（AGENTS.md）。配送失敗も自動では再送しない——同じ内容の
 * 再送は保存済み結果を返すだけで結果が変わらず、取り出し続けると worker が空回りする。
 * どちらの復旧も照合の経路が要る（未実装）。
 */

import "server-only";
import type {
  OutboxItem,
  OutboxRepository,
  OutboxStatus,
  TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

interface OutboxRow {
  readonly outbox_id: string;
  readonly case_id: string;
  readonly outreach_id: string | null;
  readonly kind: OutboxItem["kind"];
  readonly body: string;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly connection_id: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly lease_token: string | null;
}

const COLUMNS = `outbox_id, case_id, outreach_id, kind, body, operation_id, request_hash,
  connection_id, status, attempts, lease_token`;

function toItem(row: OutboxRow): OutboxItem {
  return {
    outboxId: row.outbox_id,
    caseId: row.case_id,
    outreachId: row.outreach_id ?? undefined,
    kind: row.kind,
    body: row.body,
    operation: { operationId: row.operation_id, requestHash: row.request_hash },
    connectionId: row.connection_id,
    status: row.status,
    attempts: row.attempts,
    leaseToken: row.lease_token ?? undefined,
  };
}

export function createPgOutboxRepository(): OutboxRepository {
  return {
    async enqueue(handle: TxHandle, input) {
      const tx = handle as Tx;
      await tx.query(
        `insert into notification_outbox
           (outbox_id, case_id, outreach_id, kind, body, operation_id, request_hash, connection_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (operation_id) do nothing`,
        [
          input.outboxId,
          input.caseId,
          input.outreachId ?? null,
          input.kind,
          input.body,
          input.operation.operationId,
          input.operation.requestHash,
          input.connectionId,
        ],
      );
    },

    async claimNext(handle: TxHandle, input) {
      const tx = handle as Tx;
      const { rows } = await tx.query<OutboxRow>(
        `update notification_outbox o
            set leased_until = now() + make_interval(secs => $1::double precision / 1000),
                lease_token = gen_random_uuid(),
                attempts = attempts + 1
          where o.outbox_id = (
            select outbox_id from notification_outbox
             -- FAILED と UNKNOWN は取り出さない。同じ内容の再送は保存済み結果を
             -- 返すだけで結果が変わらず、取り出し続けると worker が空回りする。
             -- 復旧は照合の経路（未実装）が入ってから行う。
             where status = 'PENDING'
               and next_attempt_at <= now()
               and (leased_until is null or leased_until < now())
             order by created_at
             for update skip locked
             limit 1)
        returning ${COLUMNS}`,
        [input.leaseMs],
      );
      const row = rows[0];
      return row ? toItem(row) : ("NONE" as const);
    },

    async settle(handle: TxHandle, input) {
      const tx = handle as Tx;
      const { rowCount } = await tx.query(
        `update notification_outbox
            set status = $3,
                refusal = $4,
                message_id = coalesce($5, message_id),
                leased_until = null,
                lease_token = null,
                next_attempt_at = case
                  when $6::int is null then next_attempt_at
                  else now() + make_interval(secs => $6::double precision / 1000)
                end
          where outbox_id = $1 and lease_token = $2`,
        [
          input.outboxId,
          input.leaseToken,
          input.status,
          input.refusal ?? null,
          input.messageId ?? null,
          input.retryAfterMs ?? null,
        ],
      );
      // lease が失効して他のworkerが取り直した場合。結果を握り潰さず呼出し元へ返す。
      return rowCount === 1 ? "UPDATED" : "LEASE_LOST";
    },

    async listByCase(handle: TxHandle, caseId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<OutboxRow>(
        `select ${COLUMNS} from notification_outbox where case_id = $1
          order by created_at, outbox_id`,
        [caseId],
      );
      return rows.map(toItem);
    },
  };
}
