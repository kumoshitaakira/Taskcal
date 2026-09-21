import { describe, expect, it } from "vitest";
import {
  assertWithinInputBounds,
  costFromTokens,
  estimateCallCost,
  estimateInputTokens,
} from "@/adapters/orca/estimate";
import { ERROR_CODES } from "@/contracts/errors";

const bounds = { maxReplyChars: 1_000, maxOutputTokens: 512 };
const prices = { inputMicroUsdPerKiloToken: 3_000, outputMicroUsdPerKiloToken: 15_000 };

describe("費用見積り（RFC-004 §7）", () => {
  it("日本語で1文字=1トークンを超えても足りるよう、上限側で換算する", () => {
    // 1文字=1トークンだと足りない。過大に見積もる分には予算を守れる。
    expect(estimateInputTokens(100)).toBeGreaterThanOrEqual(100);
  });

  it("入力が長いほど見積りが増える（固定額ではない）", () => {
    const short = estimateCallCost({ promptChars: 100, bounds, prices });
    const long = estimateCallCost({ promptChars: 900, bounds, prices });
    expect(long).toBeGreaterThan(short);
  });

  it("出力上限の費用を必ず含める（実出力が少なくても予約は上限で取る）", () => {
    const cost = estimateCallCost({ promptChars: 0, bounds, prices });
    // 512tok × 15000/1000 = 7680
    expect(cost).toBe(7_680);
  });

  it("見積りは整数へ切り上げる", () => {
    const cost = estimateCallCost({ promptChars: 1, bounds, prices });
    expect(Number.isSafeInteger(cost)).toBe(true);
  });

  it("実費が見積りを超えないこと（出力上限まで使った最悪値との比較）", () => {
    const promptChars = 500;
    const estimated = estimateCallCost({ promptChars, bounds, prices });
    const worstActual = costFromTokens({
      inputTokens: estimateInputTokens(promptChars),
      outputTokens: bounds.maxOutputTokens,
      prices,
    });
    expect(worstActual).toBeLessThanOrEqual(estimated);
  });

  it("入力長の上限を超えたら拒否する", () => {
    expect(() => assertWithinInputBounds(1_001, bounds)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.OUT_OF_SCOPE }),
    );
    expect(() => assertWithinInputBounds(1_000, bounds)).not.toThrow();
  });
});
