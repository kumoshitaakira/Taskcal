/**
 * 受信イベントの取り込み（RFC-011 §4・§6）。
 *
 * **モデルを呼ばない。** 受信はモデル処理の前に永続化する。返信順は永続化した
 * 受信順で決める（A12）。解釈は別のステップ。
 *
 * 本人性の判定：打診時に固定した宛先（provider / connectionId / endpointKey / 版）と
 * **丸ごと一致**した場合だけ `VERIFIED_OUTREACH_TARGET`。版が変わっていれば一致とは
 * しない（A15）。受信本文で名乗った staffId は使わない。
 *
 * 本人と確認できない受信も**捨てない**。案件に結び付けずに保存し、画面に出す。
 * 「承諾として採用しない」と「返信を無視する」は別（Q09）。
 */

import "server-only";
import { ERROR_CODES, type ErrorCode } from "../contracts/errors";
import type { InboundEvent } from "../contracts/messaging-gateway";
import {
  resolveOutreachAfterInbound,
  SENDER_IDENTITY,
  type SenderIdentity,
} from "../contracts/outreach-state";
import type {
  InboundEventRepository,
  OutreachRepository,
  PersistInboundResult,
} from "../contracts/repository";
import { withTransaction } from "../adapters/db/transaction";

export type ReceiveInboundEventResult =
  | {
      readonly ok: true;
      readonly match: "NEW" | "DUPLICATE";
      readonly senderIdentity: SenderIdentity;
      readonly caseId?: string;
      readonly receivedSeq?: number;
      readonly inboundEventId: string;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

export interface ReceiveInboundEventDeps {
  readonly inbound: InboundEventRepository;
  readonly outreaches: OutreachRepository;
}

function summarize(stored: PersistInboundResult, identity: SenderIdentity) {
  return stored.linked
    ? {
        ok: true as const,
        match: stored.match,
        senderIdentity: identity,
        caseId: stored.stored.caseId,
        receivedSeq: stored.stored.receivedSeq,
        inboundEventId: stored.inboundEventId,
      }
    : {
        ok: true as const,
        match: stored.match,
        senderIdentity: identity,
        inboundEventId: stored.inboundEventId,
      };
}

export function receiveInboundEvent(deps: ReceiveInboundEventDeps) {
  return async function run(event: InboundEvent): Promise<ReceiveInboundEventResult> {
    if (!event.eventId || !event.provider || !event.connectionId) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_INPUT,
        detail: "受信イベントの識別子が不正です。",
      };
    }

    return withTransaction(async (tx) => {
      const outreach = await deps.outreaches.findByEndpoint(tx, event.from);
      const identity: SenderIdentity =
        outreach === "NOT_FOUND"
          ? SENDER_IDENTITY.UNMATCHED
          : SENDER_IDENTITY.VERIFIED_OUTREACH_TARGET;

      const stored = await deps.inbound.persist(tx, event, {
        caseId: outreach === "NOT_FOUND" ? undefined : outreach.caseId,
        outreachId: outreach === "NOT_FOUND" ? undefined : outreach.outreachId,
        senderIdentity: identity,
      });

      // 重複は採番も状態も動かさない。二度目の返信として数えない。
      if (stored.match === "DUPLICATE" || outreach === "NOT_FOUND") {
        return summarize(stored, identity);
      }

      const next = resolveOutreachAfterInbound({
        current: outreach.state,
        senderIdentity: identity,
        hasBody: Boolean(event.body && event.body.length > 0),
      });
      if (next !== outreach.state) {
        await deps.outreaches.applyTransition(tx, {
          outreachId: outreach.outreachId,
          expectedVersion: outreach.version,
          to: next,
        });
      }

      return summarize(stored, identity);
    });
  };
}
