/**
 * 未処理の返信を1件だけ解釈する（workerの1ステップ）。
 *
 * **モデルが未設定なら何もしない。** 未設定のまま回すと、1件ごとに
 * `NOT_CONFIGURED` を記録し続けることになる。未設定であることは
 * `/api/health` と画面の「未実装」に出ているので、ここでは静かに止まる。
 *
 * 取り出しは受信順の昇順。古い返信から順に適用する（RFC-011 §4）。
 */

import "server-only";
import { withTransaction } from "../adapters/db/transaction";
import type { ModelGateway } from "../adapters/orca/model-gateway";
import type { interpretReply } from "./interpret-reply";

export interface InterpretPendingDeps {
  readonly model: ModelGateway;
  readonly interpret: ReturnType<typeof interpretReply>;
}

export type InterpretPendingOutcome =
  | { readonly handled: false; readonly reason: "NOT_CONFIGURED" | "NONE" }
  | { readonly handled: true; readonly inboundEventId: string };

export function interpretPending(deps: InterpretPendingDeps) {
  return async function runOnce(): Promise<InterpretPendingOutcome> {
    if (!deps.model.isConfigured()) return { handled: false, reason: "NOT_CONFIGURED" };

    const next = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ inbound_event_id: string }>(
        `select e.inbound_event_id
           from inbound_event e
           join outreach o on o.outreach_id = e.outreach_id
           join absence_case c on c.case_id = e.case_id
          where e.received_seq > o.last_applied_seq
            and e.body is not null
            and c.stopped_at is null
          order by e.received_seq
          limit 1`,
      );
      return rows[0]?.inbound_event_id;
    });

    if (!next) return { handled: false, reason: "NONE" };
    await deps.interpret({ inboundEventId: next });
    return { handled: true, inboundEventId: next };
  };
}
