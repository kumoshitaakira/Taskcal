/**
 * モデル呼出しの使用量・費用の表示（RFC-004 §7・§8、AGENTS.md「品質と証拠」）。
 *
 * **実測・推定・取得不能を同じ見た目にしない。** 応答から取れた値と、こちらの単価表
 * から計算した値と、結果不明で予約額を残しているものを、それぞれ別のタグで出す。
 * 1つの数字に畳むと、確かめていない数字を実績として読ませる。
 *
 * 結果不明（`UNKNOWN_CHARGE`）を「0円」や「失敗」と書かない。課金されたかどうかが
 * 分からないという意味で、予約額をそのまま出す。
 */

import type { ModelUsageView } from "@/application/model-usage-view";
import type { CostKind, Measurement } from "@/adapters/orca/usage";
import { MICRO_USD_PER_USD } from "@/adapters/orca/usage";

const MEASUREMENT_LABEL: Record<Measurement, string> = {
  MEASURED: "実測",
  ESTIMATED: "推定",
  UNKNOWN: "取得不能",
};

const MEASUREMENT_CLASS: Record<Measurement, string> = {
  MEASURED: "tag tag-ok",
  ESTIMATED: "tag",
  // 取れなかったことを失敗と書かない。分からないだけ。
  UNKNOWN: "tag tag-warn",
};

const COST_KIND_LABEL: Record<CostKind, string> = {
  MEASURED: "実測",
  ESTIMATED: "推定（予約額）",
  UNKNOWN_CHARGE: "課金の有無が不明",
};

const COST_KIND_CLASS: Record<CostKind, string> = {
  MEASURED: "tag tag-ok",
  ESTIMATED: "tag",
  UNKNOWN_CHARGE: "tag tag-warn",
};

const STEP_LABEL: Record<string, string> = {
  INTERPRET_REPLY: "返信の解釈",
  REPAIR: "出力の修復",
  SELECT_ACTION: "次行動の選択",
};

const OUTCOME_LABEL: Record<string, string> = {
  VALID: "schema検査を通過",
  SCHEMA_INVALID: "schema不正",
  UNKNOWN: "結果不明",
};

const ROUTING_LABEL: Record<string, string> = {
  ROUTER: "Routerが選択",
  APPLICATION: "アプリが指定",
  UNKNOWN: "取得不能",
};

/** 対応表に無い値を握り潰さない。生の値を出して、訳し忘れに気付けるようにする。 */
function label(map: Record<string, string>, value: string): string {
  return map[value] ?? `未対応の値: ${value}`;
}

/** USDの整数micro単位を表示用の文字列へ。内部では丸めない。 */
function usd(microUsd: number): string {
  return `${(microUsd / MICRO_USD_PER_USD).toFixed(6)} USD`;
}

export function UsagePanel({ usage }: { usage: ModelUsageView }) {
  const { spend, calls } = usage;

  if (spend.callCount === 0 && spend.reservedMicroUsd === 0 && spend.settledMicroUsd === 0) {
    return (
      <div className="panel">
        <p className="lede" style={{ margin: 0 }}>
          この案件でモデルを呼んでいません。<strong>費用0ではなく、呼出しが0件</strong>です。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <dl>
          <div className="row">
            <dt>精算済み</dt>
            <dd>{usd(spend.settledMicroUsd)}</dd>
          </div>
          <div className="row">
            <dt>未精算の予約</dt>
            <dd>
              {usd(spend.reservedMicroUsd)}
              {spend.reservedMicroUsd > 0 ? "（まだ使っていない枠。合計には足さない）" : ""}
            </dd>
          </div>
          {spend.unknownChargeCount > 0 ? (
            <div className="row">
              <dt>
                <span className="tag tag-warn">課金の有無が不明</span>
              </dt>
              <dd>
                {spend.unknownChargeCount}{" "}
                件。予約額をそのまま費用として残しています（0円にしません）。
              </dd>
            </div>
          ) : null}
          <div className="row">
            <dt>呼出し回数</dt>
            <dd>{spend.callCount} 件</dd>
          </div>
          {spend.jpy ? (
            <div className="row">
              <dt>円換算（表示のみ）</dt>
              <dd>
                約 {Math.round(spend.jpy.jpy)} 円（1 USD = {spend.jpy.rateJpyPerUsd} 円／
                {spend.jpy.convertedAt.slice(0, 16).replace("T", " ")} 換算）。
                記録はUSDのmicro単位のままです。
              </dd>
            </div>
          ) : (
            <div className="row">
              <dt>円換算</dt>
              <dd>
                レート未設定のため換算していません（<code>ORCA_DISPLAY_JPY_PER_USD</code>）。
              </dd>
            </div>
          )}
        </dl>
      </div>

      {calls.length > 0 ? (
        <table className="grid">
          <thead>
            <tr>
              <th>処理</th>
              <th>結果</th>
              <th>モデル</th>
              <th>選択</th>
              <th>トークン</th>
              <th>費用</th>
              <th>prompt／schema版</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr key={call.requestId}>
                <td>{label(STEP_LABEL, call.step)}</td>
                <td>{label(OUTCOME_LABEL, call.outcome)}</td>
                <td>
                  <span className="tags">
                    <span className={MEASUREMENT_CLASS[call.modelMeasurement]}>
                      {MEASUREMENT_LABEL[call.modelMeasurement]}
                    </span>
                  </span>{" "}
                  {/* 要求したモデルと、実際に使われたモデルを分けて出す。 */}
                  {call.resolvedModel ?? "—"}
                  {call.requestedModel && call.requestedModel !== call.resolvedModel
                    ? `（要求: ${call.requestedModel}）`
                    : ""}
                </td>
                <td>{label(ROUTING_LABEL, call.routingSource)}</td>
                <td>
                  <span className="tags">
                    <span className={MEASUREMENT_CLASS[call.tokenMeasurement]}>
                      {MEASUREMENT_LABEL[call.tokenMeasurement]}
                    </span>
                  </span>{" "}
                  {call.inputTokens ?? "—"} / {call.outputTokens ?? "—"}
                </td>
                <td>
                  <span className="tags">
                    <span className={COST_KIND_CLASS[call.costKind]}>
                      {COST_KIND_LABEL[call.costKind]}
                    </span>
                  </span>{" "}
                  {call.costMicroUsd === undefined ? "—" : usd(call.costMicroUsd)}
                </td>
                <td>
                  {call.promptVersion}
                  <br />
                  {call.rulesVersion}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="notice">
        実測・推定・取得不能を分けて出しています（RFC-004 §8）。
        1回通ったことと、固定fixtureによる評価（RFC-008）は別です。
      </div>
    </>
  );
}
