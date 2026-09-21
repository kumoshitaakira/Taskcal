/**
 * 呼出し前の費用見積り。
 *
 * 出典：RFC-004 §7「入力長・出力上限・候補モデル単価から保守的な費用を予約する」。
 *
 * 固定額を予約すると、長い返信や高いモデルへ振られた場合に実費が予約を超え、
 * 並行呼出しが案件・実行全体の上限を通り抜ける。次の三つを決定的に固定する。
 *
 *   1. 入力長の上限（超えたら呼出し前に拒否する）
 *   2. 出力トークンの上限（要求に含める）
 *   3. 候補モデルのうち**最も高い**単価
 */

import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import { isValidMicroUsd, type MicroUsd } from "./usage";

/** 単価。USD整数micro／1000トークン。候補モデルの最大値を使う。 */
export interface WorstCasePrices {
  readonly inputMicroUsdPerKiloToken: MicroUsd;
  readonly outputMicroUsdPerKiloToken: MicroUsd;
}

export interface EstimateBounds {
  /** 返信本文の最大文字数。超える入力は呼出し前に拒否する。 */
  readonly maxReplyChars: number;
  /** 1呼出しの出力トークン上限。要求に含めて、モデル側でも縛る。 */
  readonly maxOutputTokens: number;
}

/**
 * 文字数からトークン数の上限を見積もる。
 *
 * 日本語は1文字が1トークンを超えることがあるため、**1文字=1トークンでは足りない**。
 * 保守的に1文字あたり2トークンとする。過大に見積もる分には予算を守れる。
 */
const TOKENS_PER_CHAR_UPPER_BOUND = 2;

export function estimateInputTokens(promptChars: number): number {
  return Math.ceil(promptChars * TOKENS_PER_CHAR_UPPER_BOUND);
}

/**
 * この要求に固有の保守的な見積り（USD整数micro）。
 *
 * 切り上げるので、実費がこれを超えることは単価が想定内である限り起きない。
 */
export function estimateCallCost(input: {
  promptChars: number;
  bounds: EstimateBounds;
  prices: WorstCasePrices;
}): MicroUsd {
  const inputTokens = estimateInputTokens(input.promptChars);
  const inputCost = Math.ceil((inputTokens * input.prices.inputMicroUsdPerKiloToken) / 1000);
  const outputCost = Math.ceil(
    (input.bounds.maxOutputTokens * input.prices.outputMicroUsdPerKiloToken) / 1000,
  );
  const total = inputCost + outputCost;
  if (!isValidMicroUsd(total) || total <= 0) {
    throw new TaskcalError(
      ERROR_CODES.BUDGET_NOT_CONFIGURED,
      "費用見積りを算出できません。単価と上限の設定を確認してください。",
    );
  }
  return total;
}

/** 入力長の上限を超えていないか。超える入力は予約前に拒否する。 */
export function assertWithinInputBounds(replyChars: number, bounds: EstimateBounds): void {
  if (replyChars > bounds.maxReplyChars) {
    throw new TaskcalError(
      ERROR_CODES.OUT_OF_SCOPE,
      `返信本文が上限（${bounds.maxReplyChars}文字）を超えています。` +
        "見積りを超える費用が発生し得るため、呼出しません。",
    );
  }
}

/**
 * 実測トークンから費用を計算する。
 *
 * 単価が未確認の間は、候補モデルの最大単価で計算するため **ESTIMATED** のまま。
 * 実測の単価が取れるようになったら MEASURED へ変える。
 */
export function costFromTokens(input: {
  inputTokens: number;
  outputTokens: number;
  prices: WorstCasePrices;
}): MicroUsd {
  return (
    Math.ceil((input.inputTokens * input.prices.inputMicroUsdPerKiloToken) / 1000) +
    Math.ceil((input.outputTokens * input.prices.outputMicroUsdPerKiloToken) / 1000)
  );
}
