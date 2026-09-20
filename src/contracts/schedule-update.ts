/**
 * ScheduleUpdate（選定を勤務表へ反映する操作）の状態と、Gatewayが返す結果種別。
 *
 * 出典：RFC-010 §6・§7、ADR-016、ADR-019。
 *
 * 重要な区別：
 *   - 作業用CSVの作成（PREPARED）と正式採用（ADOPTED）は別。
 *   - 成否不明（UNKNOWN）を成功にも確定失敗にも畳まない（AGENTS.md）。
 *   - EXPORTED_ONLY は「変更案の出力」であり、勤務確定ではない（RFC-012 §4末尾）。
 */

import { z } from "zod";

export const SCHEDULE_UPDATE_STATES = [
  /** 作業用成果物を作っている。 */
  "PREPARING",
  /** 作業用成果物を保存し、読戻し検査を通した。まだ正式勤務ではない。 */
  "PREPARED",
  /** 正式版参照を切り替え、内部状態と併せて一括採用した。 */
  "ADOPTED",
  /** 結果が照合できない。人の対応が必要。未確定と断定して終端へ落とさない。 */
  "RECONCILE_REQUIRED",
  /** 前提が変わったため採用しなかった。成果物は未採用として保持する。 */
  "REJECTED",
] as const;

export type ScheduleUpdateState = (typeof SCHEDULE_UPDATE_STATES)[number];
export const scheduleUpdateStateSchema = z.enum(SCHEDULE_UPDATE_STATES);

/**
 * 許可する遷移。
 *
 * `RECONCILE_REQUIRED -> REJECTED` を許さない。照合できない更新を「不採用」へ
 * 落とすと、確定済みかもしれない事実が未確定へ戻る（RFC-010 §7「旧版や未確定へ
 * 自動復帰しない」、D09）。照合して ADOPTED か REJECTED を確定させる。
 */
export const ALLOWED_SCHEDULE_UPDATE_TRANSITIONS: Readonly<
  Record<ScheduleUpdateState, readonly ScheduleUpdateState[]>
> = {
  PREPARING: ["PREPARED", "REJECTED", "RECONCILE_REQUIRED"],
  PREPARED: ["ADOPTED", "REJECTED", "RECONCILE_REQUIRED"],
  RECONCILE_REQUIRED: ["ADOPTED"],
  ADOPTED: [],
  REJECTED: [],
};

export function isAllowedScheduleUpdateTransition(
  from: ScheduleUpdateState,
  to: ScheduleUpdateState,
): boolean {
  return ALLOWED_SCHEDULE_UPDATE_TRANSITIONS[from].includes(to);
}

/**
 * ScheduleGateway.applyUpdate が返す結果種別（RFC-010 §6）。
 *
 * adapter は成果物の状態までを返す。ADOPTED を判定するのはアプリケーション
 * サービス側で、ScheduleUpdate と正式版参照を照合して決める。
 */
export const UPDATE_RESULT_KINDS = [
  /** 検査済みの作業用成果物ができた。CSV adapter の正常終了。正式採用済みではない。 */
  "PREPARED",
  /** 外部原本へ反映された（将来のSaaS）。内部同期・通知の完了は意味しない。 */
  "APPLIED",
  /** 反映していない。 */
  "NOT_APPLIED",
  /** 期待版と一致しない。 */
  "CONFLICT",
  /** 一部だけ反映された可能性がある。CSVと同じ一括保証を主張しない。 */
  "PARTIAL",
  /** 成否不明。空の成功結果へ変換しない（RFC-010 §6）。 */
  "UNKNOWN",
  /** 出力のみモード。元原本には未反映。勤務確定済みと表示しない。 */
  "EXPORTED_ONLY",
] as const;

export type UpdateResultKind = (typeof UPDATE_RESULT_KINDS)[number];
export const updateResultKindSchema = z.enum(UPDATE_RESULT_KINDS);

/** 成否不明を含むかどうか。再実行の可否判断に使う。 */
export function isOutcomeUnknown(kind: UpdateResultKind): boolean {
  return kind === "UNKNOWN" || kind === "PARTIAL";
}
