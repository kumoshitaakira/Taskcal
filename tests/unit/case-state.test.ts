import { describe, expect, it } from "vitest";
import {
  CASE_STATES,
  TERMINAL_CASE_STATES,
  isAllowedCaseTransition,
  type CaseState,
} from "@/contracts/case-state";

/**
 * RFC-011 §5 の状態図の全エッジ。図を写したものであり、コード側の表とは独立に書く。
 * 片方だけ変更しても検出できるようにするため。
 */
const FIGURE_EDGES: readonly [CaseState, CaseState][] = [
  ["COORDINATING", "COORDINATING"],
  ["COORDINATING", "PREPARING"],
  ["COORDINATING", "HANDED_OFF"],
  ["COORDINATING", "CANCELLED"],
  ["PREPARING", "COORDINATING"],
  ["PREPARING", "COMMITTED"],
  ["PREPARING", "RECONCILE_REQUIRED"],
  ["PREPARING", "CANCELLED"],
  ["RECONCILE_REQUIRED", "COMMITTED"],
  ["RECONCILE_REQUIRED", "COORDINATING"],
  ["COMMITTED", "REPORTING"],
  ["COMMITTED", "ATTENTION"],
  ["REPORTING", "COMPLETED"],
  ["REPORTING", "ATTENTION"],
  ["ATTENTION", "REPORTING"],
];

describe("案件状態の遷移（RFC-011 §5）", () => {
  it("正式採用の照合が必要な状態から、確定済みと未確定の両方へ進める", () => {
    expect(isAllowedCaseTransition("RECONCILE_REQUIRED", "COMMITTED")).toBe(true);
    expect(isAllowedCaseTransition("RECONCILE_REQUIRED", "COORDINATING")).toBe(true);
  });

  it("確定後は調整へ戻らない（確定済みの事実を巻き戻さない: D09）", () => {
    expect(isAllowedCaseTransition("COMMITTED", "COORDINATING")).toBe(false);
    expect(isAllowedCaseTransition("COMMITTED", "PREPARING")).toBe(false);
  });

  it("読戻しや通知の失敗は要対応であり、未確定へ落とさない（A13）", () => {
    expect(isAllowedCaseTransition("COMMITTED", "ATTENTION")).toBe(true);
    expect(isAllowedCaseTransition("ATTENTION", "REPORTING")).toBe(true);
    expect(isAllowedCaseTransition("ATTENTION", "COORDINATING")).toBe(false);
  });

  it("停止は正式採用より前の段階でのみ成立する（D10）", () => {
    expect(isAllowedCaseTransition("COORDINATING", "CANCELLED")).toBe(true);
    expect(isAllowedCaseTransition("PREPARING", "CANCELLED")).toBe(true);
    expect(isAllowedCaseTransition("COMMITTED", "CANCELLED")).toBe(false);
  });

  it("9x9の全組合せがRFC-011 §5の図と一致する", () => {
    const expected = new Set(FIGURE_EDGES.map(([from, to]) => `${from}->${to}`));
    const actual = new Set<string>();
    for (const from of CASE_STATES) {
      for (const to of CASE_STATES) {
        if (isAllowedCaseTransition(from, to)) actual.add(`${from}->${to}`);
      }
    }
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("検査を飛ばした採用（調整中から直接確定）を許さない", () => {
    expect(isAllowedCaseTransition("COORDINATING", "COMMITTED")).toBe(false);
  });

  it("未知の状態を黙って遷移禁止として扱わず、拒否する", () => {
    expect(() => isAllowedCaseTransition("NOT_A_STATE" as CaseState, "COMMITTED")).toThrow();
  });

  it("終端状態から先へ進まない", () => {
    for (const state of TERMINAL_CASE_STATES) {
      const targets: CaseState[] = ["COORDINATING", "PREPARING", "COMMITTED"];
      for (const to of targets) {
        expect(isAllowedCaseTransition(state, to)).toBe(false);
      }
    }
  });
});
