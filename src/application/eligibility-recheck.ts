/**
 * 正式採用の直前の適格性再検査（D08、Q06 / A09、Q15）。
 *
 * 規則そのものは担当Bの `evaluateCandidateEligibility`（`src/domain/interval/`）。
 * ここがやるのは**その結果を選定の語彙へ写すこと**だけで、判定を書き直さない。
 * 写し替えの途中で条件を足したり緩めたりすると、規則が二箇所に分かれる。
 *
 * **選定時の結果を再利用しない。** 呼出し側は採用の直前に月内勤務表を取り直し、
 * その値をここへ渡す（`adopt-plan.ts` 手順5の前段）。
 *
 * ## 可能時間について
 *
 * MVPには可能時間表が無い。`StaffProfile.availabilityWindows` には**本人が承諾した
 * 区間**を入れる（ADR-014 / Q09：本人の返信が唯一の根拠）。そのため可能時間の検査は
 * 事実上恒真で、ここで実際に効くのは在籍・店舗・職種・本人除外・勤務の重複・月次上限。
 * **「可能時間を検査した」とは言えない。** README の「動かないもの」に残すこと。
 *
 * ## 時刻の形式
 *
 * 担当Bの規則は `YYYY-MM-DDTHH:MM:00+09:00`（Asia/Tokyo固定）だけを受け取る。
 * こちらの永続層は `Date.toISOString()`（UTC・ミリ秒つき）を返す。**境界でそろえる**。
 * 秒・ミリ秒が0でない値は黙って丸めず、範囲外として拒否する（MVPは15分単位）。
 */

import "server-only";
import type { LoadedSchedule } from "../contracts/schedule-gateway";
import type { CaseSnapshot, StaffConditions } from "../contracts/repository";
import {
  CANDIDATE_INELIGIBILITY,
  evaluateCandidateEligibility,
  type CandidateIneligibility,
} from "@/domain/interval";
import { ERROR_CODES, TaskcalError } from "../contracts/errors";
import {
  SELECTION_NOT_FEASIBLE_REASON,
  type EligibilityChecker,
  type EligibilityRecheckInput,
  type EligibilityRecheckResult,
  type SelectedCommitment,
  type SelectionInputs,
  type SelectionNotFeasibleReason,
} from "../contracts/selection";

const JST_OFFSET_MINUTES = 9 * 60;

/**
 * 保存している瞬間を、担当Bの規則が受け取る Asia/Tokyo 固定形式へ写す。
 *
 * **丸めない。** 秒・ミリ秒が残っている値は、黙って切り捨てると検査した区間と
 * 実際の勤務がずれる。MVPは15分単位（`TIME_GRANULARITY_MINUTES`）なので、
 * ここへ来る時点で0のはず。0でなければ範囲外として拒否する。
 */
export function toJstFixedFormat(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, `日時を解釈できません: ${instant}`);
  }
  if (ms % 60_000 !== 0) {
    throw new TaskcalError(ERROR_CODES.OUT_OF_SCOPE, `秒未満を含む日時は対象外です: ${instant}`);
  }
  const shifted = new Date(ms + JST_OFFSET_MINUTES * 60_000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:00+09:00`
  );
}

/**
 * 再検査の入力を組み立てる（Q15）。
 *
 * **選定時に固定した値を使わない。** `reloaded` は採用の直前に取り直した月内勤務表で、
 * `conditions` はその時点のスタッフ条件（D08）。
 */
export function buildRecheckInput(input: {
  readonly snapshot: Pick<
    CaseSnapshot,
    "storeId" | "businessDate" | "absentStaffId" | "roleCode" | "requiredStartAt" | "requiredEndAt"
  >;
  readonly storeTimezone: string;
  readonly reloaded: LoadedSchedule;
  readonly conditions: readonly StaffConditions[];
  readonly selected: readonly SelectedCommitment[];
  readonly inputs: SelectionInputs;
}): EligibilityRecheckInput {
  const month = input.snapshot.businessDate.slice(0, 7);
  // 承諾した区間を可能時間として渡す。MVPには可能時間表が無い（ADR-014 / Q09）。
  const acceptedByStaff = new Map<string, { startAt: string; endAt: string }[]>();
  for (const chosen of input.selected) {
    const windows = acceptedByStaff.get(chosen.staffId) ?? [];
    windows.push({
      startAt: toJstFixedFormat(chosen.startAt),
      endAt: toJstFixedFormat(chosen.endAt),
    });
    acceptedByStaff.set(chosen.staffId, windows);
  }

  return {
    storeId: input.snapshot.storeId,
    requirement: {
      roleCode: input.snapshot.roleCode,
      startAt: input.snapshot.requiredStartAt,
      endAt: input.snapshot.requiredEndAt,
    },
    selected: input.selected.map((chosen) => ({
      ...chosen,
      startAt: toJstFixedFormat(chosen.startAt),
      endAt: toJstFixedFormat(chosen.endAt),
    })),
    inputs: input.inputs,
    businessDate: input.snapshot.businessDate,
    absentStaffId: input.snapshot.absentStaffId,
    monthlySchedule: {
      storeId: input.snapshot.storeId,
      timezone: input.storeTimezone,
      month,
      sourceRevision: input.reloaded.sourceRevision,
      // 勤務0件のスタッフも対象に含める。居ない相手を「上限に余裕あり」と読まない
      // （`STAFF_NOT_IN_MONTHLY_SNAPSHOT`）。
      staffIds: input.conditions.map((row) => row.staffId),
      completeness: input.reloaded.completeness,
      assignments: input.reloaded.assignments.map((assignment) => {
        const startAt = toJstFixedFormat(assignment.startAt);
        return {
          shiftAssignmentId: assignment.shiftAssignmentId,
          // 営業日は区間の開始から決める。タイムゾーンはMVPで Asia/Tokyo 固定。
          businessDate: startAt.slice(0, 10),
          staffId: assignment.staffId,
          roleCode: assignment.roleCode,
          startAt,
          endAt: toJstFixedFormat(assignment.endAt),
          status: assignment.status,
        };
      }),
    },
    staffProfiles: input.conditions.map((row) => ({
      staffId: row.staffId,
      storeId: row.storeId,
      status: row.active ? ("ACTIVE" as const) : ("INACTIVE" as const),
      roleCodes: [row.roleCode],
      availabilityWindows: acceptedByStaff.get(row.staffId) ?? [],
      monthlyWorkLimits: [{ targetMonth: month, limitMinutes: row.monthlyCapMinutes }],
    })),
  };
}

/**
 * 不適格の理由を選定の語彙へ写す。
 *
 * `OUT_OF_SCOPE`（Q03：空きが分断された）はここに現れない。**選定の失敗ではなく
 * 範囲外**なので、呼出し元へ例外で返して明示的に拒否させる（A17：黙って一区間へ
 * 丸めない）。`SELECTION_NOT_FEASIBLE_REASON` に無い値を近い理由へ寄せると、
 * 範囲外を「覆えなかった」と記録してしまう。
 */
function reasonOf(ineligibility: CandidateIneligibility): SelectionNotFeasibleReason {
  switch (ineligibility) {
    case CANDIDATE_INELIGIBILITY.EXISTING_ASSIGNMENT_OVERLAP:
      return SELECTION_NOT_FEASIBLE_REASON.OVERLAP;
    case CANDIDATE_INELIGIBILITY.MONTHLY_CAP_EXCEEDED:
    case CANDIDATE_INELIGIBILITY.MONTHLY_CAP_NOT_CONFIGURED:
      return SELECTION_NOT_FEASIBLE_REASON.MONTHLY_CAP;
    case CANDIDATE_INELIGIBILITY.OUT_OF_SCOPE:
      throw new TaskcalError(
        ERROR_CODES.OUT_OF_SCOPE,
        "空きが分断されています。範囲外として採用しません（Q03 / A17）。",
      );
    case CANDIDATE_INELIGIBILITY.STAFF_INACTIVE:
    case CANDIDATE_INELIGIBILITY.WRONG_STORE:
    case CANDIDATE_INELIGIBILITY.ROLE_NOT_ALLOWED:
    case CANDIDATE_INELIGIBILITY.ABSENT_STAFF:
    case CANDIDATE_INELIGIBILITY.STAFF_NOT_IN_MONTHLY_SNAPSHOT:
    case CANDIDATE_INELIGIBILITY.AVAILABILITY_NOT_COVERED:
      return SELECTION_NOT_FEASIBLE_REASON.NOT_COVERED;
  }
}

export function createEligibilityRecheck(): Pick<EligibilityChecker, "recheck"> {
  return {
    recheck(input: EligibilityRecheckInput): EligibilityRecheckResult {
      if (input.selected.length === 0) {
        // 「選んだ承諾が無い」を適格と答えない。検査対象が無いことは合格ではない。
        return { ok: false, reason: SELECTION_NOT_FEASIBLE_REASON.NO_COMMITMENTS };
      }
      // Q06／A09：欠けた日を0と推定しない。完全でなければ月次上限を検査できない。
      // ここで返さないと、担当Bの検査が例外を投げて拒否として記録できない。
      if (input.monthlySchedule.completeness !== "COMPLETE") {
        return { ok: false, reason: SELECTION_NOT_FEASIBLE_REASON.INPUT_INCOMPLETE };
      }

      const profiles = new Map(input.staffProfiles.map((profile) => [profile.staffId, profile]));

      for (const chosen of input.selected) {
        const staff = profiles.get(chosen.staffId);
        if (!staff) {
          // 条件を取れていない相手を通さない。検査していないものを合格にしない。
          return {
            ok: false,
            reason: SELECTION_NOT_FEASIBLE_REASON.INPUT_INCOMPLETE,
            staffId: chosen.staffId,
          };
        }
        const result = evaluateCandidateEligibility({
          storeId: input.storeId,
          roleCode: input.requirement.roleCode,
          businessDate: input.businessDate,
          // **承諾時間を自動で短縮しない（ADR-005）。** 承諾した区間をそのまま検査する。
          proposedTime: { startAt: chosen.startAt, endAt: chosen.endAt },
          absentStaffId: input.absentStaffId,
          staff,
          monthlySchedule: input.monthlySchedule,
        });
        if (!result.eligible && result.reason) {
          return { ok: false, reason: reasonOf(result.reason), staffId: chosen.staffId };
        }
        if (!result.eligible) {
          // 理由の無い不適格は想定していない。黙って合格にしない。
          return {
            ok: false,
            reason: SELECTION_NOT_FEASIBLE_REASON.NOT_COVERED,
            staffId: chosen.staffId,
          };
        }
      }

      return { ok: true };
    },
  };
}
