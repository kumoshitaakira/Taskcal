/**
 * 同種の操作群が同じ規則を持つか。
 *
 * PR #4 で観測した外部指摘のうち、最も多かった分類が「片方に入れた規則を、
 * もう片方に入れていない」だった。`getUpdateResult` は接続範囲を必須にしながら
 * `applyUpdate` は持たない、`resolveReconcile` をScheduleUpdate側に作り案件側に
 * 作らない、など。
 *
 * **汎用の推論はしない。** ここに書いた組だけを見る。新しい契約を足したら、
 * 対になる規則をここへ追加する。書き忘れれば検出できない。
 *
 * 判定は既定で `all`（全ての語が要る）。ラベルが「かつ」を主張しているのに
 * `any` で判定すると、片方を落としても通る検査になる。表現が揺れる場合だけ
 * `any` を明示する。
 */
export interface SymmetryRule {
  /** 何を守る検査か。守っている受入ケース・不変条件を併記する。 */
  readonly label: string;
  readonly members: readonly { readonly name: string; readonly file: string }[];
  readonly mustContain: readonly string[];
  /** `all`（既定）は全て必要。`any` はいずれか1つ。 */
  readonly mode?: "all" | "any";
}

export const SYMMETRY_RULES: readonly SymmetryRule[] = [
  {
    label: "ScheduleGateway の全操作が接続範囲を取る（A01 / D11）",
    members: [
      { name: "loadSchedule", file: "src/contracts/schedule-gateway.ts" },
      // applyUpdate は接続範囲をコマンド型で受ける。
      { name: "export interface ApplyUpdateCommand", file: "src/contracts/schedule-gateway.ts" },
      { name: "getUpdateResult", file: "src/contracts/schedule-gateway.ts" },
      { name: "readBack", file: "src/contracts/schedule-gateway.ts" },
    ],
    mustContain: ["connectionId"],
  },
  {
    label: "結果照会は期待ハッシュを受け、内容不一致を返せる（A03 / D07 / D09）",
    members: [
      { name: "getUpdateResult", file: "src/contracts/schedule-gateway.ts" },
      { name: "getSendResult", file: "src/contracts/messaging-gateway.ts" },
    ],
    mustContain: ["expectedRequestHash", "CONFLICT"],
  },
  {
    label: "外部作用のコマンドは操作IDと内容ハッシュを持つ（ADR-006 / D07）",
    members: [
      { name: "export interface ApplyUpdateCommand", file: "src/contracts/schedule-gateway.ts" },
      { name: "export interface SendCommand", file: "src/contracts/messaging-gateway.ts" },
    ],
    mustContain: ["operation: OperationRef"],
  },
  {
    label: "ハッシュ対象に接続範囲・宛先を含める（A15）",
    members: [
      {
        name: "export interface ApplyUpdatePayloadForHash",
        file: "src/contracts/schedule-gateway.ts",
      },
      { name: "export interface SendPayloadForHash", file: "src/contracts/messaging-gateway.ts" },
    ],
    // 片方は connectionId、片方は to: ContactEndpointRef で接続範囲を表す。
    // ここだけは表現が違うため any。
    mode: "any",
    mustContain: ["connectionId: ConnectionId", "to: ContactEndpointRef"],
  },
  {
    label: "照合の解決は3つの結果すべてを扱う（A03 / A13 / ADR-022）",
    members: [
      { name: "export function resolveCaseReconcile", file: "src/contracts/case-state.ts" },
      { name: "export function resolveReconcile", file: "src/contracts/schedule-update.ts" },
    ],
    mustContain: ["CONFIRMED_ADOPTED", "CONFIRMED_NOT_ADOPTED", "STILL_UNKNOWN"],
  },
  {
    label: "有料呼出しの全経路が予約と精算を対で行う（RFC-004 §7 / D12）",
    members: [
      { name: "async interpretReply", file: "src/adapters/orca/orca-client.ts" },
      { name: "private async replayStored", file: "src/adapters/orca/orca-client.ts" },
      // タイムアウト・HTTPエラーが合流する経路。予約の取り残しが実際に起きる。
      { name: "private async unknownCharge", file: "src/adapters/orca/orca-client.ts" },
    ],
    mode: "any",
    mustContain: ["budget.settle"],
  },
  {
    label: "呼出し経路は予約してから呼ぶ（RFC-004 §7）",
    members: [{ name: "async interpretReply", file: "src/adapters/orca/orca-client.ts" }],
    mustContain: ["budget.reserve", "budget.settle"],
  },
];

/**
 * 1つの定義が規則を満たすか。満たさない場合は不足している語を返す。
 *
 * ファイルを読む処理から分けてある。規則が実際に落ちることを、実ファイルを
 * 書き換えずにメモリ上で確かめられるようにするため（テストが実ファイルを
 * 壊すと、並行実行する他のテストを巻き込む）。
 */
export function evaluateRule(
  rule: SymmetryRule,
  body: string,
): { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] } {
  const missing = rule.mustContain.filter((needle) => !body.includes(needle));
  const failed =
    rule.mode === "any" ? missing.length === rule.mustContain.length : missing.length > 0;
  return failed ? { ok: false, missing } : { ok: true };
}
