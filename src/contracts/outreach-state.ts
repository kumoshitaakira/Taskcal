/**
 * Outreach（案件内の相手別対話）と、その配送の状態。
 *
 * 出典：RFC-011 §2・§6、ADR-013。
 *
 * 一人の確認失敗で案件全体を閉じない（A11）。案件状態とは独立に進む。
 */

import { z } from "zod";

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
