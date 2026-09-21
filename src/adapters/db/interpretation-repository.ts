/**
 * 返信解釈の永続化（RFC-011 §4、A12）。
 *
 * 古い解釈も保存する。**保存しないことと適用しないことは別。** 遅れて返った結果を
 * 捨てると、なぜ承諾にしなかったかを後から説明できない（Q09：承諾として採用しない
 * ことと、返信を無視することは別）。
 *
 * `tryAdvanceAppliedSeq` が A12 の要。`last_applied_seq` より小さい受信順の解釈は
 * 適用しない。時刻ではなく受信順で新旧を決める。
 */

import "server-only";
import type { PersistedReplyInterpretation } from "../../contracts/model-output";
import type {
  InterpretationApplication,
  ReplyInterpretationRepository,
  TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

export function createPgReplyInterpretationRepository(): ReplyInterpretationRepository {
  return {
    async save(
      handle: TxHandle,
      record: PersistedReplyInterpretation,
      applied: InterpretationApplication,
    ) {
      const tx = handle as Tx;
      await tx.query(
        `insert into reply_interpretation
           (interpretation_id, case_id, message_id, inbound_event_id, received_seq,
            case_version, request_id, output, masked_reply_text, applied)
         select $1, m.case_id, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
           from outreach_message m where m.message_id = $2
         on conflict (message_id, request_id) do nothing`,
        [
          record.interpretationId,
          record.messageId,
          record.inboundEventId,
          record.receivedSeq,
          record.caseVersion,
          record.requestId,
          JSON.stringify(record.output),
          record.maskedReplyText,
          applied,
        ],
      );
    },

    async tryAdvanceAppliedSeq(handle: TxHandle, input) {
      const tx = handle as Tx;
      // A12：より新しい受信を既に適用していれば 0 行。古い結果で状態を戻さない。
      const { rowCount } = await tx.query(
        `update outreach set last_applied_seq = $2, version = version + 1
          where outreach_id = $1 and last_applied_seq < $2`,
        [input.outreachId, input.receivedSeq],
      );
      return rowCount === 1 ? "ADVANCED" : "STALE";
    },
  };
}
