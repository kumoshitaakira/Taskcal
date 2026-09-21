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
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
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
      // 同じ受信を再処理すると `requestId` が同じになり、行は既にある。
      // `do nothing` にすると呼出し元が今回作ったIDを承諾から参照し、存在しない行を
      // 指して外部キー違反になる。**保存された行のIDを返す。**
      //
      // 適用結果（applied）だけは更新する。解釈の内容（output）は書き換えない——
      // 版付きの解釈は不変で、applied は「案件へ適用したか」という別の軸。
      //
      // **`APPLIED` を降格させない。** 同じ返信を並行処理すると、先行が承諾を作った
      // 後に後行が受信順検査で STALE になる。そこで上書きすると、承諾は残るのに
      // その根拠の解釈が「棄却済み」になる。適用した事実は後から取り消さない（D09）。
      const { rows } = await tx.query<{ interpretation_id: string }>(
        `insert into reply_interpretation
           (interpretation_id, case_id, message_id, inbound_event_id, received_seq,
            case_version, request_id, output, masked_reply_text, applied)
         select $1, m.case_id, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
           from outreach_message m where m.message_id = $2
         on conflict (message_id, request_id) do update set applied = excluded.applied
           where reply_interpretation.applied <> 'APPLIED'
         returning interpretation_id`,
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
      if (rows[0]) return { interpretationId: rows[0].interpretation_id };

      // 0行になる場合が2つある。降格を止めた（既に APPLIED）か、対象Messageが無いか。
      // 前者は既存の行を返す。後者は承諾の根拠を残せないので黙って続けない。
      const existing = await tx.query<{ interpretation_id: string }>(
        `select interpretation_id from reply_interpretation
          where message_id = $1 and request_id = $2`,
        [record.messageId, record.requestId],
      );
      const stored = existing.rows[0]?.interpretation_id;
      if (!stored) {
        throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "解釈の対象Messageが見つかりません。");
      }
      return { interpretationId: stored };
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
