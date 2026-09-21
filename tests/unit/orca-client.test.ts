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
import { MICRO_USD_PER_USD, type UsageRecord } from "@/adapters/orca/usage";
import { ERROR_CODES } from "@/contracts/errors";
import type { InterpretReplyRequest } from "@/adapters/orca/model-gateway";

const REQUEST_HASH = "a".repeat(64);

/** 保存済み記録の usage。最低限の形を満たす。 */
function usageOf(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: "req-1",
    caseId: "case-1",
    runId: "run-1",
    step: "INTERPRET_REPLY",
    validationResult: "VALID",
    outcome: "SUCCEEDED",
    modelMeasurement: "UNKNOWN",
    routingSource: "ROUTER",
    promptVersion: "p1",
    rulesVersion: "s1",
    tokenMeasurement: "UNKNOWN",
    costMicroUsd: 5_000,
    costKind: "ESTIMATED",
    startedAt: "2026-09-21T00:00:00.000Z",
    finishedAt: "2026-09-21T00:00:01.000Z",
    ...overrides,
  };
}

const request: InterpretReplyRequest = {
  requestId: "req-1",
  requestHash: REQUEST_HASH,
  step: "INTERPRET_REPLY",
  attempt: 0,
  caseId: "case-1",
  runId: "run-1",
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
    // 意思を読み取った根拠。空のままだと採用されない（RFC-004 §3）。
    evidenceSpans: [{ start: 0, end: 3 }],
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
    bounds: { maxReplyChars: 1_000, maxOutputTokens: 512 },
    // 入力3000/Ktok・出力15000/Ktok を候補モデルの最大単価として扱う。
    prices: { inputMicroUsdPerKiloToken: 3_000, outputMicroUsdPerKiloToken: 15_000 },
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
      outcome: "VALID",
      output: VALID_OUTPUT,
      usage: usageOf(),
      maskedReplyText: "19時からなら行けます",
    });

    const result = await client.interpretReply(request);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.output.interpretation.intent).toBe("ACCEPT");
  });

  it("入力上限を下げても、保存済み結果は再生できる", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { store } = storeOf({
      requestId: "req-1",
      requestHash: REQUEST_HASH,
      outcome: "VALID",
      output: VALID_OUTPUT,
      usage: usageOf(),
      maskedReplyText: "19時からなら行けます",
    });
    const { ledger } = ledgerReturning(RESERVATION_RESULT.RESERVED);
    const client = new OrcaRouterClient({
      baseUrl: "https://example.test",
      apiKey: "dummy-key",
      budget: new BudgetGuard(
        { caseSpendLimitMicroUsd: MICRO_USD_PER_USD, runSpendLimitMicroUsd: MICRO_USD_PER_USD },
        ledger,
      ),
      callStore: store,
      // 保存した時点より厳しい上限。再生はこれに依存してはいけない。
      bounds: { maxReplyChars: 1, maxOutputTokens: 512 },
      prices: { inputMicroUsdPerKiloToken: 3_000, outputMicroUsdPerKiloToken: 15_000 },
    });

    const result = await client.interpretReply(request);
    expect(result.output.interpretation.intent).toBe("ACCEPT");
    expect(fetchSpy).not.toHaveBeenCalled();
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
      outcome: "VALID",
      output: VALID_OUTPUT,
      usage: usageOf(),
      maskedReplyText: "19時からなら行けます",
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
    // 予約を予約のまま残さない（RFC-004 §7）。実測トークンから費用を出す。
    // 入力10tok → ceil(10*3000/1000)=30、出力5tok → ceil(5*15000/1000)=75。
    expect(settled).toEqual([{ requestId: "req-1", actualMicroUsd: 105, costKind: "ESTIMATED" }]);
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

    // 予約額（要求ごとの見積り）をそのまま残す。0にしない。
    expect(settled).toHaveLength(1);
    expect(settled[0]?.costKind).toBe("UNKNOWN_CHARGE");
    expect(settled[0]?.actualMicroUsd).toBeGreaterThan(0);
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

    const { client, settled, saved } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await expect(client.interpretReply(request)).rejects.toThrow();

    expect(settled).toHaveLength(1);
    expect(settled[0]?.costKind).toBe("ESTIMATED");
    // 判明した検証失敗として永続化する。再試行で「結果不明」と誤分類しないため。
    expect(saved).toHaveLength(1);
    expect(saved[0]?.outcome).toBe("SCHEMA_INVALID");
    expect(saved[0]?.output).toBeUndefined();
  });

  it("保存済みのschema不一致は、結果不明ではなく同じ失敗を決定的に返す", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { client } = clientWith(RESERVATION_RESULT.ALREADY_RESERVED, {
      requestId: "req-1",
      requestHash: REQUEST_HASH,
      outcome: "SCHEMA_INVALID",
      usage: usageOf(),
      maskedReplyText: "19時からなら行けます",
    });

    await expect(client.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("保存と精算の間で落ちた場合、再生時に精算をやり直す", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // 保存済みだが、精算の記録が無い（＝精算前に停止した）状態。
    const { client, settled } = clientWith(RESERVATION_RESULT.ALREADY_RESERVED, {
      requestId: "req-1",
      requestHash: REQUEST_HASH,
      outcome: "VALID",
      output: VALID_OUTPUT,
      usage: usageOf({ costMicroUsd: 105, costKind: "ESTIMATED" }),
      maskedReplyText: "19時からなら行けます",
    });

    await client.interpretReply(request);

    // 再送はしない。
    expect(fetchSpy).not.toHaveBeenCalled();
    // 予約が残り続けないよう、保存済みusageで精算をやり直す。
    expect(settled).toEqual([{ requestId: "req-1", actualMicroUsd: 105, costKind: "ESTIMATED" }]);
  });

  it("結果不明の記録を、例外を投げる前に永続化する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const { client, saved } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await expect(client.interpretReply(request)).rejects.toThrow();

    // 例外オブジェクトにしか残さないと、直後のクラッシュで失われる（RFC-004 §8）。
    expect(saved).toHaveLength(1);
    expect(saved[0]?.outcome).toBe("UNKNOWN");
    expect(saved[0]?.usage.costKind).toBe("UNKNOWN_CHARGE");
    expect(saved[0]?.usage.routingSource).toBe("ROUTER");
    expect(saved[0]?.usage.rulesVersion).toBeTruthy();
  });

  it("保存済みの結果不明は、再送せず同じ結果不明を返す", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { client } = clientWith(RESERVATION_RESULT.ALREADY_RESERVED, {
      requestId: "req-1",
      requestHash: REQUEST_HASH,
      outcome: "UNKNOWN",
      usage: usageOf({ outcome: "UNKNOWN", costKind: "UNKNOWN_CHARGE" }),
      maskedReplyText: "19時からなら行けます",
    });

    await expect(client.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.RECONCILE_REQUIRED,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("根拠の位置が本文の範囲外なら、schemaを通っても採用しない（RFC-004 §3）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      ...VALID_OUTPUT,
                      interpretation: {
                        ...VALID_OUTPUT.interpretation,
                        // schemaは通るが、本文長を超えている。
                        evidenceSpans: [{ start: 0, end: 999 }],
                      },
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const { client, saved } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await expect(client.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    // 検証失敗として保存する。再生でも成功として返さない。
    expect(saved).toHaveLength(1);
    expect(saved[0]?.outcome).toBe("SCHEMA_INVALID");
  });

  it("返信内の連絡先をマスクしてから送る（RFC-004 §5）", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const { client } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await client.interpretReply({
      ...request,
      replyText: "19時からなら行けます。080-1234-5678 か taro@example.com へ",
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("080-1234-5678");
    expect(serialized).not.toContain("taro@example.com");
    // 勤務条件は残す。
    expect(serialized).toContain("19時からなら行けます");
  });

  it("入力長の上限を超える返信は、予約前に拒否する（RFC-004 §7）", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { client, settled } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    await expect(
      client.interpretReply({ ...request, replyText: "あ".repeat(1_001) }),
    ).rejects.toMatchObject({ code: ERROR_CODES.OUT_OF_SCOPE });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(settled).toHaveLength(0);
  });

  it("不正なトークン数を実測値として受け取らない（予約額とUNKNOWNを保持する）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "test-model",
              // 負数・小数はRouterの応答でも起こり得る。実測として受理しない。
              usage: { prompt_tokens: -5, completion_tokens: 1.5 },
              choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const { client, settled } = clientWith(RESERVATION_RESULT.RESERVED, "NO_RESULT");
    const result = await client.interpretReply(request);

    expect(result.usage.inputTokens).toBeUndefined();
    expect(result.usage.outputTokens).toBeUndefined();
    expect(result.usage.tokenMeasurement).toBe("UNKNOWN");
    // 負の費用を台帳へ入れない。予約額を保持する。
    expect(result.usage.costMicroUsd).toBeGreaterThan(0);
    expect(settled[0]?.actualMicroUsd).toBeGreaterThan(0);
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
