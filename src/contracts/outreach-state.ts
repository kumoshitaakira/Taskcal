/**
 * Outreach（案件内の相手別対話）と、その配送の状態。
 *
 * 出典：RFC-011 §2・§6、ADR-013。
 *
 * 一人の確認失敗で案件全体を閉じない（A11）。案件状態とは独立に進む。
 */

import { z } from "zod";
import { ERROR_CODES, TaskcalError } from "./errors";

export const OUTREACH_STATES = [
  /** 送信待ち。 */
  "PENDING_SEND",
  /** 送信が受け付けられた（到達の保証ではない）。 */
  "SENT",
  /** 返信待ち。 */
  "AWAITING_REPLY",
  /** 条件が曖昧なため追加確認中（RFC-011 §3）。 */
  "CLARIFYING",
  /** 回答済み。承諾の成立可否はCommitment側で判定する。 */
  "ANSWERED",
  /** 期限切れ等で失効。 */
  "EXPIRED",
  /** この相手との対話を終了した。 */
  "CLOSED",
] as const;

export type OutreachState = (typeof OUTREACH_STATES)[number];
export const outreachStateSchema = z.enum(OUTREACH_STATES);

/**
 * 1回の送信操作の配送状態。
 *
 * Outreach.status だけで初回打診・追加確認・確定通知・非選定通知の全配送結果を
 * 代表させない（RFC-011 §6）。送信操作ごとにこの状態を持つ。
 */
export const DELIVERY_STATES = [
  "QUEUED",
  /** 送信先が受け付けた。 */
  "ACCEPTED",
  "FAILED",
  /** 結果不明。失敗と断定しない（AGENTS.md：結果不明を確定失敗として記録しない）。 */
  "UNKNOWN",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];
export const deliveryStateSchema = z.enum(DELIVERY_STATES);

/** 送信の種類。意味の違うメッセージを一律に「重複送信」として抑止しない（RFC-011 §2）。 */
export const OUTREACH_MESSAGE_KINDS = [
  "INITIAL_OFFER",
  "CLARIFICATION",
  "CONFIRMATION",
  "NOT_SELECTED",
  "CASE_CLOSED",
] as const;

export type OutreachMessageKind = (typeof OUTREACH_MESSAGE_KINDS)[number];
export const outreachMessageKindSchema = z.enum(OUTREACH_MESSAGE_KINDS);

/** 終端。この相手との対話を終えた。案件の終端とは別（A11）。 */
export const TERMINAL_OUTREACH_STATES: readonly OutreachState[] = ["CLOSED"];

/**
 * 許可する遷移（RFC-011 §2）。
 *
 * `ANSWERED` は「回答が届いた」であり、承諾が成立したという意味ではない。訂正・撤回で
 * 再び回答待ちへ戻れる（RFC-011 §4）。承諾の成立可否は Commitment 側が持つ。
 */
export const ALLOWED_OUTREACH_TRANSITIONS: Readonly<
  Record<OutreachState, readonly OutreachState[]>
> = {
  // 送信に失敗・結果不明のあいだは送信待ちのまま留まる。
  PENDING_SEND: ["PENDING_SEND", "SENT", "EXPIRED", "CLOSED"],
  SENT: ["AWAITING_REPLY", "EXPIRED", "CLOSED"],
  AWAITING_REPLY: ["ANSWERED", "CLARIFYING", "EXPIRED", "CLOSED"],
  // 追加確認しても曖昧なままなら CLARIFYING に留まる。
  CLARIFYING: ["CLARIFYING", "ANSWERED", "EXPIRED", "CLOSED"],
  ANSWERED: ["ANSWERED", "CLARIFYING", "AWAITING_REPLY", "EXPIRED", "CLOSED"],
  EXPIRED: ["CLOSED"],
  CLOSED: [],
};

export function isAllowedOutreachTransition(from: OutreachState, to: OutreachState): boolean {
  const allowed = ALLOWED_OUTREACH_TRANSITIONS[from];
  if (!allowed) {
    // DB由来の未知の値。黙って false を返すと、遷移禁止と区別できない。
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, `未知の打診状態です: ${String(from)}`);
  }
  return allowed.includes(to);
}

/** 送信しなかった理由。`SendRefused` の写し。配送失敗（FAILED）と同じ欄に畳まない。 */
export const DELIVERY_NOT_SENT = "REFUSED" as const;

/** 送信の結末。`REFUSED` は未送信であり、`FAILED`（送信を試みて失敗）と区別する。 */
export type SendOutcome = DeliveryState | typeof DELIVERY_NOT_SENT;

/**
 * 送信結果から Outreach の次状態を決める。
 *
 * **配送状態をそのまま Outreach の status へ写さないこと。**
 * `FAILED`・`UNKNOWN`・`REFUSED` はいずれも「相手に届いたと確認できていない」ので
 * `PENDING_SEND` のまま残す。ここで `SENT` にすると、未送信の打診を返信待ちとして
 * 数え、一人の送信失敗で案件全体の進行判断が狂う（A11、RFC-011 §6）。
 *
 * `UNKNOWN` を `FAILED` へ丸めない。再送は `getSendResult` で照合してから決める。
 */
export function resolveOutreachAfterSend(input: {
  current: OutreachState;
  outcome: SendOutcome;
}): OutreachState {
  if (TERMINAL_OUTREACH_STATES.includes(input.current) || input.current === "EXPIRED") {
    // 終了・失効した打診は送信結果で動かさない。
    return input.current;
  }
  switch (input.outcome) {
    case "ACCEPTED":
      return input.current === "PENDING_SEND" ? "SENT" : input.current;
    case "QUEUED":
    case "FAILED":
    case "UNKNOWN":
    case DELIVERY_NOT_SENT:
      // 届いたと確認できていない。送信待ちのまま据え置く。
      return input.current;
  }
}

/** 受信した相手が、この打診の宛先本人だと確認できたか。 */
export const SENDER_IDENTITY = {
  /** 打診時に固定した宛先と版まで一致した。 */
  VERIFIED_OUTREACH_TARGET: "VERIFIED_OUTREACH_TARGET",
  /** どの打診の宛先とも一致しない。 */
  UNMATCHED: "UNMATCHED",
  /** 宛先を照合できない（宛先が消えた、版が読めない等）。 */
  UNVERIFIABLE: "UNVERIFIABLE",
} as const;

export type SenderIdentity = (typeof SENDER_IDENTITY)[keyof typeof SENDER_IDENTITY];

/**
 * 受信を取り込んだときの次状態。
 *
 * **本人だと確認できない受信で状態を動かさない**（A15、RFC-011 §6）。受信本文で
 * 任意の staffId を名乗れても、認証された本人とはみなさない。動かさないことと
 * 受信を捨てることは別で、イベント自体は必ず永続化する。
 *
 * 本文の無いイベント（将来のLINE等）でも返信が来たとは扱わない。
 */
export function resolveOutreachAfterInbound(input: {
  current: OutreachState;
  senderIdentity: SenderIdentity;
  hasBody: boolean;
}): OutreachState {
  if (input.senderIdentity !== SENDER_IDENTITY.VERIFIED_OUTREACH_TARGET || !input.hasBody) {
    return input.current;
  }
  switch (input.current) {
    case "SENT":
    case "AWAITING_REPLY":
    case "CLARIFYING":
    case "ANSWERED":
      return "ANSWERED";
    case "PENDING_SEND":
    case "EXPIRED":
    case "CLOSED":
      // 未送信・失効・終了の打診への返信は記録するだけ。状態は動かさない。
      return input.current;
  }
}
