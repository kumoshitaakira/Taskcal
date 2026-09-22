/**
 * 候補選定（RFC-009 §6、Q02、A16）。担当Bの純粋関数を直接確かめる。
 *
 * ここで見るのは「どの組合せを選ぶか」「なぜ選べないか」。承諾の版・未処理返信・期限の
 * 検査は呼出し元（`adopt-plan.ts`）が `isSelectableCommitment` で済ませてから渡す。
 */

import { describe, expect, it } from "vitest";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import type { SelectionCandidate, SelectionPlanInput } from "@/contracts/selection";
import { planExactlyOneCoverage, SELECTION_RULES_VERSION } from "@/domain/selection";

const REQ = {
  roleCode: "FLOOR",
  startAt: "2026-09-26T18:00:00+09:00",
  endAt: "2026-09-26T22:00:00+09:00",
};

function candidate(
  id: string,
  startAt: string,
  endAt: string,
  committedSeq: number,
  staffId = `staff-${id}`,
): SelectionCandidate {
  return {
    commitmentId: id,
    commitmentVersion: 1,
    staffId,
    startAt: `2026-09-26T${startAt}:00+09:00`,
    endAt: `2026-09-26T${endAt}:00+09:00`,
    committedSeq,
    plannedShiftAssignmentId: `shift-${id}`,
  };
}

function input(
  candidates: readonly SelectionCandidate[],
  completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN" = "COMPLETE",
): SelectionPlanInput {
  return {
    caseId: "case-1",
    caseVersion: 3,
    requirement: REQ,
    candidates,
    inputs: {
      connectionId: "mock:test",
      scheduleId: "schedule-1",
      sourceRevision: "a".repeat(64),
      monthlyCompleteness: completeness,
      missingDates: completeness === "COMPLETE" ? [] : ["2026-09-30"],
    },
  };
}

describe("Q02：各区間ちょうど1人で必要枠を覆う", () => {
  it("A16：B 18〜20、C 19〜22 は重なるので採用しない。和集合では覆えるので理由は OVERLAP", () => {
    const plan = planExactlyOneCoverage(
      input([candidate("b", "18:00", "20:00", 1), candidate("c", "19:00", "22:00", 2)]),
    );
    expect(plan).toMatchObject({ outcome: "NOT_FEASIBLE", notFeasibleReason: "OVERLAP" });
    expect(plan.selected).toEqual([]);
    // 不成立でも誰が候補だったかは残す（Q07：非選定通知の宛先）。
    expect(plan.notSelectedCommitmentIds).toEqual(["b", "c"]);
    expect(plan.rulesVersion).toBe(SELECTION_RULES_VERSION);
  });

  it("隙間なく繋がる2人の組合せは採用し、承諾区間をそのまま使う", () => {
    const plan = planExactlyOneCoverage(
      input([candidate("b", "18:00", "20:00", 1), candidate("c", "20:00", "22:00", 2)]),
    );
    expect(plan.outcome).toBe("FEASIBLE");
    expect(plan.selected.map((s) => s.commitmentId)).toEqual(["b", "c"]);
    expect(plan.selected[0]).toMatchObject({
      startAt: "2026-09-26T18:00:00+09:00",
      endAt: "2026-09-26T20:00:00+09:00",
      plannedShiftAssignmentId: "shift-b",
      commitmentVersion: 1,
    });
    expect(plan.notSelectedCommitmentIds).toEqual([]);
  });

  it("人数が少ない計画を優先する（勤務時間合計は完全充足なら同率）", () => {
    const plan = planExactlyOneCoverage(
      input([
        candidate("b", "18:00", "20:00", 1),
        candidate("c", "20:00", "22:00", 2),
        candidate("d", "18:00", "22:00", 3),
      ]),
    );
    expect(plan.selected.map((s) => s.commitmentId)).toEqual(["d"]);
    expect(plan.notSelectedCommitmentIds).toEqual(["b", "c"]);
  });

  it("同人数なら承諾が早く揃った方、それも同じなら安定ID順", () => {
    const earlier = planExactlyOneCoverage(
      input([candidate("z", "18:00", "22:00", 1), candidate("a", "18:00", "22:00", 2)]),
    );
    expect(earlier.selected.map((s) => s.commitmentId)).toEqual(["z"]);

    const tie = planExactlyOneCoverage(
      input([candidate("z", "18:00", "22:00", 5), candidate("a", "18:00", "22:00", 5)]),
    );
    expect(tie.selected.map((s) => s.commitmentId)).toEqual(["a"]);
  });

  it("ADR-005：必要枠からはみ出す承諾は切り詰めずに使わない。それだけなら NOT_COVERED", () => {
    const plan = planExactlyOneCoverage(input([candidate("b", "17:00", "22:00", 1)]));
    expect(plan).toMatchObject({ outcome: "NOT_FEASIBLE", notFeasibleReason: "NOT_COVERED" });

    // はみ出す承諾があっても、収まる承諾だけで覆えれば成立する。
    const mixed = planExactlyOneCoverage(
      input([candidate("b", "17:00", "22:00", 1), candidate("c", "18:00", "22:00", 2)]),
    );
    expect(mixed.selected.map((s) => s.commitmentId)).toEqual(["c"]);
    expect(mixed.notSelectedCommitmentIds).toEqual(["b"]);
  });

  it("隙間が残る承諾だけなら NOT_COVERED", () => {
    const plan = planExactlyOneCoverage(input([candidate("b", "18:00", "20:00", 1)]));
    expect(plan).toMatchObject({ outcome: "NOT_FEASIBLE", notFeasibleReason: "NOT_COVERED" });
  });

  it("承諾が無ければ NO_COMMITMENTS", () => {
    expect(planExactlyOneCoverage(input([]))).toMatchObject({
      outcome: "NOT_FEASIBLE",
      notFeasibleReason: "NO_COMMITMENTS",
    });
  });

  it("Q06／A09：月内入力が完全でなければ計画を評価せず INPUT_INCOMPLETE", () => {
    const plan = planExactlyOneCoverage(input([candidate("d", "18:00", "22:00", 1)], "INCOMPLETE"));
    expect(plan).toMatchObject({ outcome: "NOT_FEASIBLE", notFeasibleReason: "INPUT_INCOMPLETE" });
    expect(plan.notSelectedCommitmentIds).toEqual(["d"]);
  });

  it("D04：同じスタッフの選定可能な承諾が複数あれば、黙って片方を選ばず断る", () => {
    expect(() =>
      planExactlyOneCoverage(
        input([
          candidate("b", "18:00", "20:00", 1, "same"),
          candidate("c", "20:00", "22:00", 2, "same"),
        ]),
      ),
    ).toThrow(TaskcalError);
  });

  it("Q10：候補が上限を超えたら範囲外として断る（先頭だけを見ない）", () => {
    const many = Array.from({ length: 9 }, (_, i) => candidate(`c${i}`, "18:00", "22:00", i + 1));
    let thrown: unknown;
    try {
      planExactlyOneCoverage(input(many));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as TaskcalError).code).toBe(ERROR_CODES.OUT_OF_SCOPE);
  });

  it("開始が終了以後の承諾は黙って除外せず、入力の破損として断る", () => {
    const broken: SelectionCandidate = {
      ...candidate("b", "18:00", "22:00", 1),
      endAt: "2026-09-26T18:00:00+09:00",
    };
    expect(() => planExactlyOneCoverage(input([broken]))).toThrow(TaskcalError);
  });

  it("タイムゾーンの無い日時は受け取らない", () => {
    const naive: SelectionCandidate = {
      ...candidate("b", "18:00", "22:00", 1),
      startAt: "2026-09-26T18:00:00",
    };
    expect(() => planExactlyOneCoverage(input([naive]))).toThrow(TaskcalError);
  });
});
