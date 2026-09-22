/**
 * SelectionResult（不変の選定結果）と、担当Bが実装する計算の口。
 *
 * 出典：RFC-009 §3・§6・D04・D08、RFC-012 §3.1、Q02（各区間ちょうど1人）。
 *
 * 選定そのもの（`src/domain/selection/`）と適格性・区間計算（`src/domain/interval/`）は
 * 担当Bが実装する。ここに置くのは、アプリケーション側が依存する口と、保存する結果の形。
 * `src/contracts/` はA・Bの共同所有なので、RFC-012 §3.1 の所有表と矛盾しない。
 */

import { z } from "zod";
// **型だけを取り込む。** 実行時の依存は増やさない。適格性の値型は担当Bが
// `src/domain/interval/` で定義しており、契約側で同じ形を書き写すと、片方だけが
// 変わったときに黙って食い違う（Q15 / ADR-021）。
import type { MonthlyScheduleSnapshot, StaffProfile } from "@/domain/interval";
import type {
  ConnectionId,
  ScheduleId,
  ShiftAssignmentId,
  SourceRevision,
} from "./schedule-gateway";

/** 選定が成立しなかった理由。案件を終了させる理由とは別（Q02の条件、A11、A16）。 */
export const SELECTION_NOT_FEASIBLE_REASON = {
  /** 有効な承諾が無い。 */
  NO_COMMITMENTS: "NO_COMMITMENTS",
  /** 必要区間を覆えない。 */
  NOT_COVERED: "NOT_COVERED",
  /** Q02：各区間ちょうど1人。重複する計画は採用しない。 */
  OVERLAP: "OVERLAP",
  /** 月次割当上限に達する。 */
  MONTHLY_CAP: "MONTHLY_CAP",
  /**
   * 月内入力が完全でないため検査が成立しない（Q06、A09）。
   * 欠けた日を0と推定しない。
   */
  INPUT_INCOMPLETE: "INPUT_INCOMPLETE",
} as const;

export type SelectionNotFeasibleReason =
  (typeof SELECTION_NOT_FEASIBLE_REASON)[keyof typeof SELECTION_NOT_FEASIBLE_REASON];

/**
 * 検査した時点の入力版。
 *
 * D08：対象日のScheduleの版だけで全前提を代表させない。月内入力の完全性まで含めて
 * 記録し、正式採用の直前に同じ値で再検査する。
 */
export interface SelectionInputs {
  readonly connectionId: ConnectionId;
  readonly scheduleId: ScheduleId;
  readonly sourceRevision: SourceRevision;
  /** Q06：COMPLETE でなければ月次上限の検査は成立しない（A09）。 */
  readonly monthlyCompleteness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  readonly missingDates: readonly string[];
}

export interface SelectedCommitment {
  readonly commitmentId: string;
  /** 選んだ承諾の版。status だけでなく版まで一致させて再検査する（D04）。 */
  readonly commitmentVersion: number;
  readonly staffId: string;
  readonly startAt: string;
  readonly endAt: string;
  /**
   * 採用したときに作る勤務のID。選定の時点で確定させる。
   * 再試行で採番し直すと、同じ計画から二つの勤務ができる（RFC-010 §3、D05）。
   */
  readonly plannedShiftAssignmentId: ShiftAssignmentId;
}

/**
 * 一度の選定の結果。**作成後に書き換えない。**
 *
 * 承諾0件の評価でも残す。「なぜ選べなかったか」を後から説明できなくなるため
 * （RFC-009 §4）。
 */
export interface SelectionResult {
  readonly selectionId: string;
  readonly caseId: string;
  /** 検査した時点の案件版。正式採用の直前に照合する（D08）。 */
  readonly caseVersion: number;
  /** 選定規則の版。fixtureと評価の再現に使う。 */
  readonly rulesVersion: string;
  readonly outcome: "FEASIBLE" | "NOT_FEASIBLE";
  readonly notFeasibleReason?: SelectionNotFeasibleReason;
  readonly inputs: SelectionInputs;
  /** `outcome === "FEASIBLE"` のときだけ空でない。 */
  readonly selected: readonly SelectedCommitment[];
  /** 非選定通知の宛先（Q07）。確定した相手だけに通知して他を待たせない。 */
  readonly notSelectedCommitmentIds: readonly string[];
  readonly decidedAt: string;
}

export const selectionOutcomeSchema = z.enum(["FEASIBLE", "NOT_FEASIBLE"]);

/** 埋めるべき必要枠。Q02によりちょうど1人、Q03により単一区間。 */
export interface CoverageRequirement {
  readonly roleCode: string;
  readonly startAt: string;
  readonly endAt: string;
}

/** 選定の入力にする、検査済みの承諾。 */
export interface SelectionCandidate {
  readonly commitmentId: string;
  readonly commitmentVersion: number;
  readonly staffId: string;
  readonly startAt: string;
  readonly endAt: string;
  /** 承諾が揃った順。同率のときの安定した順序に使う（RFC-009 §6）。 */
  readonly committedSeq: number;
  readonly plannedShiftAssignmentId: ShiftAssignmentId;
}

export interface SelectionPlanInput {
  readonly caseId: string;
  readonly caseVersion: number;
  readonly requirement: CoverageRequirement;
  readonly candidates: readonly SelectionCandidate[];
  readonly inputs: SelectionInputs;
}

/**
 * 担当Bが `src/domain/selection/` で実装する純粋関数の口。
 *
 * 承諾時間を自動で短縮しない（ADR-005）。実行可能な計画だけを返し、
 * `fullyCovered` と実行可能性を同じbooleanへ詰め込まない（RFC-009 §6）。
 */
export interface SelectionPlanner {
  plan(input: SelectionPlanInput): Omit<SelectionResult, "selectionId" | "decidedAt">;
}

/** 適格な候補。過去の辞退を順位の減点に使わない（AGENTS.md）。 */
export interface EligibleCandidate {
  readonly staffId: string;
  /** 打診時点の宛先。途中の宛先変更で旧打診を別人へ送らない（RFC-011 §6）。 */
  readonly endpointKey: string;
  readonly endpointVersion: number;
  /** 提示できる区間。Q03により分断していれば候補にしない。 */
  readonly offeredStartAt: string;
  readonly offeredEndAt: string;
}

export interface EligibilityInput {
  readonly storeId: string;
  readonly requirement: CoverageRequirement;
  /** D01：欠勤者本人は代替候補から除く。 */
  readonly absentStaffId: string;
  readonly inputs: SelectionInputs;
}

export interface EligibilityRecheckInput {
  readonly storeId: string;
  readonly requirement: CoverageRequirement;
  readonly selected: readonly SelectedCommitment[];
  readonly inputs: SelectionInputs;
  /** 対象の営業日。月次上限は対象月で数える（Q06）。 */
  readonly businessDate: string;
  /** D01：欠勤者本人は代替候補にならない。 */
  readonly absentStaffId: string;
  /**
   * Q15：**採用の直前に取り直した**月内勤務表。選定時に固定した値を再利用しない（D08）。
   *
   * `completeness` が `COMPLETE` でなければ月次上限の検査は成立しない。欠けた日を
   * 0と推定しない（Q06 / A09）。
   */
  readonly monthlySchedule: MonthlyScheduleSnapshot;
  /**
   * 検査対象のスタッフ条件。在籍・店舗・職種・月次上限を持つ。
   *
   * **`availabilityWindows` には本人が承諾した区間を入れる。** MVPには可能時間表が
   * 無く、「本人が大丈夫と答えた区間」が唯一の根拠（ADR-014 / Q09）。したがって
   * 可能時間の検査は事実上恒真で、実際に効くのは在籍・職種・重複・月次上限。
   */
  readonly staffProfiles: readonly StaffProfile[];
}

export type EligibilityRecheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SelectionNotFeasibleReason; readonly staffId?: string };

/**
 * 担当Bが `src/domain/interval/` と `src/domain/selection/` で実装する口。
 *
 * `recheck` は正式採用の直前にもう一度通す（D08）。選定時の結果を再利用しない。
 * 月内入力が COMPLETE でなければ成立させない（Q06、A09）。
 *
 * Q15（2026-09-22確定）：`recheck` は同期のまま、必要な入力を**呼出し側が渡す**形に
 * した。口の中でDBやGatewayを引く形にすると、外部待ちを取引の中へ持ち込む
 * （RFC-010 §5）。実装は `src/application/eligibility-recheck.ts`。
 */
export interface EligibilityChecker {
  listEligible(input: EligibilityInput): readonly EligibleCandidate[];
  recheck(input: EligibilityRecheckInput): EligibilityRecheckResult;
}
