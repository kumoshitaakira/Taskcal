/**
 * 外部から見えるerror code。
 *
 * 表示・ログには、秘密情報・不要な個人情報・内部推論・不要なメッセージ原文を
 * 出さない（AGENTS.md、ADR-008）。
 */

export const ERROR_CODES = {
  /** 認証されていない。 */
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /** 認証済みだが対象資源への権限がない。 */
  FORBIDDEN: "FORBIDDEN",
  /** 入力が契約に合わない。 */
  INVALID_INPUT: "INVALID_INPUT",
  /** MVPの対応範囲外（Q03分断時間、Q05日跨ぎ等）。黙って近い値へ丸めない。 */
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  /** 同じ operationId で内容が異なる（ADR-006）。 */
  OPERATION_CONFLICT: "OPERATION_CONFLICT",
  /** 期待版と現在版が一致しない。 */
  REVISION_CONFLICT: "REVISION_CONFLICT",
  /** 案件が停止済み。新規打診・正式採用を行わない（D10）。 */
  CASE_STOPPED: "CASE_STOPPED",
  /** 期限に達した。 */
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  /** 金額予算・回数上限が未設定、または到達した（ADR-007、D12）。 */
  BUDGET_NOT_CONFIGURED: "BUDGET_NOT_CONFIGURED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  /** 外部作用の結果が照合できない。再実行せず人の対応へ回す。 */
  RECONCILE_REQUIRED: "RECONCILE_REQUIRED",
  /** 依存先が未設定（例：OrcaRouterの接続情報が無い）。 */
  NOT_CONFIGURED: "NOT_CONFIGURED",
  /** 未実装。成功として扱わない。 */
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class TaskcalError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "TaskcalError";
    this.code = code;
  }
}
