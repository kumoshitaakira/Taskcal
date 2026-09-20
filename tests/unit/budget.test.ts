import { describe, expect, it } from "vitest";
import {
  BudgetGuard,
  DEFAULT_MAX_CALLS_PER_CASE,
  RESERVATION_RESULT,
  type BudgetLedger,
  type RequiredBudgetLimits,
  type Reservation,
} from "@/adapters/orca/budget";
import { ERROR_CODES } from "@/contracts/errors";

/** 判定と加算を1つの操作で行う台帳（DB実装の代役）。 */
function ledgerOf(state: { caseJpy: number; totalJpy: number; calls: number }): BudgetLedger & {
  seenLimits: RequiredBudgetLimits[];
} {
  const seenLimits: RequiredBudgetLimits[] = [];
  return {
    seenLimits,
    async tryReserve(reservation: Reservation, limits: RequiredBudgetLimits) {
      seenLimits.push(limits);
      if (state.calls + 1 > limits.maxCallsPerCase) return RESERVATION_RESULT.EXCEEDED_CALLS;
      if (state.caseJpy + reservation.estimatedJpy > limits.perCaseJpy) {
        return RESERVATION_RESULT.EXCEEDED_CASE_JPY;
      }
      if (state.totalJpy + reservation.estimatedJpy > limits.totalJpy) {
        return RESERVATION_RESULT.EXCEEDED_TOTAL_JPY;
      }
      state.caseJpy += reservation.estimatedJpy;
      state.totalJpy += reservation.estimatedJpy;
      state.calls += 1;
      return RESERVATION_RESULT.RESERVED;
    },
  };
}

const reservation: Reservation = { caseId: "c1", callId: "call-1", estimatedJpy: 5 };

describe("BudgetGuard（ADR-007 / Q10）", () => {
  it("金額予算が未設定なら呼出しを開始しない", async () => {
    const guard = new BudgetGuard({}, ledgerOf({ caseJpy: 0, totalJpy: 0, calls: 0 }));
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_NOT_CONFIGURED,
    });
  });

  it("費用見積りが0なら呼出しを開始しない（0を許すと金額上限が無効になる）", async () => {
    const guard = new BudgetGuard(
      { perCaseJpy: 100, totalJpy: 100 },
      ledgerOf({ caseJpy: 0, totalJpy: 0, calls: 0 }),
    );
    await expect(guard.reserve({ ...reservation, estimatedJpy: 0 })).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_NOT_CONFIGURED,
    });
  });

  it("案件の金額上限を超える予約を拒否する", async () => {
    const guard = new BudgetGuard(
      { perCaseJpy: 6, totalJpy: 1000 },
      ledgerOf({ caseJpy: 3, totalJpy: 3, calls: 1 }),
    );
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_EXCEEDED,
    });
  });

  it("全体の金額上限を超える予約を拒否する", async () => {
    const guard = new BudgetGuard(
      { perCaseJpy: 1000, totalJpy: 6 },
      ledgerOf({ caseJpy: 3, totalJpy: 3, calls: 1 }),
    );
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_EXCEEDED,
    });
  });

  it("回数上限に達したら新規実行を止める（D12）", async () => {
    const guard = new BudgetGuard(
      { perCaseJpy: 1000, totalJpy: 1000, maxCallsPerCase: 2 },
      ledgerOf({ caseJpy: 0, totalJpy: 0, calls: 2 }),
    );
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_EXCEEDED,
    });
  });

  it("回数上限が未設定でも無制限にしない（ADR-007の初期値を既定にする）", async () => {
    const ledger = ledgerOf({ caseJpy: 0, totalJpy: 0, calls: 0 });
    const guard = new BudgetGuard({ perCaseJpy: 1000, totalJpy: 1000 }, ledger);
    await guard.reserve(reservation);
    expect(ledger.seenLimits[0]?.maxCallsPerCase).toBe(DEFAULT_MAX_CALLS_PER_CASE);
  });

  it("検査と加算を1回の台帳操作で行う（同時返信で上限をすり抜けさせない）", async () => {
    const state = { caseJpy: 0, totalJpy: 0, calls: 0 };
    const guard = new BudgetGuard({ perCaseJpy: 12, totalJpy: 1000 }, ledgerOf(state));

    // 5円×3本を同時に投げると、12円の上限では2本しか通らない。
    const results = await Promise.allSettled([
      guard.reserve({ ...reservation, callId: "a" }),
      guard.reserve({ ...reservation, callId: "b" }),
      guard.reserve({ ...reservation, callId: "c" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(state.caseJpy).toBe(10);
  });

  it("上限内なら予約して呼出しを許可する", async () => {
    const state = { caseJpy: 0, totalJpy: 0, calls: 0 };
    const guard = new BudgetGuard({ perCaseJpy: 100, totalJpy: 100 }, ledgerOf(state));
    await guard.reserve(reservation);
    expect(state.caseJpy).toBe(5);
    expect(state.calls).toBe(1);
  });
});
