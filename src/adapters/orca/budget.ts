/**
 * 呼出し前の費用・回数予約。
 *
 * 出典：ADR-007、RFC-011 §7、RFC-009 D12。未決：**Q10**（上限値は未確定）。
 *
 * 規則：
 *   - 金額予算が未設定なら有料呼出しを開始しない。
 *   - 呼出し前に予約し、成否不明でも予約を戻さない（0円として扱わないため）。
 *   - 上限に達したら新規実行を止め、事実を保持して引き継ぐ。
 *   - **検査と予約を1つの取引で行う。** 同時返信で複数の推論が同時に起きるため、
 *     読んでから書くまでの間に別の呼出しが通ると上限を超える（RFC-011 §7）。
 *   - Router内部の複数呼出しが見えない経路では、アプリ予約だけで硬い上限を
 *     保証できない。その限界を表示する（ADR-007）。
 */

import { ERROR_CODES, TaskcalError } from "@/contracts/errors";

/**
 * 1案件あたりの呼出し回数の既定値。
 *
 * ADR-007の初期値10call／案件を、Q10確定までのMVP既定値として使う。
 * Q10が未決であることは「上限なし」ではない。採用済みのプロダクト判断ではなく、
 * 実装上の仮定（docs/OPEN-QUESTIONS.md）。
 */
export const DEFAULT_MAX_CALLS_PER_CASE = 10;

export interface BudgetLimits {
  /** 1案件あたりの金額上限（JPY）。未設定なら undefined。 */
  readonly perCaseJpy?: number;
  /** 全体の金額上限（JPY）。 */
  readonly totalJpy?: number;
  /** 1案件あたりの呼出し回数上限。schema修復・再試行も総回数に含む（ADR-007）。 */
  readonly maxCallsPerCase?: number;
}

export interface Reservation {
  readonly caseId: string;
  readonly callId: string;
  /** 見積り費用（JPY）。0や負の値は受け付けない。 */
  readonly estimatedJpy: number;
}

export const RESERVATION_RESULT = {
  RESERVED: "RESERVED",
  EXCEEDED_CALLS: "EXCEEDED_CALLS",
  EXCEEDED_CASE_JPY: "EXCEEDED_CASE_JPY",
  EXCEEDED_TOTAL_JPY: "EXCEEDED_TOTAL_JPY",
} as const;

export type ReservationResult = (typeof RESERVATION_RESULT)[keyof typeof RESERVATION_RESULT];

/**
 * 予約の記録先。
 *
 * **判定と加算を1つのメソッドにまとめている。** 読みと書きを別メソッドにすると、
 * 実装側でも原子化できず、同時返信時にN本が同時に上限検査を通過する。
 * DB実装では1つのSQL文または1トランザクションで行う。
 */
export interface BudgetLedger {
  tryReserve(reservation: Reservation, limits: RequiredBudgetLimits): Promise<ReservationResult>;
}

/** 未設定検査を通した後の上限。すべて値が入っている。 */
export interface RequiredBudgetLimits {
  readonly perCaseJpy: number;
  readonly totalJpy: number;
  readonly maxCallsPerCase: number;
}

export class BudgetGuard {
  constructor(
    private readonly limits: BudgetLimits,
    private readonly ledger: BudgetLedger,
  ) {}

  /**
   * 呼出し前に検査して予約する。通らなければ例外で止める。
   * 「上限が少なくても無視して続行」しない（RFC-011 §7）。
   */
  async reserve(reservation: Reservation): Promise<void> {
    if (!(reservation.estimatedJpy > 0)) {
      // 見積り0を許すと、金額上限の比較が常に成立して予算が無効になる。
      // 単価が未確認でも、0ではなく保守的な見積りを渡すこと。
      throw new TaskcalError(
        ERROR_CODES.BUDGET_NOT_CONFIGURED,
        "1呼出しの費用見積りが未設定（0以下）のため、呼出しを開始しません。",
      );
    }

    const { perCaseJpy, totalJpy } = this.limits;
    if (perCaseJpy === undefined || totalJpy === undefined) {
      throw new TaskcalError(
        ERROR_CODES.BUDGET_NOT_CONFIGURED,
        "金額予算が未設定のため、有料の推論呼出しを開始しません（ADR-007 / Q10）。",
      );
    }

    const result = await this.ledger.tryReserve(reservation, {
      perCaseJpy,
      totalJpy,
      maxCallsPerCase: this.limits.maxCallsPerCase ?? DEFAULT_MAX_CALLS_PER_CASE,
    });

    if (result !== RESERVATION_RESULT.RESERVED) {
      throw new TaskcalError(ERROR_CODES.BUDGET_EXCEEDED, EXCEEDED_MESSAGE[result]);
    }
  }
}

const EXCEEDED_MESSAGE: Record<Exclude<ReservationResult, "RESERVED">, string> = {
  EXCEEDED_CALLS: "案件の呼出し回数上限に達しました。",
  EXCEEDED_CASE_JPY: "案件の金額上限に達しました。",
  EXCEEDED_TOTAL_JPY: "全体の金額上限に達しました。",
};
