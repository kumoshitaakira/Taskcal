/**
 * 適格性の再検査の**境界**（Q15）。規則そのものは担当Bの `tests/unit/interval.test.ts`。
 *
 * ここで見るのは、こちら側の永続層の形（UTCのISO）を担当Bの規則が受け取る形
 * （Asia/Tokyo固定）へ写す部分。黙って丸めないことを確かめる。
 */

import { describe, expect, it } from "vitest";
import { toJstFixedFormat } from "@/application/eligibility-recheck";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";

describe("保存している瞬間を Asia/Tokyo 固定形式へ写す", () => {
  it("UTCのISOを、同じ瞬間の日本時間で返す", () => {
    expect(toJstFixedFormat("2026-09-26T09:00:00.000Z")).toBe("2026-09-26T18:00:00+09:00");
    expect(toJstFixedFormat("2026-09-26T13:00:00.000Z")).toBe("2026-09-26T22:00:00+09:00");
  });

  it("すでに日本時間で書かれていても、同じ値へ落ち着く", () => {
    expect(toJstFixedFormat("2026-09-26T18:00:00+09:00")).toBe("2026-09-26T18:00:00+09:00");
  });

  it("日付が変わる境界でも、日本時間の日付になる", () => {
    // UTCでは前日でも、日本時間では翌日の0時。営業日をここから決めるので重要。
    expect(toJstFixedFormat("2026-09-25T15:00:00.000Z")).toBe("2026-09-26T00:00:00+09:00");
  });

  it("秒未満を含む日時は、黙って丸めず範囲外として断る", () => {
    // 切り捨てると、検査した区間と実際に確定する勤務がずれる。
    let thrown: unknown;
    try {
      toJstFixedFormat("2026-09-26T09:00:30.000Z");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaskcalError);
    expect((thrown as TaskcalError).code).toBe(ERROR_CODES.OUT_OF_SCOPE);
  });

  it("解釈できない日時は通さない", () => {
    expect(() => toJstFixedFormat("いつか")).toThrow(TaskcalError);
  });
});
