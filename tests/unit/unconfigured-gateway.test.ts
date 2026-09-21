import { describe, expect, it } from "vitest";
import type { ModelCallStore, StoredModelCall } from "@/adapters/orca/budget";
import { UnconfiguredModelGateway } from "@/adapters/orca/unconfigured-gateway";
import type { InterpretReplyRequest } from "@/adapters/orca/model-gateway";
import type { UsageRecord } from "@/adapters/orca/usage";
import { ERROR_CODES } from "@/contracts/errors";

const REQUEST_HASH = "a".repeat(64);

const request: InterpretReplyRequest = {
  requestId: "req-1",
  requestHash: REQUEST_HASH,
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

const usage: UsageRecord = {
  requestId: "req-1",
  runId: "run-1",
  step: "INTERPRET_REPLY",
  outcome: "SUCCEEDED",
  modelMeasurement: "UNKNOWN",
  routingSource: "ROUTER",
  promptVersion: "p1",
  rulesVersion: "s1",
  tokenMeasurement: "UNKNOWN",
  costKind: "ESTIMATED",
  validationResult: "VALID",
  startedAt: "2026-09-21T00:00:00.000Z",
  finishedAt: "2026-09-21T00:00:01.000Z",
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

function storeOf(stored: StoredModelCall | "NO_RESULT"): ModelCallStore {
  return {
    async findResult() {
      return stored;
    },
    async saveResult() {},
  };
}

describe("UnconfiguredModelGateway", () => {
  it("保存済み結果が無ければ新規呼出しとして止める", async () => {
    const gateway = new UnconfiguredModelGateway(storeOf("NO_RESULT"));
    await expect(gateway.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_CONFIGURED,
    });
  });

  it("callStore を持たない場合も止める", async () => {
    const gateway = new UnconfiguredModelGateway();
    await expect(gateway.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_CONFIGURED,
    });
  });

  it("保存済み結果は、設定が無くても再生できる（復旧を設定復元まで止めない）", async () => {
    const gateway = new UnconfiguredModelGateway(
      storeOf({
        requestId: "req-1",
        requestHash: REQUEST_HASH,
        outcome: "VALID",
        output: VALID_OUTPUT,
        usage,
      }),
    );
    const result = await gateway.interpretReply(request);
    expect(result.output.interpretation.intent).toBe("ACCEPT");
  });

  it("内容ハッシュが違えば拒否する（D07）", async () => {
    const gateway = new UnconfiguredModelGateway(
      storeOf({
        requestId: "req-1",
        requestHash: "b".repeat(64),
        outcome: "VALID",
        output: VALID_OUTPUT,
        usage,
      }),
    );
    await expect(gateway.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.OPERATION_CONFLICT,
    });
  });

  it("保存済みの検証失敗・結果不明は、そのまま同じ結果を返す", async () => {
    const invalid = new UnconfiguredModelGateway(
      storeOf({
        requestId: "req-1",
        requestHash: REQUEST_HASH,
        outcome: "SCHEMA_INVALID",
        usage,
      }),
    );
    await expect(invalid.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });

    const unknown = new UnconfiguredModelGateway(
      storeOf({
        requestId: "req-1",
        requestHash: REQUEST_HASH,
        outcome: "UNKNOWN",
        usage,
      }),
    );
    await expect(unknown.interpretReply(request)).rejects.toMatchObject({
      code: ERROR_CODES.RECONCILE_REQUIRED,
    });
  });
});
