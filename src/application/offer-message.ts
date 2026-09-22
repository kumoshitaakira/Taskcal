/**
 * 打診メッセージの本文（RFC-011 §3）。
 *
 * 打診には、店舗・日付・職種・提示時間・最大追加勤務時間・期限と、
 * 「回答した条件で選定されれば確定する」「未選定なら勤務は決まらない」を示す。
 * 単なる勤務可能時間の調査と、自動確定への同意を混同させないため。
 *
 * 本文は決定的に組む。同じ入力から同じ本文にならないと、内容ハッシュが変わって
 * 再試行が別内容と判定される（ADR-006）。
 */

import { MAX_ADDITIONAL_SHIFT_MINUTES } from "../config/mvp-policy";

export interface OfferContext {
  readonly storeName: string;
  readonly roleLabel: string;
  readonly timeZone: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly deadlineAt: string;
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(iso));
}

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function buildOfferBody(context: OfferContext): string {
  const date = formatDate(context.startAt, context.timeZone);
  const from = formatTime(context.startAt, context.timeZone);
  const to = formatTime(context.endAt, context.timeZone);
  const deadlineDate = formatDate(context.deadlineAt, context.timeZone);
  const deadlineTime = formatTime(context.deadlineAt, context.timeZone);
  const maxHours = MAX_ADDITIONAL_SHIFT_MINUTES / 60;

  return [
    `${context.storeName}から代替勤務のお願いです。`,
    `${date} ${from}〜${to}（${context.roleLabel}）`,
    `追加でお願いできるのは最長${maxHours}時間です。`,
    `回答期限：${deadlineDate} ${deadlineTime}`,
    "",
    "入れる時間をそのまま返信してください。全時間入れる場合は「大丈夫です」で構いません。",
    "回答いただいた条件で選定された場合、その内容で勤務が確定します。",
    "選定されなかった場合は勤務は決まりません。結果は改めてご連絡します。",
  ].join("\n");
}

/**
 * 追加確認の本文（RFC-011 §3、Q09）。
 *
 * 条件が一意に決まらない返信には確認を返す。**自己申告のconfidenceを同意の証拠に
 * しない**ため、曖昧なまま承諾へ進めず、必ずここを通す。
 *
 * 未解決の条件はモデルの出力だが、**そのまま貼らない**。原文や推論をそのまま
 * 画面・メッセージへ出さない方針（ADR-008）に合わせ、定型文で尋ねる。
 */
export function buildClarificationBody(context: OfferContext): string {
  const from = formatTime(context.startAt, context.timeZone);
  const to = formatTime(context.endAt, context.timeZone);
  const deadlineDate = formatDate(context.deadlineAt, context.timeZone);
  const deadlineTime = formatTime(context.deadlineAt, context.timeZone);

  return [
    "ご返信ありがとうございます。時間を確定できなかったため、確認させてください。",
    `対象は ${from}〜${to} の範囲です。`,
    "入れる開始時刻と終了時刻を、続けて書いた形で返信してください（例：19:00〜22:00）。",
    "難しい場合は「今回は難しいです」とご返信ください。",
    `回答期限：${deadlineDate} ${deadlineTime}`,
  ].join("\n");
}

/**
 * 確定通知の本文（RFC-010 §4 手順6、Q07）。
 *
 * **正式採用が成立した後にだけ積む。** 作業用CSVができた段階（`PREPARED`）で
 * 送ると、採用していない勤務を確定として伝えることになる（RFC-010 §6）。
 *
 * 区間は承諾した本人の確定区間で、必要枠そのものとは限らない。
 */
export function buildConfirmationBody(context: OfferContext): string {
  const date = formatDate(context.startAt, context.timeZone);
  const from = formatTime(context.startAt, context.timeZone);
  const to = formatTime(context.endAt, context.timeZone);

  return [
    `${context.storeName}の代替勤務が確定しました。`,
    `${date} ${from}〜${to}（${context.roleLabel}）`,
    "勤務表へ反映済みです。変更が必要な場合は店舗へ直接ご連絡ください。",
  ].join("\n");
}

/**
 * 非選定通知の本文（Q07）。
 *
 * **辞退理由を尋ねない。** 次回の打診に影響しないことを明記する——過去の辞退や
 * 非選定を候補順位の減点に使わない方針（AGENTS.md）を、相手にも伝えるため。
 */
export function buildNotSelectedBody(context: OfferContext): string {
  const date = formatDate(context.startAt, context.timeZone);

  return [
    `${context.storeName}からのご連絡です。`,
    `${date} の代替勤務は、今回は別の方で確定しました。`,
    "ご回答ありがとうございました。今回の結果は次回の打診に影響しません。",
  ].join("\n");
}

/**
 * 募集終了通知の本文（Q07）。
 *
 * 返信が無かった相手・確定しなかった相手にも、募集が終わったことを伝える。
 * 待たせたままにしないため、完了境界に含める（`COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED`）。
 */
export function buildCaseClosedBody(context: OfferContext): string {
  const date = formatDate(context.startAt, context.timeZone);

  return [
    `${context.storeName}からのご連絡です。`,
    `${date} の代替勤務の募集は終了しました。`,
    "ご確認ありがとうございました。",
  ].join("\n");
}
