/**
 * 打診先の適格性（RFC-011 §2「適格な全員へ個別に打診」、D01、Q06／A09、Q15）。
 *
 * 規則そのものは担当Bの `evaluateCandidateEligibility`（`src/domain/interval/`）。
 * ここがやるのは、名簿・スタッフ条件・打診の直前に読んだ月内勤務表を、その規則が
 * 受け取る形へ写し、結果を「打診する相手」と「外した相手と理由」に分けること。
 * 判定を書き直さない（規則が二箇所に分かれる）。
 *
 * ## 可能時間について
 *
 * 打診の時点では本人の返信が無く、可能時間表も無い。`availabilityWindows` には
 * **必要枠そのもの**を入れる。したがって実際に効くのは在籍・店舗・職種・本人除外・
 * 同日の勤務との重複・月次上限で、**可能時間そのものは検査していない**。
 *
 * ## 月内入力が完全でないとき
 *
 * 月次上限を検査できないので、打診を始めない（`INVALID_INPUT`）。名簿だけで打診すると、
 * 正式採用の直前で全員が外れる案件を作ることになる。欠けた日を0と推定しない（A09）。
 */

import "server-only";
import type { LoadedSchedule } from "../contracts/schedule-gateway";
import type { CaseSnapshot, StaffConditions } from "../contracts/repository";
import { ERROR_CODES, TaskcalError } from "../contracts/errors";
import type {
  EligibilityChecker,
  EligibilityInput,
  EligibilityListing,
  EligibleCandidate,
  RosterCandidate,
  SelectionInputs,
} from "../contracts/selection";
import { evaluateCandidateEligibility, toJstFixedFormat } from "@/domain/interval";

function nextMonth(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
}

/**
 * 判定の入力を組み立てる。
 *
 * `reloaded` は**打診の直前に読んだ**月内勤務表。`conditions` はその時点のスタッフ条件。
 * `buildRecheckInput`（採用直前）と同じ規則で時刻を Asia/Tokyo 固定形式へ写し、
 * 判定に要る行（名簿上の候補の、対象月の勤務）だけを渡す。
 */
export function buildListEligibleInput(input: {
  readonly snapshot: Pick<
    CaseSnapshot,
    | "storeId"
    | "businessDate"
    | "absentStaffId"
    | "roleCode"
    | "requiredStartAt"
    | "requiredEndAt"
    | "connectionId"
    | "scheduleId"
  >;
  readonly storeTimezone: string;
  readonly reloaded: LoadedSchedule;
  readonly conditions: readonly StaffConditions[];
  readonly roster: readonly RosterCandidate[];
}): EligibilityInput {
  const month = input.snapshot.businessDate.slice(0, 7);
  const range = input.reloaded.requestedRange;
  if (range.fromDate > `${month}-01` || range.toDate < `${nextMonth(month)}-01`) {
    throw new TaskcalError(
      ERROR_CODES.INVALID_INPUT,
      `勤務表の取得範囲が対象月（${month}）を覆っていません: ${range.fromDate}〜${range.toDate}`,
    );
  }

  const requirement = {
    roleCode: input.snapshot.roleCode,
    startAt: toJstFixedFormat(input.snapshot.requiredStartAt),
    endAt: toJstFixedFormat(input.snapshot.requiredEndAt),
  };
  const rosterStaff = new Set(input.roster.map((candidate) => candidate.staffId));
  // 月次上限の対象集合は**範囲宣言**から取る。名簿から作ると、宣言に無い相手が
  // 「勤務0件＝残枠あり」で通る（Q06／A09：欠けた入力を0と推定しない）。宣言を持たない
  // 接続だけ、判定対象そのもので代用する。
  const declared = input.reloaded.declaredStaffIds
    ? new Set(input.reloaded.declaredStaffIds)
    : rosterStaff;
  const assignments = input.reloaded.assignments
    .filter((assignment) => rosterStaff.has(assignment.staffId) && declared.has(assignment.staffId))
    .map((assignment) => {
      const startAt = toJstFixedFormat(assignment.startAt);
      return {
        shiftAssignmentId: assignment.shiftAssignmentId,
        businessDate: startAt.slice(0, 10),
        staffId: assignment.staffId,
        roleCode: assignment.roleCode,
        startAt,
        endAt: toJstFixedFormat(assignment.endAt),
        status: assignment.status,
      };
    })
    .filter((assignment) => assignment.businessDate.slice(0, 7) === month);

  const inputs: SelectionInputs = {
    connectionId: input.snapshot.connectionId,
    scheduleId: input.snapshot.scheduleId,
    sourceRevision: input.reloaded.sourceRevision,
    monthlyCompleteness: input.reloaded.completeness,
    missingDates: [...input.reloaded.missingDates],
  };

  return {
    storeId: input.snapshot.storeId,
    requirement,
    absentStaffId: input.snapshot.absentStaffId,
    inputs,
    businessDate: input.snapshot.businessDate,
    roster: input.roster,
    monthlySchedule: {
      storeId: input.snapshot.storeId,
      timezone: input.storeTimezone,
      month,
      sourceRevision: input.reloaded.sourceRevision,
      staffIds: [...declared],
      completeness: input.reloaded.completeness,
      assignments,
    },
    staffProfiles: input.conditions
      .filter((row) => rosterStaff.has(row.staffId))
      .map((row) => ({
        staffId: row.staffId,
        storeId: row.storeId,
        status: row.active ? ("ACTIVE" as const) : ("INACTIVE" as const),
        roleCodes: [row.roleCode],
        // 可能時間表が無い。必要枠そのものを可能時間として渡す（上記）。
        availabilityWindows: [{ startAt: requirement.startAt, endAt: requirement.endAt }],
        monthlyWorkLimits: [{ targetMonth: month, limitMinutes: row.monthlyCapMinutes }],
      })),
  };
}

export function createOutreachEligibility(): Pick<EligibilityChecker, "listEligible"> {
  return {
    listEligible(input: EligibilityInput): EligibilityListing {
      if (input.monthlySchedule.completeness !== "COMPLETE") {
        // Q06／A09：完全でなければ月次上限を検査できない。名簿だけで打診しない。
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          `月内入力が完全ではありません（${input.monthlySchedule.completeness}）。候補の適格性を検査できないため、打診を始めません。`,
        );
      }
      const profiles = new Map(input.staffProfiles.map((profile) => [profile.staffId, profile]));
      const eligible: EligibleCandidate[] = [];
      const excluded: EligibilityListing["excluded"][number][] = [];

      for (const candidate of input.roster) {
        const staff = profiles.get(candidate.staffId);
        if (!staff) {
          // 条件を取れていない相手へ打診しない。検査していないものを通さない。
          excluded.push({ staffId: candidate.staffId, reason: "CONDITIONS_MISSING" });
          continue;
        }
        const result = evaluateCandidateEligibility({
          storeId: input.storeId,
          roleCode: input.requirement.roleCode,
          businessDate: input.businessDate,
          proposedTime: { startAt: input.requirement.startAt, endAt: input.requirement.endAt },
          absentStaffId: input.absentStaffId,
          staff,
          monthlySchedule: input.monthlySchedule,
        });
        if (!result.eligible) {
          excluded.push({
            staffId: candidate.staffId,
            reason: result.reason ?? "AVAILABILITY_NOT_COVERED",
          });
          continue;
        }
        eligible.push({
          staffId: candidate.staffId,
          endpointKey: candidate.endpointKey,
          endpointVersion: candidate.endpointVersion,
          // 提示するのは必要枠そのもの。可能時間で切り詰めない（ADR-005）。
          offeredStartAt: input.requirement.startAt,
          offeredEndAt: input.requirement.endAt,
        });
      }
      return { eligible, excluded };
    },
  };
}
