import { describe, expect, it } from "vitest";
import {
  COST_KIND,
  MEASUREMENT,
  MICRO_USD_PER_USD,
  ROUTING_SOURCE,
  isValidMicroUsd,
  toJpyForDisplay,
  unknownChargeUsage,
} from "@/adapters/orca/usage";

describe("使用量の記録（RFC-004 §7・§8 / ADR-007）", () => {
  it("課金不明の呼出しを費用0として記録せず、予約額を残す", () => {
    const usage = unknownChargeUsage({
      requestId: "req-1",
      caseId: "c1",
      promptVersion: "p1",
      rulesVersion: "s1",
      routingSource: ROUTING_SOURCE.ROUTER,
      reservedMicroUsd: 5_000,
      startedAt: "2026-09-21T00:00:00.000Z",
      finishedAt: "2026-09-21T00:00:20.000Z",
    });

    expect(usage.outcome).toBe("UNKNOWN");
    expect(usage.costKind).toBe(COST_KIND.UNKNOWN_CHARGE);
    // 0にしない。予約額をそのまま残す（RFC-004 §7）。
    expect(usage.costMicroUsd).toBe(5_000);
    expect(usage.tokenMeasurement).toBe(MEASUREMENT.UNKNOWN);
    expect(usage.modelMeasurement).toBe(MEASUREMENT.UNKNOWN);
    expect(usage.latencyMs).toBe(20_000);
  });

  it("金額はUSDの整数micro単位のみ受け付ける", () => {
    expect(isValidMicroUsd(5_000)).toBe(true);
    expect(isValidMicroUsd(0)).toBe(true);
    expect(isValidMicroUsd(0.5)).toBe(false);
    expect(isValidMicroUsd(-1)).toBe(false);
    expect(isValidMicroUsd(NaN)).toBe(false);
  });

  it("円換算は表示専用で、換算日時とレートを添える", () => {
    const display = toJpyForDisplay(MICRO_USD_PER_USD, 150, "2026-09-21T00:00:00.000Z");
    expect(display).toEqual({
      jpy: 150,
      rateJpyPerUsd: 150,
      convertedAt: "2026-09-21T00:00:00.000Z",
    });
  });
});
