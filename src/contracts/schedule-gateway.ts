/**
 * 勤務表の連携契約（interfaceのみ）。
 *
 * 出典：RFC-010 §6、ADR-019。実装：CSV adapter は `src/adapters/csv/`（担当B）。
 *
 * 方針：
 *   - ドメインから接続方式を分ける。adapter が案件・選定・同意の保存先を自由に
 *     たどって実行内容を組み立てない。検査済みの内容をコマンドで渡す。
 *   - 「版を読める」と「期待版を指定した更新ができる」を別の能力として扱う。
 */

import type { OperationId, OperationRef, RequestHash } from "./operation";
import type { UpdateResultKind } from "./schedule-update";

/**
 * 外部版の識別子。
 * 任意の取込番号だけでは内容の変更を検出できないため、内容hashまたは不変の
 * 管理版IDを使う（RFC-010 §3）。
 */
export type SourceRevision = string;

/** 勤務表そのものの内部ID（店舗・営業日に対応）。 */
export type ScheduleId = string;

/** 安定した勤務ID。行番号・表示名・内容hashを恒久IDにしない（RFC-010 §3）。 */
export type ShiftAssignmentId = string;

/**
 * 接続範囲。どの出力先・取得元かを識別する。
 *
 * **4つの操作すべてに持たせる。** 片方だけ落とすと、出力先を切り替えた再試行を
 * 別要求として検出できず、別接続への二重作用や照会不能が起きる
 * （`getUpdateResult` が接続範囲必須なのに `applyUpdate` が持たない状態だった）。
 */
export type ConnectionId = string;

export interface SourceCapabilities {
  /** 現在の版を読めるか。 */
  readonly canReadRevision: boolean;
  /** 更新時に期待版を検査させられるか。読めることと同じではない。 */
  readonly canConditionalUpdate: boolean;
  /** 同じ操作IDで二重適用を防げるか。 */
  readonly supportsIdempotencyKey: boolean;
  /** 実行済み操作の結果を後から照会できるか。 */
  readonly supportsResultLookup: boolean;
  /** 複数勤務を一括適用できるか。できなければ同じ確定保証を主張しない。 */
  readonly supportsAtomicBatch: boolean;
}

export interface LoadedSchedule {
  readonly scheduleId: ScheduleId;
  readonly sourceRevision: SourceRevision;
  /**
   * 取得を試みた範囲。半開区間 `[fromDate, toDate)`（日付はYYYY-MM-DD）。
   * この範囲に穴が無いことは意味しない。完全性は `completeness` で判断する。
   */
  readonly requestedRange: { readonly fromDate: string; readonly toDate: string };
  /**
   * 範囲内の入力が揃っているか（RFC-010 §6「対象範囲・取得可否」）。
   * 月次上限の検査は COMPLETE のときだけ成立する。取得できていない日を
   * 0と推定しない（RFC-009 §5、A09、D08）。
   */
  readonly completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  /** INCOMPLETE のとき、取得できなかった営業日。 */
  readonly missingDates: readonly string[];
  readonly assignments: readonly LoadedAssignment[];
}

/**
 * 勤務の状態。自由文字列にしない。
 * CSV adapter（B）、月次計算（B）、正式採用（A）で語彙が食い違うと、
 * 月次集計が黙って狂う（RFC-009 §5、A09）。未知の値は OUT_OF_SCOPE で拒否する。
 */
export const ASSIGNMENT_STATUSES = [
  /** 予定。月次上限に数える。 */
  "SCHEDULED",
  /** 完了済み。予定区間として月次上限に数える（Q06）。枠を復活させない。 */
  "COMPLETED",
  /** 取消済み。勤務自体が無くなった。月次上限から除く。 */
  "CANCELLED",
  /**
   * 欠勤。**取消とは別**。
   *
   * 勤務の枠は残っていて代替を探す対象だが、本人はその時間に働かない。
   * 月次上限からは欠勤区間を除く（RFC-009 §5「取消と欠勤区間を除く」、A09）。
   *
   * Q04により対象は**全時間欠勤のみ**。部分欠勤は範囲外なので、この状態は
   * 勤務全体に対して付く。区間の一部だけを欠勤にしない。
   *
   * 書込み側の `PlannedAbsence` と往復する。CSVへ書いた欠勤を読み戻したとき、
   * この状態として再現できなければ、再読込後に月次集計が狂う。
   */
  "ABSENT",
] as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export interface LoadedAssignment {
  readonly shiftAssignmentId: ShiftAssignmentId;
  readonly staffId: string;
  readonly roleCode: string;
  /** 半開区間 [start, end)。ISO 8601。 */
  readonly startAt: string;
  readonly endAt: string;
  readonly status: AssignmentStatus;
  /** 代替勤務の場合の生成元。通常勤務は undefined（RFC-009 §4）。 */
  readonly sourceCaseId?: string;
}

/** adapter へ渡す、検査済みで固定された更新内容。 */
export interface ApplyUpdateCommand {
  readonly operation: OperationRef;
  /**
   * 出力先の接続範囲。**`requestHash` の対象にも含めること。**
   * 同じ操作ID・同じ勤務内容のまま接続だけ切り替えた再試行を、別要求として
   * 検出するため（`getUpdateResult` と対になる）。
   */
  readonly connectionId: ConnectionId;
  readonly scheduleId: ScheduleId;
  /**
   * 期待する外部版。一致しなければ CONFLICT。
   * `capabilities.canConditionalUpdate` が false の接続では検査されない。
   * その場合、呼出し側が店舗単位の直列化で代替する（RFC-010 §5）。
   */
  readonly expectedSourceRevision: SourceRevision;
  /**
   * **`shiftAssignmentId` の昇順で渡すこと。**
   * requestHash は配列順を内容の違いとして扱うため、CSVの行順のまま渡すと
   * 並べ替え後の再試行が別内容と判定される（A06 / `operation.ts`）。
   */
  readonly additions: readonly PlannedAssignment[];
  /** 同上。`shiftAssignmentId` の昇順で渡すこと。 */
  readonly absences: readonly PlannedAbsence[];
}

export interface PlannedAssignment {
  /** 再試行で作り直さない、あらかじめ決めた勤務ID（RFC-010 §3）。 */
  readonly shiftAssignmentId: ShiftAssignmentId;
  /** 由来の承諾。UpdateResult で対応を追跡する。 */
  readonly commitmentId: string;
  readonly staffId: string;
  readonly roleCode: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly sourceCaseId: string;
}

/**
 * 欠勤にする勤務。
 *
 * 読み戻すと `LoadedAssignment.status === "ABSENT"` として現れる必要がある
 * （往復性）。Q04により全時間欠勤のみを扱うため、区間は元勤務と一致する。
 */
export interface PlannedAbsence {
  readonly shiftAssignmentId: ShiftAssignmentId;
  readonly startAt: string;
  readonly endAt: string;
}

export interface UpdateResult {
  readonly operation: OperationRef;
  readonly kind: UpdateResultKind;
  /** 更新後の成果物参照（CSVならファイルパス等）。 */
  readonly artifactRef?: string;
  readonly newSourceRevision?: SourceRevision;
  /** 期待版が実際に検査されたか。検査していない接続で CONFLICT を期待しない。 */
  readonly revisionCheckEnforced: boolean;
  /**
   * 取得できた対応関係のみを入れる。
   * 取得できなかった項目を、空の成功結果として返さない（RFC-010 §6）。
   */
  readonly mappings: readonly {
    readonly commitmentId: string;
    readonly shiftAssignmentId: ShiftAssignmentId;
    readonly externalAssignmentId?: string;
  }[];
  /** 表示用の短い理由。原文や秘密値を入れない。 */
  readonly detail?: string;
}

export interface ReadBackResult {
  readonly artifactRef: string;
  readonly sourceRevision: SourceRevision;
  readonly assignments: readonly LoadedAssignment[];
}

/**
 * 勤務表の連携先。
 *
 * **例外（reject）の意味：成否不明。** タイムアウト・接続断・プロセス停止で
 * reject した場合、それは `NOT_APPLIED` や失敗と等価ではない。RFC-010 §7 の
 * 「正式採用直後の応答喪失＝呼出し元からは不明」に該当する。
 * reject 後は `getUpdateResult` で照合するまで再実行しない（A03、D09、AGENTS.md）。
 * 可能な実装は例外を投げず `kind: "UNKNOWN"` を返すこと。
 *
 * **例外はふたつだけある。** `TaskcalError` の `NOT_IMPLEMENTED` と `NOT_CONFIGURED` は
 * 「adapter が外部作用の**前に**断った」を意味し、外部作用は起きていない。これを
 * 成否不明として扱うと、まだ何も繋がっていない案件が全て照合待ちになり、本当の
 * 結果不明と区別できなくなる。この2つ以外の例外は成否不明として扱う。
 * adapter はこの2つを、外部へ要求を出す前にだけ投げること。
 */
export interface ScheduleGateway {
  readonly capabilities: SourceCapabilities;
  /**
   * 勤務表を読む。
   *
   * **正式版参照を指定して読む**（RFC-010 §2「全ての照会・再起動・次案件は
   * 正式版参照から始める」）。`scheduleId` は R1 から R2 へ切り替えた後も
   * 同じなので、それだけを渡すと adapter が初期設定のR1を読み続けても
   * 契約上検出できない（A01、D11）。
   *
   * `authoritative` を省略できるのは、まだ一度も正式採用していない初回取込みの
   * ときだけ。以後は必ず渡す。
   */
  loadSchedule(ref: {
    connectionId: ConnectionId;
    scheduleId: ScheduleId;
    authoritative?: AuthoritativeScheduleRef;
  }): Promise<LoadedSchedule>;
  applyUpdate(command: ApplyUpdateCommand): Promise<UpdateResult>;
  /**
   * 実行済み操作の結果照会。結果不明の外部作用を、照会も照合もせずに
   * 再実行しない（AGENTS.md）。
   *
   * 接続範囲を含めて照会する（RFC-010 §6）。出力先を切り替えた後に同じIDで
   * 照会して、別接続の結果を拾わないため。
   */
  getUpdateResult(ref: {
    operationId: OperationId;
    connectionId: string;
    /**
     * 期待する内容のハッシュ。渡した場合、adapter側でも照合して不一致なら
     * `"CONFLICT"` を返す。IDを誤って再利用したときに、内容の違う古い結果を
     * 今の操作へ結び付けないため（MessagingGateway.getSendResult と同じ）。
     */
    expectedRequestHash?: RequestHash;
  }): Promise<UpdateResult | "LOOKUP_UNAVAILABLE" | "CONFLICT">;
  readBack(ref: { connectionId: ConnectionId; artifactRef: string }): Promise<ReadBackResult>;
}

/**
 * `ApplyUpdateCommand.operation.requestHash` に含める内容。
 * ここに無いものを変えても、同じ操作IDでの再試行として通ってしまう。
 */
export interface ApplyUpdatePayloadForHash {
  readonly connectionId: ConnectionId;
  readonly scheduleId: ScheduleId;
  readonly expectedSourceRevision: SourceRevision;
  readonly additions: readonly PlannedAssignment[];
  readonly absences: readonly PlannedAbsence[];
}

/**
 * 正式版参照：現在有効な管理版を指すメタデータ（RFC-010 §2）。
 * 全ての照会・再起動・次案件はここから始める（D11、A01）。
 */
export interface AuthoritativeScheduleRef {
  readonly scheduleId: ScheduleId;
  readonly sourceRevision: SourceRevision;
  readonly artifactRef: string;
  readonly adoptedAt: string;
}
