import { describe, expect, it } from "vitest";
import { createSelectionPlanner } from "@/domain/selection";
import { createEligibilityRecheck } from "@/domain/selection/eligibility";
import type { SelectionPlanInput } from "@/contracts/selection";

const at = (time: string) => `2026-09-22T${time}:00+09:00`;
const input: SelectionPlanInput = {
  caseId: "case",
  caseVersion: 1,
  requirement: { roleCode: "FLOOR", startAt: at("18:00"), endAt: at("22:00") },
  inputs: {
    connectionId: "mock:demo",
    scheduleId: "schedule",
    sourceRevision: "revision",
    monthlyRevision: "revision",
    monthlyCompleteness: "COMPLETE",
    missingDates: [],
  },
  candidates: [],
};
const candidate = (id: string, start: string, end: string, seq: number) => ({
  commitmentId: id,
  commitmentVersion: 1,
  staffId: id,
  startAt: at(start),
  endAt: at(end),
  committedSeq: seq,
  plannedShiftAssignmentId: `shift-${id}`,
});

describe("A16 選定", () => {
  it("承諾を短縮せず各区間ちょうど1人で覆う", () => {
    const plan = createSelectionPlanner().plan({
      ...input,
      candidates: [
        candidate("a", "18:00", "20:00", 1),
        candidate("b", "20:00", "22:00", 2),
        candidate("c", "18:00", "22:00", 3),
      ],
    });
    expect(plan.outcome).toBe("FEASIBLE");
    expect(plan.selected.map((s) => s.commitmentId)).toEqual(["c"]);
  });
  it("重複しかない組合せを採用しない", () => {
    const plan = createSelectionPlanner().plan({
      ...input,
      candidates: [candidate("a", "18:00", "21:00", 1), candidate("b", "20:00", "22:00", 2)],
    });
    expect(plan).toMatchObject({ outcome: "NOT_FEASIBLE", notFeasibleReason: "OVERLAP" });
  });
  it("重複と不足が混在しても不足を記録する", () => {
    const plan = createSelectionPlanner().plan({
      ...input,
      candidates: [candidate("a", "18:00", "19:00", 1), candidate("b", "18:30", "19:30", 2)],
    });
    expect(plan).toMatchObject({ outcome: "NOT_FEASIBLE", notFeasibleReason: "NOT_COVERED" });
  });
  it("A09 月内入力不足は不成立と区別して止める", () => {
    expect(() =>
      createSelectionPlanner().plan({
        ...input,
        inputs: {
          ...input.inputs,
          monthlyCompleteness: "INCOMPLETE",
          missingDates: ["2026-09-01"],
        },
      }),
    ).toThrow("月内入力");
  });
  it("再検査は月次snapshotと版が一致しなければ止める", () => {
    expect(() =>
      createEligibilityRecheck().recheck({
        storeId: "store",
        businessDate: "2026-09-22",
        requirement: input.requirement,
        selected: [],
        inputs: input.inputs,
        absentStaffId: "absent",
        staffProfiles: [],
        monthlySchedule: {
          storeId: "store",
          timezone: "Asia/Tokyo",
          month: "2026-09",
          sourceRevision: "changed",
          staffIds: ["staff"],
          completeness: "COMPLETE",
          assignments: [],
        },
      }),
    ).toThrow("版");
  });
});
