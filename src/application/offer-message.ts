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
