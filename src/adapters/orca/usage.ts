/**
 * 推論の使用量・費用の記録。
 *
 * 出典：RFC-004 §7・§8、ADR-007、AGENTS.md「品質と証拠」。
 *
 * 規則：
 *   - 金額は**USDの整数micro単位**で記録する（RFC-004 §7）。円換算は表示時に、
 *     換算日時とレートを添えて行う。内部で浮動小数の円を持たない。
 *   - モデル、prompt/rules版、Routerの選択主体、トークン・費用を記録し、
 *     それぞれが実測・推定・取得不能のどれかを明示する。
 *   - タイムアウトや結果不明を、費用0または確定失敗として記録しない。
 *     課金不明は UNKNOWN_CHARGE とし、予約を残す（RFC-004 §7）。
 */

/** モデルを呼んだ処理（RFC-004 §6・§8）。 */
export const MODEL_CALL_STEP = {
  /** 短い自然文の条件抽出。 */
  INTERPRET_REPLY: "INTERPRET_REPLY",
  /** schema不正・根拠不一致からの修復／昇格。 */
  REPAIR: "REPAIR",
  /** 次行動の選択。 */
  SELECT_ACTION: "SELECT_ACTION",
} as const;

export type ModelCallStep = (typeof MODEL_CALL_STEP)[keyof typeof MODEL_CALL_STEP];

/** schema検査の結果（RFC-004 §8 の `validation_result`）。 */
export const VALIDATION_RESULT = {
  VALID: "VALID",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  /** 呼出しが成立せず、検査に到達していない。 */
  NOT_EVALUATED: "NOT_EVALUATED",
} as const;

export type ValidationResult = (typeof VALIDATION_RESULT)[keyof typeof VALIDATION_RESULT];

/** USDの整数micro単位（1 USD = 1_000_000）。小数を持たない。 */
export type MicroUsd = number;

export const MICRO_USD_PER_USD = 1_000_000;

export function isValidMicroUsd(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 費用の確度（RFC-004 §8 の `cost_kind`）。
 * UNKNOWN_CHARGE を 0 に置き換えない。
 */
export const COST_KIND = {
  /** 提供元の応答から取得した実測値。 */
  MEASURED: "MEASURED",
  /** 単価表等からこちらで計算した推定値。精算前の予約額を含む。 */
  ESTIMATED: "ESTIMATED",
  /** 課金されたかどうかも分からない。0ではない。予約を残す（RFC-004 §7）。 */
  UNKNOWN_CHARGE: "UNKNOWN_CHARGE",
} as const;

export type CostKind = (typeof COST_KIND)[keyof typeof COST_KIND];

/** 金額以外の値の確度。 */
export const MEASUREMENT = {
  MEASURED: "MEASURED",
  ESTIMATED: "ESTIMATED",
  /** 取得できなかった。0ではない。 */
  UNKNOWN: "UNKNOWN",
} as const;

export type Measurement = (typeof MEASUREMENT)[keyof typeof MEASUREMENT];

/** モデルを選んだ主体。Router規則が使えずアプリで選んだ場合を区別する（RFC-004）。 */
export const ROUTING_SOURCE = {
  ROUTER: "ROUTER",
  APPLICATION: "APPLICATION",
  UNKNOWN: "UNKNOWN",
} as const;

export type RoutingSource = (typeof ROUTING_SOURCE)[keyof typeof ROUTING_SOURCE];

/** 呼出しの終了状態。UNKNOWN を失敗にも成功にも畳まない。 */
export const CALL_OUTCOME = {
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  /** タイムアウト・応答喪失など。課金の有無も不明。 */
  UNKNOWN: "UNKNOWN",
} as const;

export type CallOutcome = (typeof CALL_OUTCOME)[keyof typeof CALL_OUTCOME];

/**
 * 1回の呼出しの記録。項目名はRFC-004 §8に合わせる。
 *
 * モデルが返したモデル名をそのまま実使用モデルの証拠にしない。API応答・正式ログ
 * から取れない項目はUNKNOWNとする（RFC-004 §8）。
 */
export interface UsageRecord {
  /** RFC-004 §8 の `request_id`。呼出し元が永続化した安定ID。再試行で変えない。 */
  readonly requestId: string;
  readonly caseId?: string;
  /**
   * RFC-004 §8 の `run_id`。デモ・評価の実行単位。
   * `run_spend_limit` をどの残額に対して検査するかを決める（RFC-004 §7）。
   * 全履歴を一つのrunとして累積すると、後続のrunを誤って止める。
   */
  readonly runId: string;
  /** RFC-004 §8 の `step`。案件内のどの処理でモデルを呼んだか。 */
  readonly step: ModelCallStep;
  readonly outcome: CallOutcome;
  /** RFC-004 §8 の `requested_model`。Router規則に任せた場合は undefined。 */
  readonly requestedModel?: string;
  /** RFC-004 §8 の `resolved_model`。取得できなければ undefined + UNKNOWN。 */
  readonly resolvedModel?: string;
  readonly modelMeasurement: Measurement;
  readonly routingSource: RoutingSource;
  readonly promptVersion: string;
  /** RFC-004 §8 の `rules_version`（抽出規則・出力schemaの版）。 */
  readonly rulesVersion: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly tokenMeasurement: Measurement;
  /**
   * USDの整数micro単位。`costKind` が UNKNOWN_CHARGE のときは、実費ではなく
   * 予約額を保持する（0にしない）。
   */
  readonly costMicroUsd?: MicroUsd;
  readonly costKind: CostKind;
  readonly latencyMs?: number;
  /** RFC-004 §8 の `validation_result`。schema検査の結果。 */
  readonly validationResult: ValidationResult;
  /**
   * RFC-004 §8 の `action_key`。この呼出しが提案した次行動。
   * 検査を通らなかった場合は undefined。
   */
  readonly actionKey?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * 課金不明の呼出しの記録。
 *
 * 予約額をそのまま費用として残す。0円にしないため（RFC-004 §7）。
 */
export function unknownChargeUsage(base: {
  requestId: string;
  caseId?: string;
  runId: string;
  step: ModelCallStep;
  requestedModel?: string;
  promptVersion: string;
  rulesVersion: string;
  routingSource: RoutingSource;
  /** 呼出し前に予約した額。取り消さずに残す。 */
  reservedMicroUsd: MicroUsd;
  startedAt: string;
  finishedAt: string;
}): UsageRecord {
  const { reservedMicroUsd, ...rest } = base;
  return {
    ...rest,
    outcome: CALL_OUTCOME.UNKNOWN,
    modelMeasurement: MEASUREMENT.UNKNOWN,
    tokenMeasurement: MEASUREMENT.UNKNOWN,
    costMicroUsd: reservedMicroUsd,
    costKind: COST_KIND.UNKNOWN_CHARGE,
    latencyMs: Date.parse(rest.finishedAt) - Date.parse(rest.startedAt),
    // 呼出しが成立していないため、検査に到達していない。
    validationResult: VALIDATION_RESULT.NOT_EVALUATED,
  };
}

/**
 * 表示用の円換算。**記録には使わない。**
 * 換算日時とレートを必ず添える（RFC-004 §7）。
 */
export interface JpyDisplay {
  readonly jpy: number;
  readonly rateJpyPerUsd: number;
  readonly convertedAt: string;
}

export function toJpyForDisplay(
  costMicroUsd: MicroUsd,
  rateJpyPerUsd: number,
  convertedAt: string,
): JpyDisplay {
  return {
    jpy: (costMicroUsd / MICRO_USD_PER_USD) * rateJpyPerUsd,
    rateJpyPerUsd,
    convertedAt,
  };
}
