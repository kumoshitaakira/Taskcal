/**
 * OrcaRouterClient の再試行時の振る舞い。
 *
 * 実接続はしない。fetch を差し替えて、**再送しないこと**を検査する。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudgetGuard,
  RESERVATION_RESULT,
  type BudgetLedger,
  type ModelCallStore,
  type StoredModelCall,
} from "@/adapters/orca/budget";
import { OrcaRouterClient } from "@/adapters/orca/orca-client";
import { MICRO_USD_PER_USD } from "@/adapters/orca/usage";
import { ERROR_CODES } from "@/contracts/errors";
import type { InterpretReplyRequest } from "@/adapters/orca/model-gateway";

const REQUEST_HASH = "a".repeat(64);

const request: InterpretReplyRequest = {
  requestId: "req-1",
  requestHash: REQUEST_HASH,
  caseId: "case-1",
  anonymousStaffRef: "staff-A",
  offer: {
    date: "2026-09-21",
    roleCode: "HALL",
    startAt: "2026-09-21T18:00:00+09:00",
    endAt: "2026-09-21T22:00:00+09:00",
    deadlineAt: "2026-09-21T16:00:00+09:00",
  },
  afterCommit: false,
  replyText: "19時からなら行けます",
  promptVersion: "p1",
};

const VALID_OUTPUT = {
  interpretation: {
    extractionRuleVersion: "v1",
    intent: "ACCEPT",
    offeredRanges: [{ startAt: "2026-09-21T19:00:00+09:00", endAt: "2026-09-21T22:00:00+09:00" }],
    unresolvedConditions: [],
    evidenceSpans: [],
  },
  proposedAction: "RECORD_COMMITMENT_CANDIDATE",
};

function ledgerReturning(result: (typeof RESERVATION_RESULT)[keyof typeof RESERVATION_RESULT]) {
  const settled: { requestId: string; actualMicroUsd?: number; costKind: string }[] = [];
  const ledger: BudgetLedger = {
    async tryReserve() {
      return result;
    },
    async settle(input) {
      settled.push(input);
    },
  };
  return { ledger, settled };
}

function storeOf(stored: StoredModelCall | "NO_RESULT") {
  const saved: StoredModelCall[] = [];
  const store: ModelCallStore = {
    async findResult() {
      return stored;
    },
    async saveResult(call) {
      saved.push(call);
    },
  };
  return { store, saved };
}

function clientWith(
  result: (typeof RESERVATION_RESULT)[keyof typeof RESERVATION_RESULT],
  stored: StoredModelCall | "NO_RESULT",
) {
  const { store, saved } = storeOf(stored);
  const { ledger, settled } = ledgerReturning(result);
  const client = new OrcaRouterClient({
    baseUrl: "https://example.test",
    apiKey: "dummy-key",
    budget: new BudgetGuard(
      { caseSpendLimitMicroUsd: MICRO_USD_PER_USD, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
      ledger,
    ),
    callStore: store,
    estimatedMicroUsdPerCall: 5_000,
  });
  return { client, saved, settled };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrcaRouterClient の再試行（ADR-006 / AGENTS.md）", () => {
  it("予約済みで結果が保存されていれば、再送せず保存済み結果を返す", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { client } = clientWith(RESERVATION_RESULT.ALREADY_RESERVED, {
      requestId: "req-1",
      requestHash: REQUEST_HASH,
      output: VALID_OUTPUT,
      usage: { requestId: "req-1" },
    });

    const result = await client.interpretReply(request);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.output.interpretation.intent).toBe("ACCEPT");
  });

  it("予約済みだが結果が不明なら、再送せず照合へ回す", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { client } = clientWith(RESERVATION_RESULT.ALREADY_RESERVED, "NO_RESULT");

    await expect(client.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.RECONCILE_REQUIRED,
    });
    // ここで有料推論を再送しないことが要点。
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("保存済み結果の内容ハッシュが違えば拒否する（D07）", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { client } = clientWith(RESERVATION_RESULT.ALREADY_RESERVED, {
      requestId: "req-1",
      requestHash: "b".repeat(64),
      output: VALID_OUTPUT,
      usage: {},
    });

    await expect(client.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.OPERATION_CONFLICT,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("新規予約なら呼出し、結果を保存する", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "test-model",
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { client, saved, settled } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    const result = await client.interpretReply(request);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.usage.resolvedModel).toBe("test-model");
    // 次の再試行が再送にならないよう、結果を保存している。
    expect(saved).toHaveLength(1);
    expect(saved[0]?.requestHash).toBe(REQUEST_HASH);
    // 予約を予約のまま残さない（RFC-004 §7）。
    expect(settled).toEqual([{ requestId: "req-1", actualMicroUsd: 5_000, costKind: "ESTIMATED" }]);
  });

  it("結果不明でも精算し、予約を残す（UNKNOWN_CHARGE）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const { client, settled } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await expect(client.interpretReply(request)).rejects.toThrow();

    expect(settled).toEqual([
      { requestId: "req-1", actualMicroUsd: 5_000, costKind: "UNKNOWN_CHARGE" },
    ]);
  });

  it("モデル出力がschemaに合わなくても精算する（課金は発生している）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: '{"intent":"???"}' } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const { client, settled } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await expect(client.interpretReply(request)).rejects.toThrow();

    expect(settled).toHaveLength(1);
    expect(settled[0]?.costKind).toBe("ESTIMATED");
  });

  it("Q09: 現在の承諾と確定状態をモデルへ渡す", async () => {
    let body: Record<string, unknown> = {};
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { client } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await client.interpretReply({
      ...request,
      currentCommitment: {
        startAt: "2026-09-21T19:00:00+09:00",
        endAt: "2026-09-21T22:00:00+09:00",
      },
      afterCommit: true,
      replyText: "やっぱり20時からにしてください",
    });

    const messages = body.messages as { role: string; content: string }[];
    const userContent = JSON.parse(messages[1].content) as Record<string, unknown>;
    expect(userContent.current_commitment).toEqual({
      startAt: "2026-09-21T19:00:00+09:00",
      endAt: "2026-09-21T22:00:00+09:00",
    });
    expect(userContent.after_commit).toBe(true);
    // 氏名・連絡先は渡さない（ADR-008）。
    expect(JSON.stringify(userContent)).not.toContain("staffId");
  });
});
