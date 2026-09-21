/**
 * 呼出し前の費用・回数予約。
 *
 * 出典：RFC-004 §7、ADR-007、RFC-011 §7、RFC-009 D12。未決：**Q10**（上限値）。
 *
 * 規則（RFC-004 §7）：
 *   - 設定は `case_call_limit` / `case_spend_limit` / `run_spend_limit` の3つ。
 *   - 金額は**USDの整数micro単位**。円換算は表示時のみ。
 *   - 未設定なら有料呼出しを開始しない。
 *   - 呼出し前に、保守的な費用を予約する。並行呼出しは**予約残額込みで**検査する。
 *   - 実際のusage・費用を取得したら精算する。失敗・タイムアウトでも0円と扱わない。
 *     課金不明は UNKNOWN_CHARGE として予約を残す。
 *   - 検査と予約を1つの取引で行う。読んでから書くまでの間に別の呼出しが通ると
 *     上限を超える（RFC-011 §7）。
 *   - Router内部の呼出し数・課金を確認できない構成では、アプリの予約だけで
 *     厳密な金額上限を保証しない。その限界を表示する（RFC-004 §7）。
 */

import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import { isValidMicroUsd, type CostKind, type MicroUsd, type UsageRecord } from "./usage";

/**
 * 1案件あたりの呼出し回数の既定値（RFC-004 §7 の `case_call_limit`）。
 *
 * Q10で24を暫定確定した（2026-09-21）。ADR-007の10call／案件は順次打診を前提にした
 * 値のため置き換える。
 *
 * **24は検証前の上限候補であり、十分な回数だという保証ではない。**
 * 返信解釈が1人1callなら8人で8callであり、10にはまだ達しない。追加確認、訂正、
 * schema修復、再試行、モデルによる次行動提案まで含めると不足し得る、というのが
 * 24を置いた理由。上限到達時に安全へ引き継げることを試験する（A18）。
 */
export const DEFAULT_CASE_CALL_LIMIT = 24;

export interface BudgetLimits {
  /** `case_call_limit`：1案件あたりの呼出し回数。schema修復・再試行も含む。 */
  readonly caseCallLimit?: number;
  /** `case_spend_limit`：1案件あたりの金額（USD整数micro）。 */
  readonly caseSpendLimitMicroUsd?: MicroUsd;
  /** `run_spend_limit`：実行全体の金額（USD整数micro）。 */
  readonly runSpendLimitMicroUsd?: MicroUsd;
}

/** 未設定検査を通した後の上限。すべて値が入っている。 */
export interface RequiredBudgetLimits {
  readonly caseCallLimit: number;
  readonly caseSpendLimitMicroUsd: MicroUsd;
  readonly runSpendLimitMicroUsd: MicroUsd;
}

export interface Reservation {
  readonly caseId: string;
  /** RFC-004 §8 の `request_id`。呼出し元が永続化した安定ID。再試行で変えない。 */
  readonly requestId: string;
  /**
   * 要求内容のハッシュ。**台帳へ保存し、再予約時に照合する。**
   * 同じIDで内容が異なる要求は拒否する（ADR-006 / RFC-009 D07）。
   */
  readonly requestHash: string;
  /**
   * 保守的な見積り（USD整数micro）。入力長・出力上限・候補モデル単価から決める。
   * 0以下は受け付けない。
   */
  readonly estimatedMicroUsd: MicroUsd;
}

export const RESERVATION_RESULT = {
  RESERVED: "RESERVED",
  /**
   * 同じ requestId で予約済み。新しい予約を作らない。
   *
   * **これは「呼出してよい」という意味ではない。** 呼出し元は保存済み結果を返すか、
   * 成否を照合するまで外部呼出しを再送してはならない（AGENTS.md）。
   */
  ALREADY_RESERVED: "ALREADY_RESERVED",
  /** 同じ requestId で内容が異なる。拒否する（D07）。 */
  HASH_MISMATCH: "HASH_MISMATCH",
  EXCEEDED_CALLS: "EXCEEDED_CALLS",
  EXCEEDED_CASE_SPEND: "EXCEEDED_CASE_SPEND",
  EXCEEDED_RUN_SPEND: "EXCEEDED_RUN_SPEND",
} as const;

export type ReservationResult = (typeof RESERVATION_RESULT)[keyof typeof RESERVATION_RESULT];

/**
 * 予約の記録先。
 *
 * **判定と加算を1つのメソッドにまとめている。** 読みと書きを別メソッドにすると、
 * 実装側でも原子化できず、同時返信時にN本が同時に上限検査を通過する。
 * DB実装では1つのSQL文または1トランザクションで行う。
 *
 * 予約は `requestId` で冪等にする。worker再起動やlease失効で同じイベントを
 * 再処理したとき、二重に予約して二重に課金しないため（ADR-006 / AGENTS.md）。
 */
export interface BudgetLedger {
  tryReserve(reservation: Reservation, limits: RequiredBudgetLimits): Promise<ReservationResult>;
  /**
   * 実測費用で精算する（RFC-004 §7）。
   * `costKind` が UNKNOWN_CHARGE のときは予約額を残す。取り消さない。
   *
   * **`requestId` で冪等でなければならない。** 結果を保存した直後、精算の前に
   * 停止すると、再試行は保存済み結果を返す経路へ入る。そこから精算をやり直せる
   * ように、同じ requestId への二度目の精算を二重計上しない実装にする。
   */
  settle(input: {
    requestId: string;
    actualMicroUsd?: MicroUsd;
    costKind: CostKind;
  }): Promise<void>;
}

export class BudgetGuard {
  constructor(
    private readonly limits: BudgetLimits,
    private readonly ledger: BudgetLedger,
  ) {}

  /**
   * 呼出し前に検査して予約する。上限超過・内容不一致は例外で止める。
   * 「上限が少なくても無視して続行」しない（RFC-011 §7）。
   *
   * **戻り値を必ず見ること。** `ALREADY_RESERVED` は「呼出してよい」ではなく
   * 「この要求はすでに実行を試みている」の意味。呼出し元は保存済み結果を返すか、
   * 成否を照合するまで外部呼出しを再送してはならない。
   */
  async reserve(reservation: Reservation): Promise<ReservationResult> {
    if (!isValidMicroUsd(reservation.estimatedMicroUsd) || reservation.estimatedMicroUsd <= 0) {
      // 見積り0を許すと、金額上限の比較が常に成立して予算が無効になる。
      // 単価が未確認でも、0ではなく保守的な見積りを渡すこと。
      throw new TaskcalError(
        ERROR_CODES.BUDGET_NOT_CONFIGURED,
        "1呼出しの費用見積り（USD整数micro）が未設定または不正なため、呼出しを開始しません。",
      );
    }

    const limits = this.requireLimits();
    const result = await this.ledger.tryReserve(reservation, limits);

    if (result === RESERVATION_RESULT.HASH_MISMATCH) {
      throw new TaskcalError(
        ERROR_CODES.OPERATION_CONFLICT,
        "同じ request_id で内容が異なる要求です。拒否します（ADR-006 / D07）。",
      );
    }
    if (result === RESERVATION_RESULT.RESERVED || result === RESERVATION_RESULT.ALREADY_RESERVED) {
      return result;
    }
    throw new TaskcalError(ERROR_CODES.BUDGET_EXCEEDED, EXCEEDED_MESSAGE[result]);
  }

  /** 実測費用または課金不明の確定。呼出し後に必ず呼ぶ。 */
  async settle(input: {
    requestId: string;
    actualMicroUsd?: MicroUsd;
    costKind: CostKind;
  }): Promise<void> {
    await this.ledger.settle(input);
  }

  private requireLimits(): RequiredBudgetLimits {
    const { caseSpendLimitMicroUsd, runSpendLimitMicroUsd } = this.limits;
    if (caseSpendLimitMicroUsd === undefined || runSpendLimitMicroUsd === undefined) {
      throw new TaskcalError(
        ERROR_CODES.BUDGET_NOT_CONFIGURED,
        "case_spend_limit / run_spend_limit が未設定のため、有料の推論呼出しを開始しません" +
          "（RFC-004 §7 / ADR-007 / Q10）。",
      );
    }
    return {
      caseSpendLimitMicroUsd,
      runSpendLimitMicroUsd,
      caseCallLimit: this.limits.caseCallLimit ?? DEFAULT_CASE_CALL_LIMIT,
    };
  }
}

const EXCEEDED_MESSAGE: Record<
  Exclude<ReservationResult, "RESERVED" | "ALREADY_RESERVED" | "HASH_MISMATCH">,
  string
> = {
  EXCEEDED_CALLS: "案件の呼出し回数上限（case_call_limit）に達しました。",
  EXCEEDED_CASE_SPEND: "案件の金額上限（case_spend_limit）に達しました。",
  EXCEEDED_RUN_SPEND: "実行全体の金額上限（run_spend_limit）に達しました。",
};

/**
 * モデル呼出しの結果の保存先。
 *
 * 予約とは別に、実際の結果を保存する。`ALREADY_RESERVED` になった要求に対して
 * 保存済み結果を返すため、および、結果が無い（＝呼出し中に落ちた）場合に
 * 再送せず照合へ回すために要る（AGENTS.md「結果照会または照合なしに、結果不明の
 * 外部作用を再実行しない」）。
 */
export interface ModelCallStore {
  /**
   * 保存済み結果。まだ無ければ `"NO_RESULT"`。
   * `"NO_RESULT"` は「呼出していない」ではなく「**結果が分からない**」。
   */
  findResult(requestId: string): Promise<StoredModelCall | "NO_RESULT">;
  saveResult(call: StoredModelCall): Promise<void>;
}

export interface StoredModelCall {
  readonly requestId: string;
  readonly requestHash: string;
  /**
   * 終了の種別。
   *
   * `SCHEMA_INVALID` と `UNKNOWN` も**確定した記録**として保存する。保存しないと、
   * 再試行時に予約済み＋結果なしとなり、判明している検証失敗を「結果不明」と
   * 誤分類する。また、例外オブジェクトにしか残っていない使用量（モデル、
   * prompt/schema版、routing source、latency）が再起動で失われる（RFC-004 §8）。
   */
  readonly outcome: "VALID" | "SCHEMA_INVALID" | "UNKNOWN";
  /** モデル出力。`VALID` 以外は undefined。 */
  readonly output?: unknown;
  /** 使用量。費用の確度を含む。再起動後もここから費用を説明できる。 */
  readonly usage: UsageRecord;
}
