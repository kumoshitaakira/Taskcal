import { describe, expect, it } from "vitest";
import { MEASUREMENT, ROUTING_SOURCE, unknownOutcomeUsage } from "@/adapters/orca/usage";

describe("使用量の記録（ADR-007 / AGENTS.md）", () => {
  it("結果不明の呼出しを費用0として記録しない", () => {
    const usage = unknownOutcomeUsage({
      callId: "call-1",
      caseId: "c1",
      promptVersion: "p1",
      schemaVersion: "s1",
      routingSource: ROUTING_SOURCE.ROUTER,
      startedAt: "2026-09-21T00:00:00.000Z",
      finishedAt: "2026-09-21T00:00:20.000Z",
    });

    expect(usage.outcome).toBe("UNKNOWN");
    expect(usage.costJpy).toBeUndefined();
    expect(usage.costMeasurement).toBe(MEASUREMENT.UNKNOWN);
    expect(usage.tokenMeasurement).toBe(MEASUREMENT.UNKNOWN);
    expect(usage.modelMeasurement).toBe(MEASUREMENT.UNKNOWN);
  });
});
