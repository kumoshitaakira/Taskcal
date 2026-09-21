/**
 * 操作結果の保存（D07）と予算台帳（RFC-004 §7 / D12）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * 並行実行を含む。判定と登録が原子的でなければ落ちる。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、操作結果・予算台帳を確認していません。\n\n",
  );
}

const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

describe.skipIf(!connectionString)("操作結果と予算台帳（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let assertOutsideTransaction: typeof import("@/adapters/db/transaction").assertOutsideTransaction;
  let createPgOperationResultStore: typeof import("@/adapters/db/operation-result-store").createPgOperationResultStore;
  let createPgBudgetLedger: typeof import("@/adapters/db/budget-ledger").createPgBudgetLedger;
  let createPgModelCallStore: typeof import("@/adapters/db/model-call-store").createPgModelCallStore;

  beforeAll(async () => {
    // DATABASE_URL が無い環境で読み込み時に落ちないよう、動的importにする。
    ({ withTransaction, assertOutsideTransaction } = await import("@/adapters/db/transaction"));
    ({ createPgOperationResultStore } = await import("@/adapters/db/operation-result-store"));
    ({ createPgBudgetLedger } = await import("@/adapters/db/budget-ledger"));
    ({ createPgModelCallStore } = await import("@/adapters/db/model-call-store"));
    ({ closePool } = await import("@/adapters/db/pool"));
  });

  afterAll(async () => {
    await closePool();
  });

  it("D07：同じ操作IDの同じ内容は保存済み結果を返し、違う内容は拒否する", async () => {
    const store = createPgOperationResultStore();
    const operationId = `op-${randomUUID()}`;

    const first = await withTransaction((tx) =>
      store.begin(tx, {
        operation: { operationId, requestHash: HASH_A },
        kind: "CREATE_CASE",
      }),
    );
    expect(first.match).toBe("NEW");

    await withTransaction((tx) =>
      store.complete(tx, { operationId, status: "SUCCEEDED", result: { caseId: "c1" } }),
    );

    const replay = await withTransaction((tx) =>
      store.begin(tx, {
        operation: { operationId, requestHash: HASH_A },
        kind: "CREATE_CASE",
      }),
    );
    expect(replay.match).toBe("REPLAY");
    expect(replay.stored?.status).toBe("SUCCEEDED");
    expect(replay.stored?.result).toEqual({ caseId: "c1" });

    const conflict = await withTransaction((tx) =>
      store.begin(tx, {
        operation: { operationId, requestHash: HASH_B },
        kind: "CREATE_CASE",
      }),
    );
    expect(conflict.match).toBe("CONFLICT");
    expect(conflict.stored).toBeUndefined();
  });

  it("D07：同じ操作IDを同時に開始しても、新規は1本だけ", async () => {
    const store = createPgOperationResultStore();
    const operationId = `op-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        withTransaction((tx) =>
          store.begin(tx, {
            operation: { operationId, requestHash: HASH_A },
            kind: "START_OUTREACH",
          }),
        ),
      ),
    );

    expect(results.filter((r) => r.match === "NEW")).toHaveLength(1);
    expect(results.filter((r) => r.match === "REPLAY")).toHaveLength(5);
    expect(results.filter((r) => r.match === "CONFLICT")).toHaveLength(0);
  });

  it("D12：並行して予約しても、案件の回数上限を超えない", async () => {
    const ledger = createPgBudgetLedger();
    const caseId = randomUUID();
    const runId = `run-${randomUUID()}`;
    const limits = {
      caseCallLimit: 3,
      caseSpendLimitMicroUsd: 1_000_000,
      runSpendLimitMicroUsd: 1_000_000,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ledger.tryReserve(
          {
            caseId,
            runId,
            requestId: `req-${runId}-${i}`,
            requestHash: HASH_A,
            estimatedMicroUsd: 100,
          },
          limits,
        ),
      ),
    );

    expect(results.filter((r) => r === "RESERVED")).toHaveLength(3);
    expect(results.filter((r) => r === "EXCEEDED_CALLS")).toHaveLength(5);
  });

  it("D12：未精算の予約額を0として数えない（金額上限を並行で超えない）", async () => {
    const ledger = createPgBudgetLedger();
    const caseId = randomUUID();
    const runId = `run-${randomUUID()}`;
    const limits = {
      caseCallLimit: 100,
      caseSpendLimitMicroUsd: 250,
      runSpendLimitMicroUsd: 1_000_000,
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        ledger.tryReserve(
          {
            caseId,
            runId,
            requestId: `req-${runId}-${i}`,
            requestHash: HASH_A,
            estimatedMicroUsd: 100,
          },
          limits,
        ),
      ),
    );

    // 100 micro × 2 = 200 まで。3本目は 300 > 250 で止まる。
    expect(results.filter((r) => r === "RESERVED")).toHaveLength(2);
    expect(results.filter((r) => r === "EXCEEDED_CASE_SPEND")).toHaveLength(4);
  });

  it("同じ requestId で内容が違えば予約しない（D07）", async () => {
    const ledger = createPgBudgetLedger();
    const caseId = randomUUID();
    const runId = `run-${randomUUID()}`;
    const requestId = `req-${randomUUID()}`;
    const limits = {
      caseCallLimit: 10,
      caseSpendLimitMicroUsd: 1_000_000,
      runSpendLimitMicroUsd: 1_000_000,
    };
    const base = { caseId, runId, requestId, estimatedMicroUsd: 100 };

    expect(await ledger.tryReserve({ ...base, requestHash: HASH_A }, limits)).toBe("RESERVED");
    expect(await ledger.tryReserve({ ...base, requestHash: HASH_A }, limits)).toBe(
      "ALREADY_RESERVED",
    );
    expect(await ledger.tryReserve({ ...base, requestHash: HASH_B }, limits)).toBe("HASH_MISMATCH");
  });

  it("精算は冪等で、結果不明でも費用を0にしない", async () => {
    const ledger = createPgBudgetLedger();
    const caseId = randomUUID();
    const runId = `run-${randomUUID()}`;
    const requestId = `req-${randomUUID()}`;
    const limits = {
      caseCallLimit: 10,
      caseSpendLimitMicroUsd: 1_000_000,
      runSpendLimitMicroUsd: 1_000_000,
    };

    await ledger.tryReserve(
      { caseId, runId, requestId, requestHash: HASH_A, estimatedMicroUsd: 500 },
      limits,
    );
    // 実費が取れない場合。予約額をそのまま残す。
    await ledger.settle({ requestId, costKind: "UNKNOWN_CHARGE" });
    // 二度目の精算で上書きしない（冪等）。
    await ledger.settle({ requestId, actualMicroUsd: 1, costKind: "MEASURED" });

    const row = await withTransaction((tx) =>
      tx.query<{ settled_micro_usd: string; cost_kind: string }>(
        "select settled_micro_usd, cost_kind from budget_reservation where request_id = $1",
        [requestId],
      ),
    );
    expect(row.rows[0]).toEqual({ settled_micro_usd: "500", cost_kind: "UNKNOWN_CHARGE" });
  });

  it("モデル呼出しの保存済み結果を上書きしない", async () => {
    const store = createPgModelCallStore();
    const requestId = `req-${randomUUID()}`;
    const caseId = randomUUID();
    const usage = {
      requestId,
      caseId,
      runId: "run-1",
      step: "INTERPRET_REPLY",
      outcome: "SUCCEEDED",
      modelMeasurement: "UNKNOWN",
      routingSource: "UNKNOWN",
      promptVersion: "p1",
      rulesVersion: "r1",
      tokenMeasurement: "UNKNOWN",
      costKind: "ESTIMATED",
      validationResult: "VALID",
      startedAt: "2026-09-21T00:00:00.000Z",
      finishedAt: "2026-09-21T00:00:01.000Z",
    } as const;

    expect(await store.findResult(requestId)).toBe("NO_RESULT");

    await store.saveResult({
      requestId,
      requestHash: HASH_A,
      outcome: "VALID",
      output: { intent: "ACCEPT" },
      usage,
      maskedReplyText: "行けます",
    });
    await store.saveResult({
      requestId,
      requestHash: HASH_A,
      outcome: "VALID",
      output: { intent: "DECLINE" },
      usage,
      maskedReplyText: "行けません",
    });

    const stored = await store.findResult(requestId);
    expect(stored).not.toBe("NO_RESULT");
    expect((stored as { output: unknown }).output).toEqual({ intent: "ACCEPT" });
  });

  it("結果不明の記録も保存する（再試行のたびに呼び直さないため）", async () => {
    const store = createPgModelCallStore();
    const requestId = `req-${randomUUID()}`;
    await store.saveResult({
      requestId,
      requestHash: HASH_A,
      outcome: "UNKNOWN",
      usage: {
        requestId,
        caseId: randomUUID(),
        runId: "run-1",
        step: "INTERPRET_REPLY",
        outcome: "UNKNOWN",
        modelMeasurement: "UNKNOWN",
        routingSource: "UNKNOWN",
        promptVersion: "p1",
        rulesVersion: "r1",
        tokenMeasurement: "UNKNOWN",
        costKind: "UNKNOWN_CHARGE",
        validationResult: "NOT_EVALUATED",
        startedAt: "2026-09-21T00:00:00.000Z",
        finishedAt: "2026-09-21T00:00:01.000Z",
      },
      maskedReplyText: "",
    });

    const stored = await store.findResult(requestId);
    expect(stored).toMatchObject({ outcome: "UNKNOWN", output: undefined });
  });

  it("外部作用を取引の内側から始めようとすると止める（RFC-010 §5）", async () => {
    expect(() => assertOutsideTransaction("モデル呼出し")).not.toThrow();
    await expect(
      withTransaction(async () => {
        assertOutsideTransaction("モデル呼出し");
      }),
    ).rejects.toThrowError(/取引の外/);
  });
});
