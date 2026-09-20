/**
 * AbsenceCase（案件）の状態。
 *
 * 出典：RFC-011 §5 の状態図、ADR-017。
 *
 * 状態は対象ごとに分離する。案件の状態で、相手ごとの対話（Outreach）、勤務表更新
 * （ScheduleUpdate）、メッセージ配送の状態を代表させない。「Aは確認中、Bは承諾済み」
 * を1つの列挙で表せないため、それぞれ別の型を持つ。
 */

import { z } from "zod";
import { ERROR_CODES, TaskcalError } from "./errors";

export const CASE_STATES = [
  /** 返信を取り込み再計画している。 */
  "COORDINATING",
  /** 実行可能な選定ができ、正式採用の準備に入った。 */
  "PREPARING",
  /** 計画の全勤務を正式採用した。 */
  "COMMITTED",
  /** 採用結果を照合する必要がある。未確定と断定しない（RFC-011 §5末尾）。 */
  "RECONCILE_REQUIRED",
  /** 正式版の読戻しが一致し、通知を処理している。 */
  "REPORTING",
  /** 読戻しまたは通知の問題。人の対応が必要。 */
  "ATTENTION",
  /** 業務完了。完了境界はQ07未決（初期推奨：必要な通知受付まで）。 */
  "COMPLETED",
  /** 候補枯渇・期限・上限により人へ引き継いだ。 */
  "HANDED_OFF",
  /** 店長停止が正式採用より先に成立した。 */
  "CANCELLED",
] as const;

export type CaseState = (typeof CASE_STATES)[number];

/** 永続層・API境界で parse する。未知の文字列を状態として通さない。 */
export const caseStateSchema = z.enum(CASE_STATES);

/** 終端状態。ここへ入った後に自動調整を再開しない（RFC-011 §5）。 */
export const TERMINAL_CASE_STATES: readonly CaseState[] = ["COMPLETED", "HANDED_OFF", "CANCELLED"];

/**
 * 許可する遷移。RFC-011 §5 の図をそのまま写したもの。
 *
 * 注意：`REPORTING -> COMPLETED` はQ07の初期推奨「必要な通知受付まで業務完了」を
 * 仮置きしている。確定と通知を別完了にする場合、この遷移・指標・画面を同時に変える。
 */
export const ALLOWED_CASE_TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  COORDINATING: ["COORDINATING", "PREPARING", "HANDED_OFF", "CANCELLED"],
  PREPARING: ["COORDINATING", "COMMITTED", "RECONCILE_REQUIRED", "CANCELLED"],
  RECONCILE_REQUIRED: ["COMMITTED", "COORDINATING"],
  COMMITTED: ["REPORTING", "ATTENTION"],
  REPORTING: ["COMPLETED", "ATTENTION"],
  ATTENTION: ["REPORTING"],
  COMPLETED: [],
  HANDED_OFF: [],
  CANCELLED: [],
};

export function isAllowedCaseTransition(from: CaseState, to: CaseState): boolean {
  const allowed = ALLOWED_CASE_TRANSITIONS[from];
  if (!allowed) {
    // DB由来の未知の値。黙って false を返すと、遷移禁止と区別できない。
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, `未知の案件状態です: ${String(from)}`);
  }
  return allowed.includes(to);
}
