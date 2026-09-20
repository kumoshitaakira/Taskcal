/**
 * モデル呼出しの契約。テストのため差し替え可能にする（RFC-003 §3）。
 *
 * モデルには案件内匿名IDと必要条件のみを渡す。任意SQL・URL・宛先を提供しない
 * （ADR-008）。
 */

import type { ModelReplyOutput } from "@/contracts/model-output";
import type { UsageRecord } from "./usage";

export interface InterpretReplyRequest {
  /**
   * RFC-004 §8 の `request_id`。**呼出し元が永続化した安定ID。**
   *
   * worker再起動やlease失効で同じ受信イベントを再処理したとき、同じIDを渡す。
   * adapter側で採番すると、再試行のたびに新しい予約と新しい有料呼出しが起き、
   * 元の呼出しと照合できない（ADR-006 / AGENTS.md「結果不明の外部作用を
   * 照会・照合なしに再実行しない」）。
   */
  readonly requestId: string;
  /** 要求内容のハッシュ。同じIDで内容が異なる要求を検出する（D07）。 */
  readonly requestHash: string;
  readonly caseId: string;
  /** 案件内の匿名ID。実名・連絡先を渡さない（ADR-008）。 */
  readonly anonymousStaffRef: string;
  /** 打診で提示した条件。 */
  readonly offer: {
    readonly date: string;
    readonly roleCode: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly deadlineAt: string;
  };
  /** 返信本文。引用されたデータとして扱い、system指示と同じ権限を与えない。 */
  readonly replyText: string;
  readonly promptVersion: string;
}

export interface InterpretReplyResponse {
  readonly output: ModelReplyOutput;
  readonly usage: UsageRecord;
}

export interface ModelGateway {
  /** 接続設定があるか。無ければ実呼出しを行わない。 */
  isConfigured(): boolean;
  interpretReply(request: InterpretReplyRequest): Promise<InterpretReplyResponse>;
}
