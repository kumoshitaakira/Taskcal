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
  {
    label: "状態機械は遷移表と終端状態を対で持つ（ADR-017 / RFC-011 §5）",
    members: [
      { name: "export const ALLOWED_CASE_TRANSITIONS", file: "src/contracts/case-state.ts" },
      {
        name: "export const ALLOWED_OUTREACH_TRANSITIONS",
        file: "src/contracts/outreach-state.ts",
      },
      {
        name: "export const ALLOWED_SCHEDULE_UPDATE_TRANSITIONS",
        file: "src/contracts/schedule-update.ts",
      },
      { name: "export const ALLOWED_COMMITMENT_TRANSITIONS", file: "src/contracts/commitment.ts" },
    ],
    // prettier が折り返すため、1行に収まる前提の語を使わない。
    mustContain: ["Readonly<", "Record<"],
  },
  {
    label: "各状態機械が終端状態を宣言する（RFC-011 §5 / A11）",
    members: [
      { name: "export const TERMINAL_CASE_STATES", file: "src/contracts/case-state.ts" },
      { name: "export const TERMINAL_OUTREACH_STATES", file: "src/contracts/outreach-state.ts" },
      {
        name: "export const TERMINAL_SCHEDULE_UPDATE_STATES",
        file: "src/contracts/schedule-update.ts",
      },
      {
        name: "export const TERMINAL_COMMITMENT_STATUSES",
        file: "src/contracts/commitment.ts",
      },
    ],
    mustContain: ["readonly"],
  },
  {
    label: "選定可否を status 単独で決めない（D04 / A05）",
    members: [
      { name: "export function isSelectableCommitment", file: "src/contracts/commitment.ts" },
    ],
    mustContain: ["hasUnprocessedReply", "supersededBy", "deadlineAt"],
  },
  {
    label: "配送状態で打診状態を動かさない（A11 / RFC-011 §6）",
    members: [
      { name: "export function resolveOutreachAfterSend", file: "src/contracts/outreach-state.ts" },
    ],
    mustContain: ["FAILED", "UNKNOWN", "DELIVERY_NOT_SENT"],
  },
  {
    label: "本人と確認できない受信で状態を動かさない（A15 / RFC-011 §6）",
    members: [
      {
        name: "export function resolveOutreachAfterInbound",
        file: "src/contracts/outreach-state.ts",
      },
    ],
    mustContain: ["VERIFIED_OUTREACH_TARGET", "hasBody"],
  },
  {
    label: "repository の全操作が取引ハンドルを取る（RFC-010 §4 手順6 / D06）",
    members: [
      { name: "export interface AbsenceCaseRepository", file: "src/contracts/repository.ts" },
      { name: "export interface OutreachRepository", file: "src/contracts/repository.ts" },
      { name: "export interface CommitmentRepository", file: "src/contracts/repository.ts" },
      { name: "export interface InboundEventRepository", file: "src/contracts/repository.ts" },
      {
        name: "export interface ReplyInterpretationRepository",
        file: "src/contracts/repository.ts",
      },
      { name: "export interface OperationResultStore", file: "src/contracts/repository.ts" },
      { name: "export interface OutboxRepository", file: "src/contracts/repository.ts" },
    ],
    mustContain: ["tx: TxHandle"],
  },
  {
    label: "モデル呼出しは取引の外で行い、受信順のガードを通す（A12 / RFC-010 §5）",
    members: [
      { name: "export function interpretReply", file: "src/application/interpret-reply.ts" },
    ],
    // 取引の内側から呼ぶとHTTP待ちの間ロックを持つ。受信順のガードが無いと、
    // 遅れて返った古い結果が新しい承諾を戻す。
    mustContain: ["assertOutsideTransaction", "tryAdvanceAppliedSeq"],
  },
  {
    label: "承諾にできない返信も状態へ反映する（Q09 / RFC-011 §4）",
    members: [
      { name: "export function interpretReply", file: "src/application/interpret-reply.ts" },
    ],
    // 「承諾として採用しない」と「返信を無視する」は別。辞退・撤回・保留を扱う。
    mustContain: ["DECLINE", "WITHDRAW", "HELD", "CLARIFYING"],
  },
  {
    label: "営業日を date 型のまま受け取らない（RFC-009 §5：表示と月境界は店舗timezone）",
    members: [
      { name: "const COLUMNS", file: "src/adapters/db/case-repository.ts" },
      {
        name: "export function createPgScheduleReadRepository",
        file: "src/adapters/db/schedule-repository.ts",
      },
      { name: "export function createAbsenceCase", file: "src/application/create-absence-case.ts" },
    ],
    // node-pg は date 列をローカル深夜の Date にする。JST では toISOString() が
    // 前日になり、営業日が1日ずれる。SQL側で文字列にして受け取る。
    mustContain: ["to_char("],
  },
  {
    label: "送信は未送信（SendRefused）と配送失敗を区別する（A15 / RFC-011 §6）",
    members: [{ name: "async send", file: "src/adapters/channel/mock-inbox.ts" }],
    // 3つの拒否理由をすべて扱う。いずれも外部作用が起きていないので、
    // DeliveryState.FAILED と同じ扱いにしない。
    mustContain: ["ENDPOINT_CHANGED", "NOT_PERMITTED", "CONFLICT"],
  },
  {
    label: "受信の永続化と解釈が案件内の受信順を持つ（A12 / RFC-011 §4）",
    members: [
      { name: "export interface InboundEventRepository", file: "src/contracts/repository.ts" },
      {
        name: "export interface ReplyInterpretationRepository",
        file: "src/contracts/repository.ts",
      },
    ],
    // 受信側は PersistedInboundEvent（caseId と receivedSeq を必須にした型）で、
    // 解釈側は receivedSeq を直接受け取る。表現が違うため any。
    mode: "any",
    mustContain: ["receivedSeq", "PersistedInboundEvent"],
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
