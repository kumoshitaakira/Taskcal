import { describe, expect, it } from "vitest";
import { TaskcalError } from "@/contracts/errors";
import {
  RECONCILE_FINDING,
  SCHEDULE_UPDATE_STATES,
  TERMINAL_SCHEDULE_UPDATE_STATES,
  type ScheduleUpdateState,
  isAllowedScheduleUpdateTransition,
  isOutcomeUnknown,
  resolveReconcile,
} from "@/contracts/schedule-update";

describe("ScheduleUpdateの状態（RFC-010 §6・§7）", () => {
  it("作業用成果物の作成と正式採用を分ける", () => {
    expect(isAllowedScheduleUpdateTransition("PREPARING", "ADOPTED")).toBe(false);
    expect(isAllowedScheduleUpdateTransition("PREPARED", "ADOPTED")).toBe(true);
  });

  it("照合が必要な状態から、採用と破棄の両方へ進める（RFC-010 §7）", () => {
    expect(isAllowedScheduleUpdateTransition("RECONCILE_REQUIRED", "ADOPTED")).toBe(true);
    expect(isAllowedScheduleUpdateTransition("RECONCILE_REQUIRED", "REJECTED")).toBe(true);
  });

  it("採用済みから他の状態へ戻さない（確定済みの取消は別操作: D10）", () => {
    for (const to of SCHEDULE_UPDATE_STATES) {
      expect(isAllowedScheduleUpdateTransition("ADOPTED", to)).toBe(false);
      expect(isAllowedScheduleUpdateTransition("REJECTED", to)).toBe(false);
    }
  });

  it("照合できない間は状態を動かさない（取れなかったを未採用と読み替えない）", () => {
    expect(resolveReconcile(RECONCILE_FINDING.STILL_UNKNOWN)).toBe("RECONCILE_REQUIRED");
    expect(resolveReconcile(RECONCILE_FINDING.CONFIRMED_ADOPTED)).toBe("ADOPTED");
    expect(resolveReconcile(RECONCILE_FINDING.CONFIRMED_NOT_ADOPTED)).toBe("REJECTED");
  });

  it("終端の宣言と遷移表が食い違わない", () => {
    for (const terminal of TERMINAL_SCHEDULE_UPDATE_STATES) {
      for (const to of SCHEDULE_UPDATE_STATES) {
        expect(isAllowedScheduleUpdateTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("未知の状態は遷移禁止ではなく入力エラーにする（案件・打診・承諾と同じ扱い）", () => {
    expect(() =>
      isAllowedScheduleUpdateTransition("UNKNOWN_STATUS" as ScheduleUpdateState, "ADOPTED"),
    ).toThrowError(TaskcalError);
  });

  it("成否不明を成功にも確定失敗にも畳まない", () => {
    expect(isOutcomeUnknown("UNKNOWN")).toBe(true);
    expect(isOutcomeUnknown("PARTIAL")).toBe(true);
    expect(isOutcomeUnknown("NOT_APPLIED")).toBe(false);
    expect(isOutcomeUnknown("PREPARED")).toBe(false);
  });
});
