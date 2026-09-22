import { TaskcalError } from "../../contracts/errors";
import type {
  SelectionCandidate,
  SelectionPlanInput,
  SelectionPlanner,
} from "../../contracts/selection";
import { validateCandidateTimeRange, validateTimeRange } from "../interval";

const RULES_VERSION = "exactly-one-v1";

/** 承諾区間を変えず、必要枠を隙間も重複もなく覆う組合せを探す。 */
export function createSelectionPlanner(): SelectionPlanner {
  return {
    plan(input: SelectionPlanInput) {
      if (input.inputs.monthlyCompleteness !== "COMPLETE" || input.inputs.missingDates.length) {
        throw new TaskcalError("INVALID_INPUT", "月内入力が完全ではありません。");
      }
      const required = validateTimeRange(input.requirement);
      const candidates = [...input.candidates].sort(
        (a, b) => a.committedSeq - b.committedSeq || a.commitmentId.localeCompare(b.commitmentId),
      );
      const ids = new Set<string>();
      for (const candidate of candidates) {
        if (
          ids.has(candidate.commitmentId) ||
          !candidate.commitmentId ||
          !candidate.staffId ||
          !Number.isSafeInteger(candidate.commitmentVersion) ||
          candidate.commitmentVersion < 1 ||
          !Number.isSafeInteger(candidate.committedSeq) ||
          candidate.committedSeq < 0
        ) {
          throw new TaskcalError("INVALID_INPUT", "承諾の識別子または版が不正です。");
        }
        ids.add(candidate.commitmentId);
        validateCandidateTimeRange(candidate, input.requirement.startAt.slice(0, 10));
      }
      const valid = candidates.filter(
        (candidate) =>
          Date.parse(candidate.startAt) >= required.startMs &&
          Date.parse(candidate.endAt) <= required.endMs,
      );
      const solutions: SelectionCandidate[][] = [];
      function search(cursor: number, selected: SelectionCandidate[]): void {
        if (cursor === required.endMs) {
          solutions.push([...selected]);
          return;
        }
        if (solutions.length > 1000) return;
        for (const candidate of valid) {
          if (Date.parse(candidate.startAt) !== cursor) continue;
          if (selected.some((item) => item.staffId === candidate.staffId)) continue;
          search(Date.parse(candidate.endAt), [...selected, candidate]);
        }
      }
      search(required.startMs, []);
      solutions.sort(
        (a, b) =>
          a.length - b.length ||
          a
            .map((c) => `${String(c.committedSeq).padStart(12, "0")}:${c.commitmentId}`)
            .join("|")
            .localeCompare(
              b
                .map((c) => `${String(c.committedSeq).padStart(12, "0")}:${c.commitmentId}`)
                .join("|"),
            ),
      );
      const chosen = solutions[0];
      const base = {
        caseId: input.caseId,
        caseVersion: input.caseVersion,
        rulesVersion: RULES_VERSION,
        inputs: input.inputs,
      };
      if (!chosen) {
        let coveredUntil = required.startMs;
        for (const candidate of [...valid].sort(
          (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt),
        )) {
          if (Date.parse(candidate.startAt) > coveredUntil) break;
          coveredUntil = Math.max(coveredUntil, Date.parse(candidate.endAt));
        }
        return {
          ...base,
          outcome: "NOT_FEASIBLE" as const,
          notFeasibleReason:
            candidates.length === 0
              ? ("NO_COMMITMENTS" as const)
              : coveredUntil >= required.endMs
                ? ("OVERLAP" as const)
                : ("NOT_COVERED" as const),
          selected: [],
          notSelectedCommitmentIds: candidates.map((c) => c.commitmentId),
        };
      }
      const chosenIds = new Set(chosen.map((c) => c.commitmentId));
      return {
        ...base,
        outcome: "FEASIBLE" as const,
        selected: chosen.map(
          ({
            commitmentId,
            commitmentVersion,
            staffId,
            startAt,
            endAt,
            plannedShiftAssignmentId,
          }) => ({
            commitmentId,
            commitmentVersion,
            staffId,
            startAt,
            endAt,
            plannedShiftAssignmentId,
          }),
        ),
        notSelectedCommitmentIds: candidates
          .filter((c) => !chosenIds.has(c.commitmentId))
          .map((c) => c.commitmentId),
      };
    },
  };
}
