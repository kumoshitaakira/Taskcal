/**
 * 操作の結果表示。
 *
 * Server Action の戻り値を画面へ出すには `useActionState`（クライアント
 * コンポーネント）が要る。この画面では `"use client"` を増やさない方針なので、
 * 代わりに**あらかじめ決めた通知コード**を付けてredirectし、ここで文言へ直す。
 *
 * URLへ文言そのものを載せない。載せると、任意の文字列を画面へ出すリンクを作れて
 * しまう（Reactがエスケープするので実行はされないが、偽の案内は出せる）。
 */

export const NOTICE = {
  CASE_CREATED: "CASE_CREATED",
  CASE_REPLAYED: "CASE_REPLAYED",
  CASE_CONFLICT: "CASE_CONFLICT",
  CASE_INVALID: "CASE_INVALID",
  CASE_OUT_OF_SCOPE: "CASE_OUT_OF_SCOPE",
  CASE_RECONCILE: "CASE_RECONCILE",
  OUTREACH_STARTED: "OUTREACH_STARTED",
  OUTREACH_REPLAYED: "OUTREACH_REPLAYED",
  OUTREACH_NONE: "OUTREACH_NONE",
  OUTREACH_CONFLICT: "OUTREACH_CONFLICT",
  OUTREACH_STOPPED: "OUTREACH_STOPPED",
  OUTREACH_DEADLINE: "OUTREACH_DEADLINE",
  ADOPT_ADOPTED: "ADOPT_ADOPTED",
  ADOPT_REPLAYED: "ADOPT_REPLAYED",
  ADOPT_ATTENTION: "ADOPT_ATTENTION",
  ADOPT_NOT_FEASIBLE: "ADOPT_NOT_FEASIBLE",
  ADOPT_REJECTED: "ADOPT_REJECTED",
  ADOPT_RECONCILE: "ADOPT_RECONCILE",
  ADOPT_NOT_IMPLEMENTED: "ADOPT_NOT_IMPLEMENTED",
  ADOPT_STOPPED: "ADOPT_STOPPED",
  ADOPT_DEADLINE: "ADOPT_DEADLINE",
  ADOPT_CONFLICT: "ADOPT_CONFLICT",
  STOP_CANCELLED: "STOP_CANCELLED",
  STOP_HANDED_OFF: "STOP_HANDED_OFF",
  STOP_COMMITTED: "STOP_COMMITTED",
  STOP_DEFERRED: "STOP_DEFERRED",
  STOP_RECONCILE: "STOP_RECONCILE",
  STOP_ALREADY: "STOP_ALREADY",
  STOP_CONFLICT: "STOP_CONFLICT",
  STOP_NOT_ALLOWED: "STOP_NOT_ALLOWED",
  REPLY_RECORDED: "REPLY_RECORDED",
  REPLY_DUPLICATE: "REPLY_DUPLICATE",
  REPLY_UNMATCHED: "REPLY_UNMATCHED",
  REPLY_TOO_LONG: "REPLY_TOO_LONG",
  INPUT_MISSING: "INPUT_MISSING",
  FAILED: "FAILED",
} as const;

export type NoticeCode = (typeof NOTICE)[keyof typeof NOTICE];

const TEXT: Record<NoticeCode, (count?: number) => string> = {
  CASE_CREATED: () => "案件を作成しました。",
  CASE_REPLAYED: () => "同じ操作なので、既存の案件を表示しています。",
  CASE_CONFLICT: () => "この勤務、またはこの店舗で進行中の案件があります（同時1案件。D02）。",
  CASE_INVALID: () => "入力が条件を満たしません。勤務の状態と回答期限を確認してください。",
  CASE_OUT_OF_SCOPE: () =>
    "対応範囲外です。部分欠勤・日跨ぎ・職種違いは明示的に拒否します（Q03〜Q05）。",
  CASE_RECONCILE: () => "同じ操作が進行中です。結果を確認してから再実行してください。",
  OUTREACH_STARTED: (count) => `${count ?? 0}件の打診を作成しました。送信はworkerが行います。`,
  OUTREACH_REPLAYED: (count) => `同じ操作なので、既存の${count ?? 0}件の打診を表示しています。`,
  OUTREACH_NONE: () => "打診できる候補がいませんでした。",
  OUTREACH_CONFLICT: () => "この案件ではすでに打診を開始しています。",
  OUTREACH_STOPPED: () => "停止済みの案件です。新規の打診は行いません（D10）。",
  OUTREACH_DEADLINE: () => "回答期限を過ぎています。",
  ADOPT_ADOPTED: (count) => `${count ?? 0}件の代替勤務を正式採用しました。読戻しも一致しています。`,
  ADOPT_REPLAYED: (count) => `同じ操作なので、採用済みの${count ?? 0}件を表示しています。`,
  // 採用は取り消さない。確定した事実を保ったまま、読戻しの不一致だけを伝える（D09）。
  ADOPT_ATTENTION: (count) =>
    `${count ?? 0}件を正式採用しましたが、正式版の読戻しが一致しません。採用は取り消さず要対応にしました（A07 / D09）。`,
  ADOPT_NOT_FEASIBLE: () =>
    "実行可能な計画がありませんでした。案件は調整中のままです（A16）。選定結果は記録しています。",
  ADOPT_REJECTED: () => "前提が変わったため採用しませんでした。成果物は未採用として残しています。",
  // 未採用と断定しない。再実行もしない（A03 / ADR-022）。
  ADOPT_RECONCILE: () =>
    "勤務表の更新結果を照合できません。再実行せず、照合できるまで待ちます（A03）。",
  ADOPT_NOT_IMPLEMENTED: () =>
    "正式採用に必要な依存（勤務表の管理版ストアなど）が未実装または未設定です。採用は行っていません。",
  ADOPT_STOPPED: () => "停止済みの案件です。正式採用は行いません（D10）。",
  ADOPT_DEADLINE: () => "回答期限を過ぎています。正式採用は行いません。",
  ADOPT_CONFLICT: () => "案件または勤務表が並行して更新されました。読み直してください。",
  // 件数は**積んだ**数。送信はworkerが順次行う。送信済みの数ではない。
  STOP_CANCELLED: (count) =>
    `調整を停止しました。打診と承諾を失効させ、募集終了の通知を${count ?? 0}件積みました（送信は順次）。停止は取り消せません。`,
  // 引き継ぎは「片付いた」ではない。欠勤枠は埋まっていない。
  STOP_HANDED_OFF: (count) =>
    `自動調整を終了し、人へ引き継ぎました。欠勤枠は埋まっていません。募集終了の通知を${count ?? 0}件積みました（ADR-022）。`,
  // 停止より先に正式採用が成立していた。確定した事実は消さない（D10）。
  STOP_COMMITTED: () =>
    "停止は記録しました。以後の新規打診・正式採用は行いません。ただし停止より先に正式採用が成立していたため、確定した勤務はそのまま保持します（D10）。",
  // 期限・上限を検知しただけで引き継がない（Q13）。
  STOP_DEFERRED: () =>
    "停止を記録しました。並行する正式採用の結果を確認してから行き先を決めます（Q13）。",
  STOP_RECONCILE: () =>
    "停止を記録しましたが、正式採用の成否を照合できません。未採用と断定せず照合を続けます（A03）。",
  STOP_ALREADY: () => "すでに停止しています。停止は取り消せません。",
  // 停止できない状態ではない。読み直して再試行してよい。
  STOP_CONFLICT: () =>
    "案件が並行して更新されました。停止は成立していません。読み直してもう一度実行してください。",
  STOP_NOT_ALLOWED: () => "この状態では停止できません。確定済みの勤務の取消は別の操作です（D10）。",
  REPLY_RECORDED: (seq) => `返信を受け取りました（受信順 ${seq ?? "-"}）。`,
  REPLY_DUPLICATE: () => "同じ返信をすでに受け取っています。",
  REPLY_UNMATCHED: () =>
    "受信は記録しましたが、打診の宛先と一致しないため承諾には使いません（A15）。",
  REPLY_TOO_LONG: () => "返信が長すぎます。",
  INPUT_MISSING: () => "入力が足りません。",
  FAILED: () => "処理に失敗しました。ログを確認してください。",
};

/**
 * 結果不明・要対応。**成功でも失敗でもない。**
 *
 * 「失敗」と書くと未確定と読まれ（ADR-022）、「実行しました」と書くと成功と読まれる。
 * どちらも誤りなので、3つ目のトーンを持つ。`case-panel.tsx` が状態タグで `tag-warn` を
 * 使っているのと同じ語彙にそろえる。
 */
const WARN: readonly NoticeCode[] = [
  NOTICE.ADOPT_ATTENTION,
  NOTICE.ADOPT_RECONCILE,
  NOTICE.ADOPT_NOT_FEASIBLE,
  NOTICE.CASE_RECONCILE,
  NOTICE.OUTREACH_NONE,
  // 停止は「できませんでした」でも「実行しました」でもない。行き先が未確定。
  NOTICE.STOP_DEFERRED,
  NOTICE.STOP_RECONCILE,
  NOTICE.STOP_COMMITTED,
  // 引き継ぎは成功ではない。欠勤枠が埋まらないまま自動調整を終えた。
  NOTICE.STOP_HANDED_OFF,
  NOTICE.STOP_CONFLICT,
];

const BAD: readonly NoticeCode[] = [
  NOTICE.ADOPT_REJECTED,
  NOTICE.ADOPT_NOT_IMPLEMENTED,
  NOTICE.ADOPT_STOPPED,
  NOTICE.ADOPT_DEADLINE,
  NOTICE.ADOPT_CONFLICT,
  NOTICE.CASE_CONFLICT,
  NOTICE.CASE_INVALID,
  NOTICE.CASE_OUT_OF_SCOPE,
  NOTICE.OUTREACH_CONFLICT,
  NOTICE.OUTREACH_STOPPED,
  NOTICE.OUTREACH_DEADLINE,
  NOTICE.REPLY_TOO_LONG,
  NOTICE.INPUT_MISSING,
  NOTICE.STOP_ALREADY,
  NOTICE.STOP_NOT_ALLOWED,
  NOTICE.FAILED,
];

/**
 * 既知の通知コードか。
 *
 * **`value in TEXT` にしない。** `in` は prototype chain を見るため、`toString` や
 * `__proto__` が「既知のコード」として通る。`/manager?n=toString` で緑の成功バッジと
 * `[object Object]` が出たり、描画が落ちたりする。URLから任意の表示を作らせない
 * （ADR-024）ための照合なので、自身のキーだけを見る。
 */
const KNOWN: ReadonlySet<string> = new Set(Object.values(NOTICE));

function isNoticeCode(value: string): value is NoticeCode {
  return KNOWN.has(value);
}

export function Notice({ code, count }: { code?: string; count?: string }) {
  if (!code || !isNoticeCode(code)) return null;
  // 数値以外は表示しない。URLから任意の文字列を出せないようにする。
  const parsed = count && /^\d{1,4}$/.test(count) ? Number(count) : undefined;
  const [tone, label] = BAD.includes(code)
    ? (["tag-bad", "できませんでした"] as const)
    : WARN.includes(code)
      ? (["tag-warn", "確認してください"] as const)
      : (["tag-ok", "実行しました"] as const);
  return (
    <div className="notice">
      <span className={`tag ${tone}`}>{label}</span> {TEXT[code](parsed)}
    </div>
  );
}
