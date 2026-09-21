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
import { ERROR_CODES, TaskcalError, type ErrorCode } from "../contracts/errors";
import type { ContactEndpointRef, InboundEvent } from "../contracts/messaging-gateway";
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

/** 宛先が丸ごと一致するか。provider・接続・キー・版のどれが欠けても本人とみなさない。 */
function sameEndpoint(a: ContactEndpointRef, b: ContactEndpointRef): boolean {
  return (
    a.provider === b.provider &&
    a.connectionId === b.connectionId &&
    a.endpointKey === b.endpointKey &&
    a.endpointVersion === b.endpointVersion
  );
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
      // 返信対象の不変参照から打診を引く（RFC-011 §3）。
      //
      // **宛先だけで逆引きしない。** 同じ相手へ過去の案件でも打診していると、
      // 古い打診への返信を現在の案件の承諾として扱ってしまう。スタッフ画面には
      // 過去のメッセージも残るので、実際に起こり得る。
      const target = event.inReplyToMessageId
        ? await deps.outreaches.findByRepliedMessage(tx, event.inReplyToMessageId)
        : "NOT_FOUND";

      // 対象が引けても、宛先が打診時に固定したものと**丸ごと**一致しなければ
      // 本人とは言えない（A15）。版まで見る。
      const outreach =
        target !== "NOT_FOUND" && sameEndpoint(target.endpoint, event.from) ? target : "NOT_FOUND";

      const identity: SenderIdentity =
        outreach === "NOT_FOUND"
          ? // 対象を特定できない返信。記録はするが承諾には使わない。
            SENDER_IDENTITY.UNMATCHED
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

      // 打診は `persist` の後に読み直す。`persist` が案件行をロックするので、
      // ここで読んだ版は解釈経路と直列化されている。ロックの前に読んだ版のまま
      // 更新すると、並行する解釈と競合して静かに失敗する。
      const live = await deps.outreaches.findById(tx, outreach.outreachId);
      if (live === "NOT_FOUND") return summarize(stored, identity);

      const next = resolveOutreachAfterInbound({
        current: live.state,
        senderIdentity: identity,
        hasBody: Boolean(event.body && event.body.length > 0),
      });
      if (next !== live.state) {
        const moved = await deps.outreaches.applyTransition(tx, {
          outreachId: live.outreachId,
          expectedVersion: live.version,
          to: next,
        });
        if (moved === "VERSION_CONFLICT") {
          // 起きないはずの経路。握り潰すと画面と実態がずれたまま気付けない。
          throw new TaskcalError(
            ERROR_CODES.OPERATION_CONFLICT,
            "受信の取り込み中に打診が更新されました。もう一度受信してください。",
          );
        }
      }

      return summarize(stored, identity);
    });
  };
}
