import { describe, expect, it } from "vitest";
import {
  ADOPTION_FACT,
  CASE_STATES,
  canResumeReporting,
  resolvePreparingStop,
  resolveReconcileStall,
  TERMINAL_CASE_STATES,
  isAllowedCaseTransition,
  type CaseState,
} from "@/contracts/case-state";

/**
 * RFC-011 §5 の状態図の全エッジ＋ADR-022で追加した3本。
 * 図を写したものであり、コード側の表とは独立に書く。片方だけ変更しても検出するため。
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
  // ADR-022（Q11〜Q13）で追加した経路。
  ["RECONCILE_REQUIRED", "ATTENTION"],
  ["ATTENTION", "HANDED_OFF"],
  ["PREPARING", "HANDED_OFF"],
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

  it("復旧しない要対応から終端へ引き継げる（Q12 / A13）", () => {
    expect(isAllowedCaseTransition("ATTENTION", "HANDED_OFF")).toBe(true);
  });

  it("照合が必要な状態から要対応へ回せる（Q11 / A03）", () => {
    expect(isAllowedCaseTransition("RECONCILE_REQUIRED", "ATTENTION")).toBe(true);
  });

  it("停止は正式採用より前の段階でのみ成立する（D10）", () => {
    expect(isAllowedCaseTransition("COORDINATING", "CANCELLED")).toBe(true);
    expect(isAllowedCaseTransition("PREPARING", "CANCELLED")).toBe(true);
    expect(isAllowedCaseTransition("COMMITTED", "CANCELLED")).toBe(false);
  });

  it("9x9の全組合せが図＋ADR-022の追加分と一致する", () => {
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

  it("Q11: 照会経路が使えるうちは状態を動かさない", () => {
    expect(resolveReconcileStall({ lookupStillPossible: true })).toBe("RECONCILE_REQUIRED");
    expect(resolveReconcileStall({ lookupStillPossible: false })).toBe("ATTENTION");
  });

  it("Q12: 採用済みと確認でき、読戻しが一致した場合だけ通知処理へ戻す", () => {
    expect(canResumeReporting({ adoptionFact: ADOPTION_FACT.ADOPTED, readBackMatches: true })).toBe(
      true,
    );
    // 読戻し未確認のまま通知処理へ進まない。
    expect(
      canResumeReporting({ adoptionFact: ADOPTION_FACT.ADOPTED, readBackMatches: false }),
    ).toBe(false);
    expect(canResumeReporting({ adoptionFact: ADOPTION_FACT.UNKNOWN, readBackMatches: true })).toBe(
      false,
    );
  });

  it("Q13: 期限を検知しただけで引き継がず、採用結果を先に確定させる（A18）", () => {
    // 未採用を確認できたときだけ引き継ぐ。
    expect(resolvePreparingStop({ adoptionFact: ADOPTION_FACT.NOT_ADOPTED })).toBe("HANDED_OFF");
    // すでに採用済みなら確定事実を保持する。
    expect(resolvePreparingStop({ adoptionFact: ADOPTION_FACT.ADOPTED })).toBe("COMMITTED");
    // 結果不明なら引き継がず照合へ回す。未採用と断定しない。
    expect(resolvePreparingStop({ adoptionFact: ADOPTION_FACT.UNKNOWN })).toBe(
      "RECONCILE_REQUIRED",
    );
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
