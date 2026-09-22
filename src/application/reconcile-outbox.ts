/**
 * 結果不明で終わった通知を照合する（workerの1ステップ、RFC-012 §5 A13・A03）。
 *
 * 取引の分け方は `send-outbox.ts` と同じ三つ：
 *   1. 取引の中で `UNKNOWN` の項目を1件 lease つきで取り出す
 *   2. **取引の外で** `messaging.getSendResult` を呼ぶ
 *   3. 取引の中で結果を記録し、打診の状態を更新する
 *
 * **再送しない。** 送られたかどうかを照会して確かめ、確かめられた場合だけ状態を
 * 動かす。`LOOKUP_UNAVAILABLE`／`CONFLICT` は「照会できなかった」であって
 * 「送られていない」ではない。**未送信と読み替えない。** 読み替えると、届いた
 * 募集終了通知をもう一度送ることになる。
 *
 * 配送失敗（`FAILED`）はここでは扱わない。同じ `operation_id` での再送は
 * `operation_result` に保存済みの失敗を `REPLAY` で返すだけで、結果が変わらない。
 * 本当の再送には attempt を含む操作IDが要る（未実装。README「動かないもの」）。
 */

import "server-only";
import { RECOVERY_RETRY_MS } from "../config/mvp-policy";
import { assertOutsideTransaction, withTransaction } from "../adapters/db/transaction";
import type { MessagingGateway } from "../contracts/messaging-gateway";
import { resolveOutreachAfterSend, type OutreachMessageKind } from "../contracts/outreach-state";
import type { OutboxRepository, OutboxStatus, OutreachRepository } from "../contracts/repository";

export interface ReconcileOutboxDeps {
  readonly outbox: OutboxRepository;
  readonly outreaches: OutreachRepository;
  readonly messaging: MessagingGateway;
  readonly leaseMs?: number;
  /** 照会できなかった項目を次に見るまでの待ち。先頭詰まりを避ける。 */
  readonly retryAfterMs?: number;
}

/**
 * `finding` は照会で何が分かったかであって、通知の新しい状態ではない。
 * `UNRESOLVED` のときは状態を動かさない——動かした先が無いのではなく、
 * 断定できる事実が無い。
 */
export type ReconcileFindingKind = "ACCEPTED" | "NOT_SENT" | "FAILED" | "UNRESOLVED";

export type ReconcileOutboxOutcome =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly outboxId: string;
      readonly finding: ReconcileFindingKind;
      readonly status: OutboxStatus;
      readonly leaseLost: boolean;
      readonly transitionConflict: boolean;
    };

/** 返信を待つ送信の種別。`send-outbox.ts` と同じ。 */
const AWAITS_REPLY: readonly OutreachMessageKind[] = ["INITIAL_OFFER", "CLARIFICATION"];

export function reconcileOutbox(deps: ReconcileOutboxDeps) {
  const leaseMs = deps.leaseMs ?? 30_000;
  const retryAfterMs = deps.retryAfterMs ?? RECOVERY_RETRY_MS;

  return async function runOnce(): Promise<ReconcileOutboxOutcome> {
    const claimed = await withTransaction((tx) => deps.outbox.claimForReconcile(tx, { leaseMs }));
    if (claimed === "NONE") return { handled: false };

    // 照会は provider と接続範囲で絞る（A15）。宛先は打診時に固定した版をそのまま使う。
    const target = await withTransaction(async (tx) => {
      const outreach = claimed.outreachId
        ? await deps.outreaches.findById(tx, claimed.outreachId)
        : "NOT_FOUND";
      return outreach === "NOT_FOUND" ? undefined : outreach;
    });
    if (!target) {
      // どの接続へ送ったか特定できない。照会範囲を推測しない（A15）。
      throw new Error(`通知待ち ${claimed.outboxId} に対応する打診がありません。`);
    }

    // 照会も外部作用。取引の外で行う（RFC-010 §5）。
    assertOutsideTransaction("送信結果の照会");
    const found = await deps.messaging.getSendResult({
      operationId: claimed.operation.operationId,
      provider: target.endpoint.provider,
      connectionId: claimed.connectionId,
      // 内容ハッシュまで一致を求める。宛先だけ差し替えた別の送信を同じ操作と
      // 読まない（A15 / D07）。
      expectedRequestHash: claimed.operation.requestHash,
    });

    let finding: ReconcileFindingKind;
    if (found === "LOOKUP_UNAVAILABLE" || found === "CONFLICT") {
      // 照会できなかった。**未送信と読み替えない。**
      finding = "UNRESOLVED";
    } else if (found.state === "ACCEPTED") {
      finding = "ACCEPTED";
    } else if (found.state === "FAILED") {
      finding = "FAILED";
    } else if (found.state === "QUEUED" && found.match === "NEW") {
      // 送信の記録そのものが無い。送られていないと確認できた。
      finding = "NOT_SENT";
    } else {
      // QUEUED の再掲、または UNKNOWN のまま。まだ確定していない。
      finding = "UNRESOLVED";
    }

    if (finding === "UNRESOLVED") {
      // 状態を動かさない。**ただし次に見る時刻は先送りする。**
      // lease を返すだけだと、照会できないこの項目が毎回最古として選び直され、
      // 後ろの結果不明が永久に照合されない（先頭詰まり）。
      const leaseLost = await withTransaction(async (tx) => {
        const settled = await deps.outbox.settle(tx, {
          outboxId: claimed.outboxId,
          leaseToken: claimed.leaseToken ?? "",
          status: "UNKNOWN",
          retryAfterMs,
        });
        return settled === "LEASE_LOST";
      });
      return {
        handled: true,
        outboxId: claimed.outboxId,
        finding,
        status: "UNKNOWN",
        leaseLost,
        transitionConflict: false,
      };
    }

    const status: OutboxStatus =
      finding === "ACCEPTED" ? "SENT" : finding === "NOT_SENT" ? "PENDING" : "FAILED";
    const messageId =
      finding === "ACCEPTED" && found !== "LOOKUP_UNAVAILABLE" && found !== "CONFLICT"
        ? found.providerMessageId
        : undefined;

    let transitionConflict = false;
    const leaseLost = await withTransaction(async (tx) => {
      const settled = await deps.outbox.settle(tx, {
        outboxId: claimed.outboxId,
        leaseToken: claimed.leaseToken ?? "",
        status,
        messageId,
      });
      if (settled === "LEASE_LOST") return true;
      if (finding !== "ACCEPTED" || !claimed.outreachId) return false;

      // 届いたと確認できた。ここで初めて打診を進める。`send-outbox.ts` と同じ
      // 解決関数を通す——照合経路だけ別の規則で動かすと、遷移表が二重になる。
      const outreach = await deps.outreaches.findById(tx, claimed.outreachId);
      if (outreach === "NOT_FOUND") return false;
      const delivered = resolveOutreachAfterSend({ current: outreach.state, outcome: "ACCEPTED" });
      if (delivered === outreach.state) return false;

      const moved = await deps.outreaches.applyTransition(tx, {
        outreachId: outreach.outreachId,
        expectedVersion: outreach.version,
        to: delivered,
      });
      if (moved === "VERSION_CONFLICT") {
        transitionConflict = true;
        return false;
      }
      if (delivered === "SENT" && AWAITS_REPLY.includes(claimed.kind)) {
        const awaited = await deps.outreaches.applyTransition(tx, {
          outreachId: outreach.outreachId,
          expectedVersion: outreach.version + 1,
          to: "AWAITING_REPLY",
        });
        if (awaited === "VERSION_CONFLICT") transitionConflict = true;
      }
      return false;
    });

    return {
      handled: true,
      outboxId: claimed.outboxId,
      finding,
      status,
      leaseLost,
      transitionConflict,
    };
  };
}
