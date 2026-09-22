import { TaskcalError } from "../../contracts/errors";
import type { EligibilityChecker, EligibilityRecheckResult } from "../../contracts/selection";
import { evaluateCandidateEligibility } from "../interval";

export function createEligibilityRecheck(): Pick<EligibilityChecker, "recheck"> {
  return {
    recheck(input): EligibilityRecheckResult {
      if (
        input.inputs.monthlyCompleteness !== "COMPLETE" ||
        input.inputs.missingDates.length ||
        input.monthlySchedule.completeness !== "COMPLETE" ||
        !input.inputs.monthlyRevision ||
        input.monthlySchedule.sourceRevision !== input.inputs.monthlyRevision
      ) {
        throw new TaskcalError("INVALID_INPUT", "月内勤務の完全性または版を検査できません。");
      }
      for (const selected of input.selected) {
        const staff = input.staffProfiles.find((profile) => profile.staffId === selected.staffId);
        if (!staff) throw new TaskcalError("INVALID_INPUT", "スタッフ条件を確認できません。");
        const result = evaluateCandidateEligibility({
          storeId: input.storeId,
          roleCode: input.requirement.roleCode,
          businessDate: input.requirement.startAt.slice(0, 10),
          proposedTime: selected,
          absentStaffId: input.absentStaffId,
          staff,
          monthlySchedule: input.monthlySchedule,
        });
        if (!result.eligible) {
          return {
            ok: false,
            reason: result.reason === "MONTHLY_CAP_EXCEEDED" ? "MONTHLY_CAP" : "NOT_COVERED",
            staffId: selected.staffId,
          };
        }
      }
      return { ok: true };
    },
  };
}
