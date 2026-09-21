/**
 * Commitment（版付きの承諾）。
 *
 * 出典：RFC-011 §3・§4、RFC-009 §3・D03・D04、ADR-014、Q09（2026-09-21確定）。
 *
 * 訂正で内容を上書きしない。新しいIDと `supersedes` 参照を作り、旧版は固定したまま
 * status だけを変える。同一案件・スタッフで選定できる版は一つ（RFC-011 §4）。
 */

import { z } from "zod";
import { ERROR_CODES, TaskcalError } from "./errors";

export const COMMITMENT_STATUSES = [
  /** 有効な最新版。選定できる唯一の status（D04）。 */
  "ACTIVE",
  /**
   * 保留。曖昧な訂正、または未処理の新しい返信がある。
   *
   * 旧内容は保持するが選定はできない（RFC-011 §4「曖昧な変更」）。
   * 「承諾として採用しない」と「返信を無視する」は別（Q09）。
   */
  "HELD",
  /** 訂正により新しい版へ置き換えられた。内容は書き換えない。 */
  "SUPERSEDED",
  /** 本人が撤回した。 */
  "WITHDRAWN",
  /** 期限に達して失効した。 */
  "EXPIRED",
] as const;

export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/** 永続層・API境界で parse する。未知の文字列を status として通さない。 */
export const commitmentStatusSchema = z.enum(COMMITMENT_STATUSES);

/** 終端。ここへ入った承諾は選定対象へ戻らない。 */
export const TERMINAL_COMMITMENT_STATUSES: readonly CommitmentStatus[] = [
  "SUPERSEDED",
  "WITHDRAWN",
  "EXPIRED",
];

/**
 * 許可する遷移。
 *
 * `HELD -> ACTIVE` は、追加確認で条件が一意に定まった場合だけ。未処理返信が残る
 * うちは戻さない（`isSelectableCommitment` の `hasUnprocessedReply`）。
 */
export const ALLOWED_COMMITMENT_TRANSITIONS: Readonly<
  Record<CommitmentStatus, readonly CommitmentStatus[]>
> = {
  ACTIVE: ["HELD", "SUPERSEDED", "WITHDRAWN", "EXPIRED"],
  HELD: ["ACTIVE", "SUPERSEDED", "WITHDRAWN", "EXPIRED"],
  SUPERSEDED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

export function isAllowedCommitmentTransition(
  from: CommitmentStatus,
  to: CommitmentStatus,
): boolean {
  const allowed = ALLOWED_COMMITMENT_TRANSITIONS[from];
  if (!allowed) {
    // DB由来の未知の値。黙って false を返すと、遷移禁止と区別できない。
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, `未知の承諾statusです: ${String(from)}`);
  }
  return allowed.includes(to);
}

/**
 * 一つの承諾。
 *
 * 時刻は ISO 8601 の文字列で持つ。`Date` を入れない——`computeRequestHash` が
 * `Date` を拒否するため、操作の内容ハッシュを作る経路で必ず落ちる。
 */
export interface Commitment {
  readonly commitmentId: string;
  readonly caseId: string;
  readonly staffId: string;
  readonly outreachId: string;
  /** 同一案件・スタッフ内で1から増える。旧版の内容は書き換えない。 */
  readonly version: number;
  /** 置き換えた旧版のID。訂正で上書きせず、新しいIDとこの参照を作る。 */
  readonly supersedes?: string;
  /** D03：打診・選定・確定で一致させる条件。 */
  readonly roleCode: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: CommitmentStatus;
  /** 採用した解釈。原文の根拠を追跡するために必須（RFC-011 §3）。 */
  readonly acceptedInterpretationId: string;
  /** この承諾を生んだ受信順。最新判定に時刻を使わない（RFC-011 §4）。 */
  readonly sourceReceivedSeq: number;
  readonly createdAt: string;
}

/** 選定できない理由。画面・ログで「なぜ選べないか」を説明するために区別する。 */
export const COMMITMENT_BLOCK_REASON = {
  /** ACTIVE でない（保留・撤回・失効）。 */
  NOT_ACTIVE: "NOT_ACTIVE",
  /** 新しい版に置き換えられている。 */
  SUPERSEDED: "SUPERSEDED",
  /** まだ解釈を適用していない受信がある。 */
  UNPROCESSED_REPLY: "UNPROCESSED_REPLY",
  /** 期限を過ぎている。 */
  DEADLINE_PASSED: "DEADLINE_PASSED",
} as const;

export type CommitmentBlockReason =
  (typeof COMMITMENT_BLOCK_REASON)[keyof typeof COMMITMENT_BLOCK_REASON];

export type CommitmentSelectability =
  | { readonly selectable: true }
  | { readonly selectable: false; readonly reason: CommitmentBlockReason };

/**
 * D04：選定できる承諾は最新の有効版だけ。
 *
 * **`status === "ACTIVE"` だけで判定しないこと。** 確認中・期限切れ・撤回に加えて
 * 「未処理の新しい返信がある」を含める。これが無いと、正式採用の準備中に届いた訂正を
 * 見落として古い承諾のまま確定する（A05、RFC-011 §4「未処理の新しい返信」）。
 *
 * 正式採用の直前にもう一度通すこと。選定時に一度通しただけでは、その後に届いた
 * 受信を検知できない（D08）。
 */
export function isSelectableCommitment(input: {
  status: CommitmentStatus;
  /** この承諾を置き換えた新しい版。あれば選定しない。 */
  supersededBy?: string;
  /** この案件・スタッフに、まだ解釈を適用していない受信があるか。 */
  hasUnprocessedReply: boolean;
  /** 案件の回答期限。 */
  deadlineAt: string;
  now: string;
}): CommitmentSelectability {
  if (input.supersededBy) {
    return { selectable: false, reason: COMMITMENT_BLOCK_REASON.SUPERSEDED };
  }
  if (input.status !== "ACTIVE") {
    return { selectable: false, reason: COMMITMENT_BLOCK_REASON.NOT_ACTIVE };
  }
  if (input.hasUnprocessedReply) {
    return { selectable: false, reason: COMMITMENT_BLOCK_REASON.UNPROCESSED_REPLY };
  }
  if (Date.parse(input.now) >= Date.parse(input.deadlineAt)) {
    return { selectable: false, reason: COMMITMENT_BLOCK_REASON.DEADLINE_PASSED };
  }
  return { selectable: true };
}
