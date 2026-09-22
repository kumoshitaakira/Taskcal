/**
 * `SelectionPlanner` と `EligibilityChecker.recheck` の偽物。**テスト専用。**
 *
 * 本物（担当Bの `src/domain/selection/`・`src/domain/interval/`）はまだ無い。合成の根には
 * `NOT_IMPLEMENTED` を投げる実装が入っている。ここで作るのは、正式採用の手順
 * （A02〜A08）が選定の中身に依存せず正しく進むかを確かめるための台。
 *
 * **選定規則そのものを模したものではない。** 渡された候補をそのまま選ぶだけで、
 * 必要枠の被覆・重複の排除（Q02）・月次上限は見ていない。これでA16・A17を
 * 確かめたことにしない。
 */

import type {
  EligibilityChecker,
  EligibilityRecheckResult,
  SelectionNotFeasibleReason,
  SelectionPlanInput,
  SelectionPlanner,
  SelectionResult,
} from "@/contracts/selection";

export const FAKE_RULES_VERSION = "test-selection/0.0.0";

export interface FakeSelectionPlannerOptions {
  /** 常に成立しないことにする（A16の入口だけを確かめる）。 */
  readonly notFeasible?: SelectionNotFeasibleReason;
  /** 選ぶ候補を絞る。既定は全件。 */
  readonly take?: number;
}

export function createFakeSelectionPlanner(
  options: FakeSelectionPlannerOptions = {},
): SelectionPlanner {
  return {
    plan(input: SelectionPlanInput): Omit<SelectionResult, "selectionId" | "decidedAt"> {
      const base = {
        caseId: input.caseId,
        caseVersion: input.caseVersion,
        rulesVersion: FAKE_RULES_VERSION,
        inputs: input.inputs,
      };
      if (options.notFeasible || input.candidates.length === 0) {
        return {
          ...base,
          outcome: "NOT_FEASIBLE",
          // 承諾0件と、規則で選べなかったことを区別する。
          notFeasibleReason: options.notFeasible ?? "NO_COMMITMENTS",
          selected: [],
          notSelectedCommitmentIds: input.candidates.map((c) => c.commitmentId),
        };
      }
      const take = options.take ?? input.candidates.length;
      const chosen = input.candidates.slice(0, take);
      return {
        ...base,
        outcome: "FEASIBLE",
        selected: chosen.map((candidate) => ({
          commitmentId: candidate.commitmentId,
          commitmentVersion: candidate.commitmentVersion,
          staffId: candidate.staffId,
          startAt: candidate.startAt,
          endAt: candidate.endAt,
          plannedShiftAssignmentId: candidate.plannedShiftAssignmentId,
        })),
        // Q07：非選定の相手は確定した時点で通知する。待たせない。
        notSelectedCommitmentIds: input.candidates.slice(take).map((c) => c.commitmentId),
      };
    },
  };
}

export function createFakeEligibilityRecheck(
  result: EligibilityRecheckResult = { ok: true },
): Pick<EligibilityChecker, "recheck"> {
  return { recheck: () => result };
}
