/**
 * 通知待ちを1件送る（workerの1ステップ）。
 *
 * 取引の分け方：
 *   1. 取引の中で1件を lease つきで取り出す
 *   2. **取引の外で** `messaging.send` を呼ぶ（HTTP待ちの間ロックを持たない）
 *   3. 取引の中で結果を記録し、打診の状態を更新する
 *
 * 未送信（`SendRefused`）と配送失敗（`FAILED`）を区別する。どちらも
 * `resolveOutreachAfterSend` を通し、届いたと確認できるまで打診を送信待ちに留める
 * （A11）。**一人の送信失敗で案件を閉じない。**
 *
 * 結果不明（`UNKNOWN`）は再送しない。`getSendResult` で照合するまで待つ
 * （AGENTS.md）。そのため outbox の取り出しは `UNKNOWN` を拾わない。
 */

import "server-only";
import type { MessagingGateway, SendRefused, SendResult } from "../contracts/messaging-gateway";
import {
  DELIVERY_NOT_SENT,
  resolveOutreachAfterSend,
  type OutreachMessageKind,
  type SendOutcome,
} from "../contracts/outreach-state";
import type { OutboxRepository, OutboxStatus, OutreachRepository } from "../contracts/repository";
import { withTransaction } from "../adapters/db/transaction";

export interface SendOutboxDeps {
  readonly outbox: OutboxRepository;
  readonly outreaches: OutreachRepository;
  readonly messaging: MessagingGateway;
  /** lease の長さ。送信が終わる前に他のworkerが取り直さない程度に取る。 */
  readonly leaseMs?: number;
  /** 失敗した項目を次に試すまでの待ち。 */
  readonly retryAfterMs?: number;
}

export type SendOutboxOutcome =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly outboxId: string;
      readonly status: OutboxStatus;
      readonly leaseLost: boolean;
    };

/** 返信を待つ送信の種別。 */
const AWAITS_REPLY: readonly OutreachMessageKind[] = ["INITIAL_OFFER", "CLARIFICATION"];

function isRefused(result: SendResult | SendRefused): result is SendRefused {
  return "refused" in result;
}

/** 送信結果を outbox の状態へ写す。未送信と配送失敗を同じ値に畳まない。 */
function statusOf(outcome: SendOutcome): OutboxStatus {
  switch (outcome) {
    case "ACCEPTED":
      return "SENT";
    case "FAILED":
      return "FAILED";
    case "UNKNOWN":
      return "UNKNOWN";
    case "QUEUED":
      return "PENDING";
    case DELIVERY_NOT_SENT:
      return "REFUSED";
  }
}

export function sendOutbox(deps: SendOutboxDeps) {
  const leaseMs = deps.leaseMs ?? 30_000;
  const retryAfterMs = deps.retryAfterMs ?? 10_000;

  return async function runOnce(): Promise<SendOutboxOutcome> {
    const claimed = await withTransaction((tx) => deps.outbox.claimNext(tx, { leaseMs }));
    if (claimed === "NONE") return { handled: false };

    // 宛先は打診時に固定した版をそのまま使う。現在の宛先で上書きしない——
    // 版が変わっていれば送らないのが正しい（A15）。その判定は send の内部で行う。
    const target = await withTransaction(async (tx) => {
      const outreach = claimed.outreachId
        ? await deps.outreaches.findById(tx, claimed.outreachId)
        : "NOT_FOUND";
      return outreach === "NOT_FOUND" ? undefined : outreach;
    });
    if (!target) {
      throw new Error(`通知待ち ${claimed.outboxId} に対応する打診がありません。`);
    }

    // ここから外部作用。取引の外で行う。
    const sent = await deps.messaging.send({
      operation: claimed.operation,
      to: target.endpoint,
      kind: claimed.kind,
      body: claimed.body,
    });

    const outcome: SendOutcome = isRefused(sent) ? DELIVERY_NOT_SENT : sent.state;
    const status = statusOf(outcome);

    const leaseLost = await withTransaction(async (tx) => {
      const settled = await deps.outbox.settle(tx, {
        outboxId: claimed.outboxId,
        leaseToken: claimed.leaseToken ?? "",
        status,
        refusal: isRefused(sent) ? sent.refused : undefined,
        messageId: isRefused(sent) ? undefined : sent.providerMessageId,
        retryAfterMs: status === "FAILED" ? retryAfterMs : undefined,
      });
      if (settled === "LEASE_LOST") return true;

      const outreach = await deps.outreaches.findById(tx, target.outreachId);
      if (outreach !== "NOT_FOUND") {
        const delivered = resolveOutreachAfterSend({ current: outreach.state, outcome });
        if (delivered !== outreach.state) {
          await deps.outreaches.applyTransition(tx, {
            outreachId: outreach.outreachId,
            expectedVersion: outreach.version,
            to: delivered,
          });

          // 受付まで進んだ打診のうち、返信を待つ種別だけを返信待ちへ動かす。
          // 確定通知・非選定通知・募集終了通知は返信を前提にしない。
          // 送信済み（SENT）を飛ばして返信待ちへ直行しない——「受け付けられた」と
          // 「返信を待っている」を一つの遷移に畳むと、遷移表がその区別を失う。
          if (delivered === "SENT" && AWAITS_REPLY.includes(claimed.kind)) {
            await deps.outreaches.applyTransition(tx, {
              outreachId: outreach.outreachId,
              expectedVersion: outreach.version + 1,
              to: "AWAITING_REPLY",
            });
          }
        }
      }
      return false;
    });

    return { handled: true, outboxId: claimed.outboxId, status, leaseLost };
  };
}
