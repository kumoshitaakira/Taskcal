/**
 * 永続化の口。
 *
 * 出典：RFC-010 §4 手順6、RFC-011 §4、ADR-006、RFC-009 D05・D06・D07。
 *
 * **全ての操作が取引ハンドルを取る。** repository が自分で取引を開くと、正式採用の
 * 一括保存（正式版参照・内部勤務表・採用済み計画・案件の確定事実・操作結果・通知待ちを
 * 同じ取引で保存する）が黙って複数の取引へ割れ、一部だけが正式勤務として残る（D06）。
 * 取引境界は `src/application/` が決める。
 *
 * 選定結果と勤務表更新の repository は、正式採用を実装するときに足す。
 */

import type { AdoptionFact, CaseState, Handoff, StopCause } from "./case-state";
import type { Commitment, CommitmentStatus } from "./commitment";
import type { ContactEndpointRef, InboundEvent, PersistedInboundEvent } from "./messaging-gateway";
import type { PersistedReplyInterpretation } from "./model-output";
import type { OperationId, OperationMatch, OperationRef } from "./operation";
import type { OutreachMessageKind, OutreachState, SenderIdentity } from "./outreach-state";
import type { ConnectionId, ScheduleId, ShiftAssignmentId } from "./schedule-gateway";

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
  /** 受信イベントの宛先から打診を逆引きする。版まで一致した場合だけ本人とみなす（A15）。 */
  findByEndpoint(
    tx: TxHandle,
    endpoint: ContactEndpointRef,
  ): Promise<OutreachSnapshot | "NOT_FOUND">;
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
      readonly linked: true;
      readonly match: "NEW" | "DUPLICATE";
      readonly stored: PersistedInboundEvent;
    }
  | {
      readonly linked: false;
      readonly match: "NEW" | "DUPLICATE";
      readonly inboundEventId: string;
      readonly senderIdentity: SenderIdentity;
    };

export interface InboundEventRepository {
  /**
   * 受信イベントを**モデル処理の前に**永続化し、案件内の `receivedSeq` を採番する。
   *
   * 重複排除キーは provider・connectionId の範囲を含める（A15）。案件へ結び付か
   * なかった受信も捨てずに保存する。本文で名乗った staffId を本人とみなさない。
   */
  persist(
    tx: TxHandle,
    event: InboundEvent,
    resolved: { caseId?: string; outreachId?: string; senderIdentity: SenderIdentity },
  ): Promise<PersistInboundResult>;
  findById(tx: TxHandle, inboundEventId: string): Promise<PersistedInboundEvent | "NOT_FOUND">;
  /** D04：この打診に、まだ解釈を適用していない受信があるか。 */
  hasUnprocessed(tx: TxHandle, outreachId: string): Promise<boolean>;
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
  /** `receivedSeq` と案件版を必ず持つ。A12 の判定材料になる（RFC-011 §4）。 */
  save(
    tx: TxHandle,
    record: PersistedReplyInterpretation,
    applied: InterpretationApplication,
  ): Promise<void>;
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
