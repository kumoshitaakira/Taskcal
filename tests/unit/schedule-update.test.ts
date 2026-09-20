import { describe, expect, it } from "vitest";
import {
  RECONCILE_FINDING,
  SCHEDULE_UPDATE_STATES,
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

  it("成否不明を成功にも確定失敗にも畳まない", () => {
    expect(isOutcomeUnknown("UNKNOWN")).toBe(true);
    expect(isOutcomeUnknown("PARTIAL")).toBe(true);
    expect(isOutcomeUnknown("NOT_APPLIED")).toBe(false);
    expect(isOutcomeUnknown("PREPARED")).toBe(false);
  });
});
