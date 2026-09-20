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
  /**
   * **自動調整を終了し、人へ対応を引き継いだ**（ADR-022）。
   *
   * 「未確定」を意味しない。採用済み・未採用・成否不明のどれで引き継いだかは、
   * 案件状態ではなく ScheduleUpdate と正式版参照が持つ。画面はそれを区別して表示する。
   */
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
 * 許可する遷移。RFC-011 §5 の図に、ADR-022 で確定した三つの経路を加えたもの。
 *
 * `REPORTING -> COMPLETED` の完了境界はQ07で確定した（正式採用・読戻し・必要通知の
 * 受付まで。非選定通知・募集終了通知も対象）。
 *
 * ADR-022 で追加した経路には条件がある。条件は型では表せないため、
 * `resolveReconcileStall` / `canResumeReporting` / `resolvePreparingStop` を通す。
 */
export const ALLOWED_CASE_TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  COORDINATING: ["COORDINATING", "PREPARING", "HANDED_OFF", "CANCELLED"],
  // Q13: 未採用を確認できた場合に限り HANDED_OFF へ。期限検知だけでは進めない。
  PREPARING: ["COORDINATING", "COMMITTED", "RECONCILE_REQUIRED", "HANDED_OFF", "CANCELLED"],
  // Q11: 照合が継続不能なら ATTENTION へ。未採用とも採用済みとも断定しない。
  RECONCILE_REQUIRED: ["COMMITTED", "COORDINATING", "ATTENTION"],
  COMMITTED: ["REPORTING", "ATTENTION"],
  REPORTING: ["COMPLETED", "ATTENTION"],
  // Q12: 復旧しないまま人が引き取った場合の終端。採用事実は保持する。
  ATTENTION: ["REPORTING", "HANDED_OFF"],
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

/**
 * 引き継いだ時点の採用事実（ADR-022）。
 *
 * 案件状態と**別に**保持する。`HANDED_OFF` や `ATTENTION` から採用可否を推定しない。
 * 正は ScheduleUpdate と正式版参照で、これはその写しを表示・記録するための型。
 */
export const ADOPTION_FACT = {
  /** 正式採用していない。 */
  NOT_ADOPTED: "NOT_ADOPTED",
  /** 正式採用済み。読戻しや通知が失敗しても、この事実を取り消さない（D09）。 */
  ADOPTED: "ADOPTED",
  /** 採用されたか確認できない。未採用と断定しない（RFC-011 §5末尾）。 */
  UNKNOWN: "UNKNOWN",
} as const;

export type AdoptionFact = (typeof ADOPTION_FACT)[keyof typeof ADOPTION_FACT];

/** 引き継いだ理由。これが無いと HANDED_OFF が何を意味するか説明できない（ADR-022）。 */
export const HANDOFF_REASON = {
  /** 候補が尽きた。 */
  CANDIDATES_EXHAUSTED: "CANDIDATES_EXHAUSTED",
  DEADLINE_REACHED: "DEADLINE_REACHED",
  /** 予算・回数の上限に達した。 */
  LIMIT_REACHED: "LIMIT_REACHED",
  /** 採用結果の照合が継続不能。 */
  RECONCILE_STALLED: "RECONCILE_STALLED",
  /** 読戻しまたは通知が復旧しない。 */
  REPORTING_FAILED: "REPORTING_FAILED",
} as const;

export type HandoffReason = (typeof HANDOFF_REASON)[keyof typeof HANDOFF_REASON];

export interface Handoff {
  readonly reason: HandoffReason;
  /** 引き継ぎ時点の採用事実。UNKNOWN を NOT_ADOPTED へ丸めない。 */
  readonly adoptionFact: AdoptionFact;
  readonly handedOffAt: string;
}

/**
 * Q11：照合が継続できないときの行き先。
 *
 * 未採用とも採用済みとも断定せず、成否不明のまま要対応にする。
 * 案件を終端へ落とす目的で不明状態を消さない（RFC-011 §5末尾）。
 */
export function resolveReconcileStall(input: {
  /** 照会経路がまだ使えるか。使えるうちは状態を動かさない。 */
  lookupStillPossible: boolean;
}): CaseState {
  return input.lookupStillPossible ? "RECONCILE_REQUIRED" : "ATTENTION";
}

/**
 * Q12/ADR-022：`ATTENTION` から通知処理へ戻せるか。
 *
 * **採用済みと確認でき、かつ正式版の読戻しが一致した場合だけ**許可する。
 * 読戻しが未確認のまま通知処理へ進まない。
 */
export function canResumeReporting(input: {
  adoptionFact: AdoptionFact;
  readBackMatches: boolean;
}): boolean {
  return input.adoptionFact === ADOPTION_FACT.ADOPTED && input.readBackMatches;
}

/**
 * Q13/ADR-022：`PREPARING` 中に停止条件（停止・期限・上限）へ達したときの行き先。
 *
 * 期限を検知しただけで引き継がない。並行する正式採用の結果を先に確定させる。
 * 正式採用と同じ排他規則で停止を確定させたうえで判定する（RFC-010 §4 手順5）。
 */
export function resolvePreparingStop(input: { adoptionFact: AdoptionFact }): CaseState {
  switch (input.adoptionFact) {
    case ADOPTION_FACT.NOT_ADOPTED:
      // 未採用を確認できた。安全に引き継げる。
      return "HANDED_OFF";
    case ADOPTION_FACT.ADOPTED:
      // すでに採用済み。確定事実を保持して通常の経路へ進む。
      return "COMMITTED";
    case ADOPTION_FACT.UNKNOWN:
      // 結果不明。引き継がず照合へ回す。
      return "RECONCILE_REQUIRED";
  }
}
