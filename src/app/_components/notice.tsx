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
  REPLY_RECORDED: (seq) => `返信を受け取りました（受信順 ${seq ?? "-"}）。`,
  REPLY_DUPLICATE: () => "同じ返信をすでに受け取っています。",
  REPLY_UNMATCHED: () =>
    "受信は記録しましたが、打診の宛先と一致しないため承諾には使いません（A15）。",
  REPLY_TOO_LONG: () => "返信が長すぎます。",
  INPUT_MISSING: () => "入力が足りません。",
  FAILED: () => "処理に失敗しました。ログを確認してください。",
};

const BAD: readonly NoticeCode[] = [
  NOTICE.CASE_CONFLICT,
  NOTICE.CASE_INVALID,
  NOTICE.CASE_OUT_OF_SCOPE,
  NOTICE.OUTREACH_CONFLICT,
  NOTICE.OUTREACH_STOPPED,
  NOTICE.OUTREACH_DEADLINE,
  NOTICE.REPLY_TOO_LONG,
  NOTICE.INPUT_MISSING,
  NOTICE.FAILED,
];

function isNoticeCode(value: string): value is NoticeCode {
  return value in TEXT;
}

export function Notice({ code, count }: { code?: string; count?: string }) {
  if (!code || !isNoticeCode(code)) return null;
  // 数値以外は表示しない。URLから任意の文字列を出せないようにする。
  const parsed = count && /^\d{1,4}$/.test(count) ? Number(count) : undefined;
  const tone = BAD.includes(code) ? "tag-bad" : "tag-ok";
  return (
    <div className="notice">
      <span className={`tag ${tone}`}>
        {BAD.includes(code) ? "できませんでした" : "実行しました"}
      </span>{" "}
      {TEXT[code](parsed)}
    </div>
  );
}
