/**
 * 採用した計画と、勤務表に実際にあるものの照合（RFC-010 §4 手順4・手順7、A07）。
 *
 * 正式採用の進行（`adopt-plan.ts`）と、落ちた後の復旧（`settle-reporting.ts`）の
 * **両方**が使う。片方だけが照合すると、手順7の前にプロセスが落ちた案件を
 * 誰も検査しないまま通知処理へ進めることになる。
 */

import "server-only";
import type { CaseSnapshot } from "../contracts/repository";
import type {
  LoadedAssignment,
  PlannedAbsence,
  PlannedAssignment,
} from "../contracts/schedule-gateway";
import type { SelectionResult } from "../contracts/selection";

/** 半開区間の比較。ISO文字列の表記揺れを吸収するため時刻として比べる。 */
function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

/**
 * A06：`shiftAssignmentId` の昇順で並べる。
 *
 * `requestHash` は配列順を内容の違いとして扱うため、並べ替え後の再試行が別内容と
 * 判定される。**再開のたびに同じ順序になること**が冪等キーの前提（ADR-006）。
 */
export function plannedAdditions(
  selection: SelectionResult,
  snapshot: CaseSnapshot,
): readonly PlannedAssignment[] {
  return selection.selected
    .map((chosen) => ({
      shiftAssignmentId: chosen.plannedShiftAssignmentId,
      commitmentId: chosen.commitmentId,
      staffId: chosen.staffId,
      roleCode: snapshot.roleCode,
      startAt: chosen.startAt,
      endAt: chosen.endAt,
      sourceCaseId: snapshot.caseId,
    }))
    .sort((a, b) =>
      a.shiftAssignmentId < b.shiftAssignmentId
        ? -1
        : a.shiftAssignmentId > b.shiftAssignmentId
          ? 1
          : 0,
    );
}

/**
 * Q04：欠勤は元勤務の全時間。区間は元勤務と一致する。
 *
 * 案件の必要枠は `create-absence-case.ts` が元勤務の区間から作っているので、
 * ここで同じ値になる。部分欠勤を扱うようになったら、元勤務の行から読むこと。
 */
export function plannedAbsences(snapshot: CaseSnapshot): readonly PlannedAbsence[] {
  return [
    {
      shiftAssignmentId: snapshot.absentShiftAssignmentId,
      startAt: snapshot.requiredStartAt,
      endAt: snapshot.requiredEndAt,
    },
  ];
}

/**
 * 勤務ID・担当者・役割・区間・件数を照合する（RFC-010 §4 手順4）。
 *
 * **件数を落とさない。** IDごとの一致だけを見ると、期待していない余分な代替勤務が
 * 同じ案件から生えていても気付けない（A07）。
 */
export function matchesExpected(
  assignments: readonly LoadedAssignment[],
  additions: readonly PlannedAssignment[],
  absences: readonly PlannedAbsence[],
  caseId: string,
): boolean {
  for (const addition of additions) {
    const found = assignments.find((a) => a.shiftAssignmentId === addition.shiftAssignmentId);
    if (
      !found ||
      found.staffId !== addition.staffId ||
      found.roleCode !== addition.roleCode ||
      !sameInstant(found.startAt, addition.startAt) ||
      !sameInstant(found.endAt, addition.endAt)
    ) {
      return false;
    }
  }
  if (assignments.filter((a) => a.sourceCaseId === caseId).length !== additions.length) {
    return false;
  }
  for (const absence of absences) {
    const found = assignments.find((a) => a.shiftAssignmentId === absence.shiftAssignmentId);
    // 欠勤（ABSENT）と取消（CANCELLED）を混同しない。往復して同じ状態で戻ること。
    if (!found || found.status !== "ABSENT") return false;
  }
  return true;
}
