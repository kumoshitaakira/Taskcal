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
  it("UTF-8のbyte長を上限にする（byte fallbackのtokenizerでも下回らない）", () => {
    // ASCIIは1文字1 byte。
    expect(estimateInputTokens("abc")).toBe(3);
    // BMPの日本語は1文字3 byte。文字数基準（1文字=2トークン）では足りない。
    expect(estimateInputTokens("あいう")).toBe(9);
    expect(estimateInputTokens("あいう")).toBeGreaterThan("あいう".length * 2);
    // 絵文字は4 byte。
    expect(estimateInputTokens("🍣")).toBe(4);
  });

  it("入力が長いほど見積りが増える（固定額ではない）", () => {
    const short = estimateCallCost({ promptText: "a".repeat(100), bounds, prices });
    const long = estimateCallCost({ promptText: "a".repeat(900), bounds, prices });
    expect(long).toBeGreaterThan(short);
  });

  it("同じ文字数でもマルチバイトなら見積りが増える", () => {
    const ascii = estimateCallCost({ promptText: "a".repeat(100), bounds, prices });
    const japanese = estimateCallCost({ promptText: "あ".repeat(100), bounds, prices });
    expect(japanese).toBeGreaterThan(ascii);
  });

  it("出力上限の費用を必ず含める（実出力が少なくても予約は上限で取る）", () => {
    const cost = estimateCallCost({ promptText: "", bounds, prices });
    // 512tok × 15000/1000 = 7680
    expect(cost).toBe(7_680);
  });

  it("見積りは整数へ切り上げる", () => {
    const cost = estimateCallCost({ promptText: "a", bounds, prices });
    expect(Number.isSafeInteger(cost)).toBe(true);
  });

  it("実費が見積りを超えないこと（出力上限まで使った最悪値との比較）", () => {
    const promptText = "あ".repeat(300);
    const estimated = estimateCallCost({ promptText, bounds, prices });
    const worstActual = costFromTokens({
      inputTokens: estimateInputTokens(promptText),
      outputTokens: bounds.maxOutputTokens,
      prices,
    });
    expect(worstActual).toBeLessThanOrEqual(estimated);
  });

  it("トークン数が非負の整数でなければ費用を作らない", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => costFromTokens({ inputTokens: bad, outputTokens: 10, prices })).toThrowError(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
      expect(() => costFromTokens({ inputTokens: 10, outputTokens: bad, prices })).toThrowError(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
    }
    expect(costFromTokens({ inputTokens: 0, outputTokens: 0, prices })).toBe(0);
  });

  it("算出した費用が安全な整数を超えたら拒否する", () => {
    // 入力が安全な整数でも、単価との積は範囲外になり得る。
    expect(() =>
      costFromTokens({
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        prices,
      }),
    ).toThrowError(expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }));
  });

  it("入力長の上限を超えたら拒否する", () => {
    expect(() => assertWithinInputBounds(1_001, bounds)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.OUT_OF_SCOPE }),
    );
    expect(() => assertWithinInputBounds(1_000, bounds)).not.toThrow();
  });
});
