/**
 * 推論の使用量・費用の記録。
 *
 * 出典：ADR-007、RFC-004、AGENTS.md「品質と証拠」。
 *
 * 規則：
 *   - モデル、prompt/schema版、Routerの選択主体、トークン・費用を記録し、
 *     それぞれが実測・推定・取得不能のどれかを明示する。
 *   - タイムアウトや結果不明を、費用0または確定失敗として記録しない。
 */

/** 値の確度。UNKNOWN を 0 に置き換えない。 */
export const MEASUREMENT = {
  /** 提供元の応答から取得した実測値。 */
  MEASURED: "MEASURED",
  /** 単価表等からこちらで計算した推定値。 */
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

export interface UsageRecord {
  readonly callId: string;
  readonly caseId?: string;
  readonly outcome: CallOutcome;
  /** 要求したモデル。Router規則に任せた場合は undefined。 */
  readonly requestedModel?: string;
  /** 実際に使われたモデル。取得できなければ undefined + modelMeasurement=UNKNOWN。 */
  readonly actualModel?: string;
  readonly modelMeasurement: Measurement;
  readonly routingSource: RoutingSource;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly tokenMeasurement: Measurement;
  /** 日本円。UNKNOWN のときは undefined にし、0 を入れない。 */
  readonly costJpy?: number;
  readonly costMeasurement: Measurement;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** 結果不明の呼出しの記録。費用0にしないための入口。 */
export function unknownOutcomeUsage(base: {
  callId: string;
  caseId?: string;
  requestedModel?: string;
  promptVersion: string;
  schemaVersion: string;
  routingSource: RoutingSource;
  startedAt: string;
  finishedAt: string;
}): UsageRecord {
  return {
    ...base,
    outcome: CALL_OUTCOME.UNKNOWN,
    modelMeasurement: MEASUREMENT.UNKNOWN,
    tokenMeasurement: MEASUREMENT.UNKNOWN,
    costMeasurement: MEASUREMENT.UNKNOWN,
  };
}
