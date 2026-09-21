import { describe, expect, it } from "vitest";
import {
  BudgetGuard,
  DEFAULT_CASE_CALL_LIMIT,
  RESERVATION_RESULT,
  type BudgetLedger,
  type RequiredBudgetLimits,
  type Reservation,
} from "@/adapters/orca/budget";
import { COST_KIND, MICRO_USD_PER_USD, type CostKind, type MicroUsd } from "@/adapters/orca/usage";
import { ERROR_CODES } from "@/contracts/errors";

interface LedgerState {
  caseSpend: MicroUsd;
  runSpend: MicroUsd;
  calls: number;
  reserved: Map<string, { micro: MicroUsd; hash: string }>;
  settled: { requestId: string; actualMicroUsd?: MicroUsd; costKind: CostKind }[];
}

/** 判定と加算を1つの操作で行う台帳（DB実装の代役）。 */
function ledgerOf(state: LedgerState): BudgetLedger & { seenLimits: RequiredBudgetLimits[] } {
  const seenLimits: RequiredBudgetLimits[] = [];
  return {
    seenLimits,
    async tryReserve(reservation: Reservation, limits: RequiredBudgetLimits) {
      seenLimits.push(limits);
      const existing = state.reserved.get(reservation.requestId);
      if (existing) {
        return existing.hash === reservation.requestHash
          ? RESERVATION_RESULT.ALREADY_RESERVED
          : RESERVATION_RESULT.HASH_MISMATCH;
      }
      if (state.calls + 1 > limits.caseCallLimit) return RESERVATION_RESULT.EXCEEDED_CALLS;
      if (state.caseSpend + reservation.estimatedMicroUsd > limits.caseSpendLimitMicroUsd) {
        return RESERVATION_RESULT.EXCEEDED_CASE_SPEND;
      }
      if (state.runSpend + reservation.estimatedMicroUsd > limits.runSpendLimitMicroUsd) {
        return RESERVATION_RESULT.EXCEEDED_RUN_SPEND;
      }
      state.reserved.set(reservation.requestId, {
        micro: reservation.estimatedMicroUsd,
        hash: reservation.requestHash,
      });
      state.caseSpend += reservation.estimatedMicroUsd;
      state.runSpend += reservation.estimatedMicroUsd;
      state.calls += 1;
      return RESERVATION_RESULT.RESERVED;
    },
    async settle(input) {
      state.settled.push(input);
    },
  };
}

function emptyState(overrides: Partial<LedgerState> = {}): LedgerState {
  return {
    caseSpend: 0,
    runSpend: 0,
    calls: 0,
    reserved: new Map(),
    settled: [],
    ...overrides,
  };
}

/** 0.005 USD。 */
const ESTIMATE: MicroUsd = 5_000;
const reservation: Reservation = {
  caseId: "c1",
  runId: "run-1",
  requestId: "req-1",
  requestHash: "a".repeat(64),
  estimatedMicroUsd: ESTIMATE,
};

describe("BudgetGuard（RFC-004 §7 / ADR-007 / Q10）", () => {
  it("金額上限が未設定なら呼出しを開始しない", async () => {
    const guard = new BudgetGuard({}, ledgerOf(emptyState()));
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_NOT_CONFIGURED,
    });
  });

  it("run_spend_limit だけ未設定でも開始しない", async () => {
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledgerOf(emptyState()),
    );
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_NOT_CONFIGURED,
    });
  });

  it("見積り0・小数・負値を拒否する（金額はUSD整数micro単位）", async () => {
    const limits = {
      caseSpendLimitMicroUsd: MICRO_USD_PER_USD,
      runSpendLimitMicroUsd: MICRO_USD_PER_USD,
    };
    for (const bad of [0, -1, 0.5]) {
      const guard = new BudgetGuard(limits, ledgerOf(emptyState()));
      await expect(guard.reserve({ ...reservation, estimatedMicroUsd: bad })).rejects.toMatchObject(
        { code: ERROR_CODES.BUDGET_NOT_CONFIGURED },
      );
    }
  });

  it("案件の金額上限（case_spend_limit）を超える予約を拒否する", async () => {
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: 6_000, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledgerOf(emptyState({ caseSpend: 3_000, runSpend: 3_000, calls: 1 })),
    );
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_EXCEEDED,
    });
  });

  it("実行全体の金額上限（run_spend_limit）を超える予約を拒否する", async () => {
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: MICRO_USD_PER_USD, runSpendLimitMicroUsd: 6_000 },
      ledgerOf(emptyState({ caseSpend: 3_000, runSpend: 3_000, calls: 1 })),
    );
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_EXCEEDED,
    });
  });

  it("回数上限に達したら新規実行を止める（D12）", async () => {
    const guard = new BudgetGuard(
      {
        caseSpendLimitMicroUsd: MICRO_USD_PER_USD,
        runSpendLimitMicroUsd: MICRO_USD_PER_USD,
        caseCallLimit: 2,
      },
      ledgerOf(emptyState({ calls: 2 })),
    );
    await expect(guard.reserve(reservation)).rejects.toMatchObject({
      code: ERROR_CODES.BUDGET_EXCEEDED,
    });
  });

  it("回数上限が未設定でも無制限にしない（ADR-007の初期値を既定にする）", async () => {
    const ledger = ledgerOf(emptyState());
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: MICRO_USD_PER_USD, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledger,
    );
    await guard.reserve(reservation);
    expect(ledger.seenLimits[0]?.caseCallLimit).toBe(DEFAULT_CASE_CALL_LIMIT);
  });

  it("同じ requestId の再試行で二重に予約しない（worker再起動・lease失効）", async () => {
    const state = emptyState();
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: MICRO_USD_PER_USD, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledgerOf(state),
    );
    expect(await guard.reserve(reservation)).toBe(RESERVATION_RESULT.RESERVED);
    // 2回目は ALREADY_RESERVED を返す。これは「呼出してよい」ではない。
    expect(await guard.reserve(reservation)).toBe(RESERVATION_RESULT.ALREADY_RESERVED);
    expect(state.calls).toBe(1);
    expect(state.caseSpend).toBe(ESTIMATE);
  });

  it("同じ requestId で内容が異なれば拒否する（D07）", async () => {
    const state = emptyState();
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: MICRO_USD_PER_USD, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledgerOf(state),
    );
    await guard.reserve(reservation);
    await expect(
      guard.reserve({ ...reservation, requestHash: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: ERROR_CODES.OPERATION_CONFLICT });
    expect(state.calls).toBe(1);
  });

  it("検査と加算を1回の台帳操作で行う（同時返信で上限をすり抜けさせない）", async () => {
    const state = emptyState();
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: 12_000, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledgerOf(state),
    );

    // 5,000 micro × 3本を同時に投げると、12,000 の上限では2本しか通らない。
    const results = await Promise.allSettled([
      guard.reserve({ ...reservation, requestId: "a" }),
      guard.reserve({ ...reservation, requestId: "b" }),
      guard.reserve({ ...reservation, requestId: "c" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(state.caseSpend).toBe(10_000);
  });

  it("課金不明でも精算で予約を取り消さない（0円と扱わない）", async () => {
    const state = emptyState();
    const guard = new BudgetGuard(
      { caseSpendLimitMicroUsd: MICRO_USD_PER_USD, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledgerOf(state),
    );
    await guard.reserve(reservation);
    await guard.settle({ requestId: reservation.requestId, costKind: COST_KIND.UNKNOWN_CHARGE });

    expect(state.settled).toEqual([{ requestId: "req-1", costKind: COST_KIND.UNKNOWN_CHARGE }]);
    expect(state.caseSpend).toBe(ESTIMATE);
  });
});
