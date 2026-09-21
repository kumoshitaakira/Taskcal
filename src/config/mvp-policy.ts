/**
 * MVPの範囲と上限（Q02〜Q06、Q10で2026-09-21に確定）。
 *
 * 確定内容と条件は `docs/OPEN-QUESTIONS.md` の「確定した選択」にある。
 * ここを変えるだけで範囲を広げない。受入期待値（A09・A16・A17）が連動する。
 */

/** Q10：架空店舗のスタッフ数の上限。 */
export const MAX_STAFF = 8;

/** Q10：時間の刻み（分）。これで割り切れない区間は拒否する。 */
export const TIME_GRANULARITY_MINUTES = 15;

/** Q10：1件の代替勤務の最長時間（分）。 */
export const MAX_ADDITIONAL_SHIFT_MINUTES = 4 * 60;

/**
 * Q02：必要人数の意味。各区間ちょうど1人。
 *
 * 重複する計画は採用しない。ただし、ある組合せが不成立でも案件全体を終了しない。
 * 他の合法な組合せや返信待ちの候補があるなら調整を続ける（A16、A11）。
 */
export const COVERAGE_MODE = "EXACTLY_ONE" as const;

/**
 * Q03：分断された空き時間は範囲外。
 * 中間の勤務済み時間を埋めて一つの区間へ戻さない。OUT_OF_SCOPE で拒否する（A17）。
 */
export const ALLOW_SPLIT_AVAILABILITY = false;

/**
 * Q04：元勤務の部分欠勤は範囲外。全時間欠勤のみ扱う。
 * 今回は追加しない（Day 2終了後の機能追加も行わない）。
 */
export const ALLOW_PARTIAL_ABSENCE = false;

/** Q05：日跨ぎは範囲外。明示的に拒否する。黙って同一営業日へ丸めない。 */
export const ALLOW_OVERNIGHT_SHIFT = false;

/**
 * Q06：月次上限は、完了済みを含む予定区間で数える「月次**割当**上限」。
 *
 * 実労働時間の上限判定ではない（勤怠実績を取得していない）。UIでそう呼ばない。
 * 取消と欠勤区間は除く。completedになっただけで枠を復活させない。
 * 検査には対象月の入力の完全性が必要。欠けた日を0と推定しない（A09）。
 */
export const MONTHLY_CAP_BASIS = "PLANNED_INCLUDING_COMPLETED" as const;

/**
 * Q07：業務完了の境界。正式採用・読戻し・必要通知の受付まで。
 * 非選定通知と募集終了通知も対象に含める。
 */
export const COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED = true;

/**
 * Q10／RFC-004 §7：1呼出しの入力長の上限（文字）。
 * 超える返信は呼出さずに拒否する。見積りを超える費用になり得るため。
 */
export const MAX_REPLY_CHARS = 1_000;

/** Q10／RFC-004 §7：1呼出しの出力トークン上限。要求にも含める。 */
export const MAX_OUTPUT_TOKENS = 512;
