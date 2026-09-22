/**
 * モデル呼出しの使用量・費用の読み取りモデル（RFC-004 §7・§8、AGENTS.md「品質と証拠」）。
 *
 * **実測・推定・取得不能を畳まない。** 1つの数字にまとめると、応答から取れた実測値と、
 * こちらの単価表からの推定値と、結果不明で予約額を残しているものが同じに見える。
 * 呼出しごとに区別して返し、画面でもそのまま出す。
 *
 * 費用の合計は**精算済みと未精算を分けて**返す。未精算（予約だけ）を合計へ混ぜると、
 * まだ使っていない額を使った額として表示する。逆に未精算を落とすと、結果不明の
 * 呼出しが費用0に見える——これは AGENTS.md が明示的に禁じている。
 *
 * 円換算は**表示のためだけ**に行い、換算日時とレートを添える（RFC-004 §7）。
 * レートが設定されていなければ換算しない。持っていないレートを作らない。
 */

import "server-only";
import { withTransaction } from "../adapters/db/transaction";
import { getServerEnv } from "../config/env";
import {
  toJpyForDisplay,
  type CostKind,
  type JpyDisplay,
  type Measurement,
  type MicroUsd,
  type ModelCallStep,
  type RoutingSource,
  type UsageRecord,
  type ValidationResult,
} from "../adapters/orca/usage";

export interface ModelCallView {
  readonly requestId: string;
  readonly step: ModelCallStep;
  readonly outcome: "VALID" | "SCHEMA_INVALID" | "UNKNOWN";
  /** 要求したモデル。Router規則に任せた場合は undefined。 */
  readonly requestedModel?: string;
  /** 応答から取れた実使用モデル。取れなければ undefined（UNKNOWN）。 */
  readonly resolvedModel?: string;
  readonly modelMeasurement: Measurement;
  /** Routerが選んだか、アプリが選んだか（RFC-004）。 */
  readonly routingSource: RoutingSource;
  readonly promptVersion: string;
  readonly rulesVersion: string;
  readonly inputTokens?: number;
  /** 推論トークンを含む出力トークン。 */
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  /** 要求した出力上限を実測が超えたか。超えていれば予約が実費を下回り得る。 */
  readonly outputLimitExceeded?: boolean;
  readonly tokenMeasurement: Measurement;
  readonly costMicroUsd?: MicroUsd;
  readonly costKind: CostKind;
  readonly latencyMs?: number;
  readonly validationResult: ValidationResult;
  readonly createdAt: string;
}

export interface ModelSpendView {
  /** 精算済みの合計。実測・推定の両方を含む。 */
  readonly settledMicroUsd: MicroUsd;
  /** まだ精算していない予約額。**0として扱わない。** */
  readonly reservedMicroUsd: MicroUsd;
  /** 結果不明として予約額を残している件数。 */
  readonly unknownChargeCount: number;
  /**
   * 要求した出力上限を実測が超えた件数。
   * **0でなければ、予約が実費を下回り得る**（RFC-004 §7の前提が崩れている）。
   */
  readonly outputLimitExceededCount: number;
  readonly callCount: number;
  /** 表示用の円換算。レート未設定なら undefined（換算しない）。 */
  readonly jpy?: JpyDisplay;
}

export interface ModelUsageView {
  readonly spend: ModelSpendView;
  readonly calls: readonly ModelCallView[];
}

interface CallRow {
  readonly request_id: string;
  readonly outcome: ModelCallView["outcome"];
  readonly usage: UsageRecord;
  readonly created_at: Date;
}

interface SpendRow {
  readonly settled: string | null;
  readonly reserved: string | null;
  readonly unknown_charges: number;
}

/**
 * 案件のモデル呼出しを読む。
 *
 * 呼出しが1件も無いことと、費用が0であることは同じではない。呼出しが無ければ
 * 件数0で返し、画面は「まだ呼んでいない」と出す。
 */
export async function getModelUsageView(caseId: string): Promise<ModelUsageView> {
  return withTransaction(async (tx) => {
    const calls = await tx.query<CallRow>(
      `select request_id, outcome, usage, created_at
         from model_call where case_id = $1 order by created_at desc limit 50`,
      [caseId],
    );

    // 未精算（settled_at is null）は予約額で数える。結果不明で精算済みのものは
    // settled 側に入り、cost_kind が UNKNOWN_CHARGE として残る。
    const spend = await tx.query<SpendRow>(
      `select coalesce(sum(settled_micro_usd), 0)::text as settled,
              coalesce(sum(estimated_micro_usd) filter (where settled_at is null), 0)::text
                as reserved,
              count(*) filter (where cost_kind = 'UNKNOWN_CHARGE')::int as unknown_charges
         from budget_reservation where case_id = $1`,
      [caseId],
    );
    const row = spend.rows[0];
    const settledMicroUsd = Number(row?.settled ?? 0);
    const reservedMicroUsd = Number(row?.reserved ?? 0);

    const rate = getServerEnv().ORCA_DISPLAY_JPY_PER_USD;
    return {
      spend: {
        settledMicroUsd,
        reservedMicroUsd,
        unknownChargeCount: row?.unknown_charges ?? 0,
        outputLimitExceededCount: calls.rows.filter((c) => c.usage.outputLimitExceeded === true)
          .length,
        callCount: calls.rows.length,
        // レートが無ければ換算しない。持っていないレートを作らない（RFC-004 §7）。
        jpy:
          rate === undefined
            ? undefined
            : toJpyForDisplay(settledMicroUsd + reservedMicroUsd, rate, new Date().toISOString()),
      },
      calls: calls.rows.map((call) => ({
        requestId: call.request_id,
        outcome: call.outcome,
        step: call.usage.step,
        requestedModel: call.usage.requestedModel,
        resolvedModel: call.usage.resolvedModel,
        modelMeasurement: call.usage.modelMeasurement,
        routingSource: call.usage.routingSource,
        promptVersion: call.usage.promptVersion,
        rulesVersion: call.usage.rulesVersion,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        reasoningTokens: call.usage.reasoningTokens,
        outputLimitExceeded: call.usage.outputLimitExceeded,
        tokenMeasurement: call.usage.tokenMeasurement,
        costMicroUsd: call.usage.costMicroUsd,
        costKind: call.usage.costKind,
        latencyMs: call.usage.latencyMs,
        validationResult: call.usage.validationResult,
        createdAt: call.created_at.toISOString(),
      })),
    };
  });
}
