/**
 * 永続化の口。
 *
 * 出典：RFC-010 §4 手順6、RFC-011 §4、ADR-006、RFC-009 D05・D06・D07。
 *
 * **全ての操作が取引ハンドルを取る。** repository が自分で取引を開くと、正式採用の
 * 一括保存（正式版参照・内部勤務表・採用済み計画・案件の確定事実・操作結果・通知待ちを
 * 同じ取引で保存する）が黙って複数の取引へ割れ、一部だけが正式勤務として残る（D06）。
 * 取引境界は `src/application/` が決める。
 */

import type { AdoptionFact, CaseState, Handoff, StopCause } from "./case-state";
import type { ErrorCode } from "./errors";
import type { Commitment, CommitmentStatus } from "./commitment";
import type { ContactEndpointRef, InboundEvent, PersistedInboundEvent } from "./messaging-gateway";
import type { PersistedReplyInterpretation } from "./model-output";
import type { OperationId, OperationMatch, OperationRef } from "./operation";
import type { OutreachMessageKind, OutreachState, SenderIdentity } from "./outreach-state";
import type {
  AuthoritativeScheduleRef,
  ConnectionId,
  ScheduleId,
  ShiftAssignmentId,
  SourceRevision,
} from "./schedule-gateway";
import type { ScheduleUpdateState, UpdateResultKind } from "./schedule-update";
import type { SelectionResult } from "./selection";

/**
 * 取引ハンドル。
 *
 * `src/contracts/` は `pg` に依存しない。実体は `src/adapters/db/transaction.ts` の
 * `Tx`（`PoolClient`）で、`withTransaction` が渡す。
 */
export type TxHandle = object;

/** 現在時刻の口。テストで固定するため、`new Date()` を直接呼ばない。 */
export interface Clock {
  now(): string;
}

/** ID採番の口。テストで固定するため、`randomUUID()` を直接呼ばない。 */
export interface IdGenerator {
  next(): string;
}

// ---------------------------------------------------------------------------
// 案件
// ---------------------------------------------------------------------------

export interface CaseSnapshot {
  readonly caseId: string;
  readonly storeId: string;
  readonly connectionId: ConnectionId;
  readonly scheduleId: ScheduleId;
  readonly businessDate: string;
  readonly absentShiftAssignmentId: ShiftAssignmentId;
  readonly absentStaffId: string;
  readonly roleCode: string;
  readonly requiredStartAt: string;
  readonly requiredEndAt: string;
  readonly deadlineAt: string;
  readonly state: CaseState;
  /** 楽観ロック用。読んだ版と一致する場合だけ更新する（D08）。 */
  readonly version: number;
  /** ADR-022：案件状態と別に持つ。状態から採用可否を推定しない。 */
  readonly adoptionFact: AdoptionFact;
  readonly handoff?: Handoff;
  readonly stopCause?: StopCause;
  readonly stoppedAt?: string;
  readonly runId: string;
  readonly createdAt: string;
}

export interface CreateCaseInput {
  readonly caseId: string;
  readonly storeId: string;
  readonly connectionId: ConnectionId;
  readonly scheduleId: ScheduleId;
  readonly businessDate: string;
  readonly absentShiftAssignmentId: ShiftAssignmentId;
  readonly absentStaffId: string;
  readonly roleCode: string;
  readonly requiredStartAt: string;
  readonly requiredEndAt: string;
  readonly deadlineAt: string;
  readonly runId: string;
}

export interface AbsenceCaseRepository {
  /**
   * 案件行を排他ロックして読む。ADR-006 のロック順（store → case → staff）に従う。
   * 受信順の採番と正式採用が同じ排他規則を共有する（RFC-011 §4）。
   */
  lockForUpdate(tx: TxHandle, caseId: string): Promise<CaseSnapshot | "NOT_FOUND">;
  findById(tx: TxHandle, caseId: string): Promise<CaseSnapshot | "NOT_FOUND">;
  /** 稼働中の案件を一覧する。MVPは同時1案件（RFC-009 §2）。 */
  listActive(tx: TxHandle, storeId: string): Promise<readonly CaseSnapshot[]>;
  /** D02：同じ欠勤区間の稼働中案件があれば `DUPLICATE_ACTIVE_CASE`。 */
  create(tx: TxHandle, input: CreateCaseInput): Promise<CaseSnapshot | "DUPLICATE_ACTIVE_CASE">;
  /**
   * `isAllowedCaseTransition` を通したうえで、期待版と一致する場合だけ更新する。
   * 採用事実・引き継ぎ理由は状態と同時に記録する（ADR-022）。
   */
  applyTransition(
    tx: TxHandle,
    input: {
      caseId: string;
      expectedVersion: number;
      to: CaseState;
      adoptionFact?: AdoptionFact;
      handoff?: Handoff;
      stop?: { cause: StopCause; at: string };
    },
  ): Promise<"UPDATED" | "VERSION_CONFLICT">;
  /**
   * 状態を動かさずに停止印だけ記録する（Q13 / ADR-022）。
   *
   * `PREPARING` 中に期限・上限へ達しても、**期限を検知しただけで引き継がない**。
   * 並行する正式採用の結果を先に確定させる必要があるため、停止の事実だけを先に
   * 確定させ、行き先は `resolvePreparingStop` を通して後から決める。
   *
   * 版は進める。進めないと、並行する正式採用が「案件は変わっていない」と読んで
   * 直前再検査を素通りする（D08）。
   *
   * 停止は書き直さない。二度目は `ALREADY_STOPPED` を返し、理由を上書きしない。
   */
  recordStop(
    tx: TxHandle,
    input: {
      caseId: string;
      expectedVersion: number;
      stop: { cause: StopCause; at: string };
    },
  ): Promise<"UPDATED" | "VERSION_CONFLICT" | "ALREADY_STOPPED">;
  /** 追記履歴。現在状態の正本ではない（RFC-009 §3）。 */
  recordEvent(
    tx: TxHandle,
    input: { caseId: string; kind: string; detail?: Record<string, unknown> },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// 打診
// ---------------------------------------------------------------------------

export interface OutreachSnapshot {
  readonly outreachId: string;
  readonly caseId: string;
  readonly staffId: string;
  /** 打診時点で固定した宛先。途中の宛先変更で旧打診を別人へ送らない（RFC-011 §6）。 */
  readonly endpoint: ContactEndpointRef;
  readonly offeredStartAt: string;
  readonly offeredEndAt: string;
  readonly state: OutreachState;
  readonly version: number;
  /** A12：この打診について解釈を適用した最後の受信順。 */
  readonly lastAppliedSeq: number;
  /** モデルへ渡す匿名の参照。実名・連絡先をプロンプトへ入れない（ADR-008）。 */
  readonly anonymousStaffRef: string;
  readonly createdAt: string;
}

export interface CreateOutreachInput {
  readonly outreachId: string;
  readonly caseId: string;
  readonly staffId: string;
  readonly endpoint: ContactEndpointRef;
  readonly offeredStartAt: string;
  readonly offeredEndAt: string;
  readonly anonymousStaffRef: string;
}

export interface OutreachRepository {
  create(tx: TxHandle, input: CreateOutreachInput): Promise<OutreachSnapshot>;
  listByCase(tx: TxHandle, caseId: string): Promise<readonly OutreachSnapshot[]>;
  findById(tx: TxHandle, outreachId: string): Promise<OutreachSnapshot | "NOT_FOUND">;
  /**
   * 返信対象の送信Messageから打診を引く（RFC-011 §3）。
   *
   * **宛先からの逆引きは用意しない。** 同じ相手へ過去の案件でも打診していると、
   * どの打診への返信か決められない。対象を特定できない返信は本人と確認できない
   * ものとして扱う。
   */
  findByRepliedMessage(tx: TxHandle, messageId: string): Promise<OutreachSnapshot | "NOT_FOUND">;
  /** `isAllowedOutreachTransition` を通したうえで、期待版と一致する場合だけ更新する。 */
  applyTransition(
    tx: TxHandle,
    input: { outreachId: string; expectedVersion: number; to: OutreachState },
  ): Promise<"UPDATED" | "VERSION_CONFLICT">;
}

// ---------------------------------------------------------------------------
// 受信と解釈
// ---------------------------------------------------------------------------

/**
 * 保存した受信イベント。
 *
 * 案件へ結び付かなかった受信は `caseId` も `receivedSeq` も持たない。
 * `PersistedInboundEvent` は両方を必須にしているため、別の分岐で表す。
 * **結び付かない受信も捨てない**（本人と確認できない返信の記録が要る：A15）。
 */
export type PersistInboundResult =
  | {
      /**
       * D07：同じ `eventId` で内容が異なる。保存済みの事実と食い違う結果を返さない。
       * 受信していないので、案件も受信順も動かさない。
       */
      readonly match: "CONFLICT";
    }
  | {
      readonly linked: true;
      readonly match: "NEW" | "DUPLICATE";
      readonly stored: PersistedInboundEvent;
      readonly inboundEventId: string;
      /** 案件へ結び付いた受信は不変のMessageとしても残す（RFC-009 §3）。 */
      readonly messageId: string;
    }
  | {
      readonly linked: false;
      readonly match: "NEW" | "DUPLICATE";
      readonly inboundEventId: string;
      readonly senderIdentity: SenderIdentity;
    };

/** 店舗の文脈。表示と月境界は `timezone` に従う（RFC-009 §5）。 */
export interface StoreSnapshot {
  readonly storeId: string;
  readonly name: string;
  readonly timezone: string;
  /** MVPは職種1種類（RFC-009 §2）。 */
  readonly roleCode: string;
}

export interface StoreRepository {
  findById(tx: TxHandle, storeId: string): Promise<StoreSnapshot | "NOT_FOUND">;
}

/**
 * 保存済みの受信イベントと、そこから決まる参照。
 *
 * use case が `inbound_event` を直接引かなくて済むようにする。決定的なロジックを
 * 永続化の形から切り離し、SQLを触らずに検証できるようにするため。
 */
export interface StoredInboundEvent extends PersistedInboundEvent {
  readonly inboundEventId: string;
  /** 案件へ結び付いた受信が持つ不変のMessage。 */
  readonly messageId: string;
  /** 受信時に確定した打診。宛先から逆引きしない（RFC-011 §3）。 */
  readonly outreachId: string;
}

export interface InboundEventRepository {
  /**
   * 受信イベントを**モデル処理の前に**永続化し、案件内の `receivedSeq` を採番する。
   *
   * 重複排除キーは provider・connectionId の範囲を含める（A15）。案件へ結び付か
   * なかった受信も捨てずに保存する。本文で名乗った staffId を本人とみなさない。
   *
   * 案件へ結び付いた受信は、イベントと Message を同じ取引で保存する。片方だけが
   * 残ると、解釈が参照する Message が無い受信ができる。
   */
  persist(
    tx: TxHandle,
    event: InboundEvent,
    resolved: { caseId?: string; outreachId?: string; senderIdentity: SenderIdentity },
  ): Promise<PersistInboundResult>;
  findById(tx: TxHandle, inboundEventId: string): Promise<StoredInboundEvent | "NOT_FOUND">;
  /** D04：この打診に、まだ解釈を適用していない受信があるか。 */
  hasUnprocessed(tx: TxHandle, outreachId: string): Promise<boolean>;
  /**
   * これ以上自動では進められない受信を、取り出し対象から外す。
   *
   * 「適用していない」（受信順が進んでいない）と「自動では進められない」は別。
   * 前者のまま取り出し続けると、同じ受信を選び直して後続の返信を処理できない。
   */
  markBlocked(tx: TxHandle, input: { inboundEventId: string; reason: ErrorCode }): Promise<void>;
  /** 理由が解消した保留を戻す。戻した件数を返す。 */
  clearBlocked(tx: TxHandle, input: { reason: ErrorCode }): Promise<number>;
  /** 解釈できる最も古い受信。受信順の昇順（RFC-011 §4）。 */
  findNextInterpretable(tx: TxHandle): Promise<string | "NONE">;
}

/** 解釈を案件へ適用したか。古い結果は保存するが適用しない（A12）。 */
export const INTERPRETATION_APPLICATION = {
  APPLIED: "APPLIED",
  /** 遅れて返った古い結果。新しい承諾を過去の状態へ戻さない（A12）。 */
  DISCARDED_STALE: "DISCARDED_STALE",
  /** 決定的検査で承諾にできなかった。返信は無視せず状態へ反映する（Q09）。 */
  REJECTED_BY_CHECK: "REJECTED_BY_CHECK",
} as const;

export type InterpretationApplication =
  (typeof INTERPRETATION_APPLICATION)[keyof typeof INTERPRETATION_APPLICATION];

export interface ReplyInterpretationRepository {
  /**
   * `receivedSeq` と案件版を必ず持つ。A12 の判定材料になる（RFC-011 §4）。
   *
   * **保存された解釈のIDを返す。** 同じ受信を再処理すると同じ `requestId` になり、
   * 行は既にある。呼出し元が今回作ったIDをそのまま承諾から参照すると、存在しない
   * 行を指して外部キー違反になる。承諾は**実際に保存された解釈**を参照する。
   */
  save(
    tx: TxHandle,
    record: PersistedReplyInterpretation,
    applied: InterpretationApplication,
  ): Promise<{ readonly interpretationId: string }>;
  /**
   * A12：この打診に対して、より新しい受信を既に適用していないか。
   * `ADVANCED` のときだけ解釈を適用してよい。
   */
  tryAdvanceAppliedSeq(
    tx: TxHandle,
    input: { outreachId: string; receivedSeq: number },
  ): Promise<"ADVANCED" | "STALE">;
}

// ---------------------------------------------------------------------------
// 承諾
// ---------------------------------------------------------------------------

export interface CreateCommitmentInput {
  readonly commitmentId: string;
  readonly caseId: string;
  readonly staffId: string;
  readonly outreachId: string;
  /** 訂正で上書きせず、旧版のIDをここへ置いて新しい行を作る（RFC-011 §4）。 */
  readonly supersedes?: string;
  readonly roleCode: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly acceptedInterpretationId: string;
  readonly sourceReceivedSeq: number;
}

export interface CommitmentRepository {
  /** 旧版を `SUPERSEDED` にしてから新しい版を作る。版番号はこの中で採番する。 */
  createVersion(tx: TxHandle, input: CreateCommitmentInput): Promise<Commitment>;
  listByCase(tx: TxHandle, caseId: string): Promise<readonly Commitment[]>;
  /** `isAllowedCommitmentTransition` を通す。 */
  changeStatus(
    tx: TxHandle,
    input: { commitmentId: string; to: CommitmentStatus },
  ): Promise<"UPDATED" | "NOT_ALLOWED">;
}

// ---------------------------------------------------------------------------
// 操作結果（冪等性）
// ---------------------------------------------------------------------------

export const OPERATION_KINDS = [
  "CREATE_CASE",
  "START_OUTREACH",
  "SEND_MESSAGE",
  "INTERPRET_REPLY",
  "APPLY_UPDATE",
  "ADOPT_PLAN",
  /** A18：店長停止・期限到達・上限到達。停止も操作IDで冪等にする（ADR-006）。 */
  "STOP_CASE",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = ["IN_PROGRESS", "SUCCEEDED", "REFUSED", "UNKNOWN"] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export interface StoredOperationResult {
  readonly operationId: OperationId;
  readonly status: OperationStatus;
  readonly result: unknown;
}

export interface OperationResultStore {
  /**
   * D07：同じ operationId で内容が異なれば `CONFLICT`。同一内容なら保存済み結果を返す。
   *
   * 外部作用のある操作は接続範囲を持つ。宛先・接続を含めずにハッシュを作ると、
   * 別の接続への送信を同じ操作と誤認する（A15）。
   */
  begin(
    tx: TxHandle,
    input: {
      operation: OperationRef;
      kind: OperationKind;
      connectionId?: ConnectionId;
      caseId?: string;
    },
  ): Promise<{ match: OperationMatch; stored?: StoredOperationResult }>;
  complete(
    tx: TxHandle,
    input: { operationId: OperationId; status: OperationStatus; result: unknown },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// 通知待ち（outbox）
// ---------------------------------------------------------------------------

export const OUTBOX_STATUSES = ["PENDING", "SENT", "FAILED", "UNKNOWN", "REFUSED"] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxItem {
  readonly outboxId: string;
  readonly caseId: string;
  readonly outreachId?: string;
  readonly kind: OutreachMessageKind;
  readonly body: string;
  /** 呼出し元が永続化した安定キー。再試行で作り直さない（ADR-006）。 */
  readonly operation: OperationRef;
  readonly connectionId: ConnectionId;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly leaseToken?: string;
}

export interface OutboxRepository {
  enqueue(
    tx: TxHandle,
    input: Omit<OutboxItem, "status" | "attempts" | "leaseToken">,
  ): Promise<void>;
  /**
   * 送信待ちを1件だけ確保する。
   *
   * **`UNKNOWN` は取り出さない。** 結果不明を失敗として扱わず、`getSendResult` で
   * 照合するまで再送しない（RFC-010 §7、AGENTS.md）。
   */
  claimNext(tx: TxHandle, input: { leaseMs: number }): Promise<OutboxItem | "NONE">;
  /**
   * A13：**結果不明の項目を照合するために**取り出す。送信のための取り出しではない。
   *
   * 呼出し元は `getSendResult` で照合し、送られたと確認できるまで送り直さない。
   * 送信試行ではないので `attempts` は増やさない。`settle` は `claimNext` と共通で、
   * ここで取った lease token をそのまま使う。
   */
  claimForReconcile(tx: TxHandle, input: { leaseMs: number }): Promise<OutboxItem | "NONE">;
  /** 送信結果を記録する。未送信（REFUSED）と配送失敗（FAILED）を同じ欄に畳まない。 */
  settle(
    tx: TxHandle,
    input: {
      outboxId: string;
      leaseToken: string;
      status: OutboxStatus;
      refusal?: string;
      /** 送信したメッセージ。配送状態そのものは message_delivery が持つ。 */
      messageId?: string;
      retryAfterMs?: number;
    },
  ): Promise<"UPDATED" | "LEASE_LOST">;
  listByCase(tx: TxHandle, caseId: string): Promise<readonly OutboxItem[]>;
}

// ---------------------------------------------------------------------------
// 選定結果
// ---------------------------------------------------------------------------

/**
 * 不変の選定結果（RFC-009 §3）。
 *
 * **保存後に書き換えない。** 承諾0件の評価でも残す。書き換えると「なぜその計画を
 * 選んだか」を後から説明できなくなり、正式採用直前の再検査（D08）が照合する相手を失う。
 */
export interface SelectionResultRepository {
  /**
   * 選定結果と、選定・非選定の内訳を保存する。
   *
   * 非選定の承諾も残す。誰に非選定通知を出すかはここから決まる（Q07）。
   * 版は保存時点の承諾行から取る——呼出し元が別に持ち回ると、ロックの外で
   * 読んだ古い版を書き込み得る。
   */
  save(tx: TxHandle, result: SelectionResult): Promise<void>;
  findById(tx: TxHandle, selectionId: string): Promise<SelectionResult | "NOT_FOUND">;
}

// ---------------------------------------------------------------------------
// 勤務表更新
// ---------------------------------------------------------------------------

export interface ScheduleUpdateSnapshot {
  readonly scheduleUpdateId: string;
  readonly caseId: string;
  /**
   * 準備を始めた**後**の案件版。正式採用の直前にこの版と照合する（D08）。
   *
   * `SelectionResult.caseVersion` は検査した時点（`COORDINATING`）の版で、準備開始の
   * 遷移で1つ進む。両方を残さないと、「自分で進めた1つ」と「別の変更で進んだ1つ」を
   * 区別できない（A04・A05）。
   */
  readonly caseVersion: number;
  readonly selectionId: string;
  /** 外部作用（`applyUpdate`）の操作ID。照会はこれで行う（RFC-010 §7）。 */
  readonly operationId: OperationId;
  readonly connectionId: ConnectionId;
  readonly scheduleId: ScheduleId;
  readonly expectedSourceRevision: SourceRevision;
  readonly state: ScheduleUpdateState;
  /** Gatewayが返した結果種別。状態とは別に残す（PREPARED と ADOPTED は別）。 */
  readonly resultKind?: UpdateResultKind;
  readonly artifactRef?: string;
  readonly newSourceRevision?: SourceRevision;
  readonly revisionCheckEnforced: boolean;
  readonly adoptedAt?: string;
  readonly createdAt: string;
}

export interface CreateScheduleUpdateInput {
  readonly scheduleUpdateId: string;
  readonly caseId: string;
  /** 準備開始の遷移を済ませた後の案件版。 */
  readonly caseVersion: number;
  readonly selectionId: string;
  readonly operationId: OperationId;
  readonly connectionId: ConnectionId;
  readonly scheduleId: ScheduleId;
  readonly expectedSourceRevision: SourceRevision;
}

export interface ScheduleUpdateRepository {
  create(tx: TxHandle, input: CreateScheduleUpdateInput): Promise<ScheduleUpdateSnapshot>;
  /**
   * `isAllowedScheduleUpdateTransition` を通したうえで状態を進める。
   *
   * `ADOPTED` は D05 の部分一意索引が最後に拒否する。**別の操作キーでも
   * 1案件に2つ目の採用を作らない**（A04）。拒否は `ALREADY_ADOPTED` で返し、
   * 呼出し元が採用済みの事実として扱えるようにする。
   */
  advance(
    tx: TxHandle,
    input: {
      scheduleUpdateId: string;
      to: ScheduleUpdateState;
      resultKind?: UpdateResultKind;
      artifactRef?: string;
      newSourceRevision?: SourceRevision;
      revisionCheckEnforced?: boolean;
      /**
       * 案件版を動かしたときは、**必ずここへ新しい値を渡す**（D08）。
       *
       * 直前再検査はこの版と案件行を照合する。照合待ちへ入れるなど、この進行自身が
       * 案件版を進めた場合に更新し忘れると、次に再開したとき「別の変更が入った」と
       * 誤判定し、採用できたはずの計画を未採用と断定してしまう（A03）。
       */
      caseVersion?: number;
      /** `ADOPTED` のときだけ必須。DBの制約が対で入ることを要求する。 */
      adoptedAt?: string;
    },
  ): Promise<"UPDATED" | "NOT_ALLOWED" | "ALREADY_ADOPTED">;
  findById(tx: TxHandle, scheduleUpdateId: string): Promise<ScheduleUpdateSnapshot | "NOT_FOUND">;
  /** 操作IDから引く。結果不明の再開で、同じ操作の成果物を探すのに使う（RFC-010 §7）。 */
  findByOperation(
    tx: TxHandle,
    operationId: OperationId,
  ): Promise<ScheduleUpdateSnapshot | "NOT_FOUND">;
  /** 案件の、まだ終端に入っていない更新。再開時の続きを決める。 */
  findOpenByCase(tx: TxHandle, caseId: string): Promise<ScheduleUpdateSnapshot | "NONE">;
}

// ---------------------------------------------------------------------------
// 正式版参照
// ---------------------------------------------------------------------------

export interface AuthoritativeRefSnapshot extends AuthoritativeScheduleRef {
  readonly connectionId: ConnectionId;
  /** A04：期待版付きで切り替えるための版。 */
  readonly version: number;
  readonly adoptedByScheduleUpdateId?: string;
}

export interface AuthoritativeScheduleRefRepository {
  get(
    tx: TxHandle,
    ref: { connectionId: ConnectionId; scheduleId: ScheduleId },
  ): Promise<AuthoritativeRefSnapshot | "NOT_FOUND">;
  /**
   * A04：期待版付きで正式版参照を差し替える。
   *
   * **同じ旧版から作った二つの計画の一方だけを通す。** 期待版と一致しなければ
   * 1行も更新せず `REVISION_CONFLICT` を返す。読んでから書くまでの間に別の採用が
   * 通った場合を、ここで止める（RFC-010 §5）。
   */
  swap(
    tx: TxHandle,
    input: {
      connectionId: ConnectionId;
      scheduleId: ScheduleId;
      expectedVersion: number;
      sourceRevision: SourceRevision;
      artifactRef: string;
      adoptedAt: string;
      adoptedByScheduleUpdateId: string;
    },
  ): Promise<"UPDATED" | "REVISION_CONFLICT">;
}

// ---------------------------------------------------------------------------
// 勤務（内部勤務表への書込み）
// ---------------------------------------------------------------------------

export interface AddAssignmentInput {
  /** 選定時に確定させたID。再試行で採番し直さない（RFC-010 §3、D05）。 */
  readonly shiftAssignmentId: ShiftAssignmentId;
  readonly scheduleId: ScheduleId;
  readonly storeId: string;
  readonly staffId: string;
  readonly roleCode: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly sourceCaseId: string;
  readonly sourceCommitmentId: string;
}

/** 追加できなかった理由。どれも「一部だけ正式勤務にしない」ために区別する（A08）。 */
export const ADD_ASSIGNMENT_REFUSAL = {
  /** D05：その承諾からの勤務がすでにある。 */
  DUPLICATE_COMMITMENT: "DUPLICATE_COMMITMENT",
  /** ADR-006：同じスタッフの勤務が重なる。 */
  OVERLAP: "OVERLAP",
} as const;

export type AddAssignmentRefusal =
  (typeof ADD_ASSIGNMENT_REFUSAL)[keyof typeof ADD_ASSIGNMENT_REFUSAL];

export interface ShiftAssignmentRepository {
  /**
   * 代替勤務を1件足す。**採用取引の中で全件を入れる**（D06）。
   *
   * 制約違反は取引を中断させるため、内部で SAVEPOINT を張って理由を返す。
   * 呼出し元は1件でも拒否されたら取引ごと巻き戻す（A08）。
   */
  addAdditional(
    tx: TxHandle,
    input: AddAssignmentInput,
  ): Promise<"INSERTED" | AddAssignmentRefusal>;
  /**
   * 元勤務を欠勤にする。`CANCELLED`（勤務自体が無くなった）と混同しない。
   * Q04により全時間欠勤のみを扱うので、区間は分割しない。
   */
  markAbsent(
    tx: TxHandle,
    input: { shiftAssignmentId: ShiftAssignmentId },
  ): Promise<"UPDATED" | "NOT_SCHEDULED">;
}
