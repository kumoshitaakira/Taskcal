import type { PoolClient } from "pg";
import type { AdoptionFact } from "@/contracts/case-state";
import type { OperationRef, OperationMatch } from "@/contracts/operation";
import type { UpdateResultKind, ScheduleUpdateState } from "@/contracts/schedule-update";

/** applicationが開いた取引をrepositoryへ渡す。repository自身は取引を管理しない。 */
export type RepositoryTx = PoolClient;

export const READ_BACK_STATUS = {
  NOT_ATTEMPTED: "NOT_ATTEMPTED",
  MATCHED: "MATCHED",
  MISMATCH: "MISMATCH",
  UNKNOWN: "UNKNOWN",
} as const;

export type ReadBackStatus = (typeof READ_BACK_STATUS)[keyof typeof READ_BACK_STATUS];

export type ReadBackObservation =
  | {
      readonly status: Exclude<ReadBackStatus, "MATCHED">;
      readonly sourceRevision?: string;
      readonly artifactRef?: string;
      readonly detail?: string;
    }
  | {
      readonly status: "MATCHED";
      readonly sourceRevision: string;
      readonly artifactRef: string;
      readonly detail?: string;
    };

export interface ResultMapping {
  readonly commitmentId: string;
  readonly shiftAssignmentId: string;
  readonly externalAssignmentId?: string;
}

export interface ScheduleUpdateRecord {
  readonly scheduleUpdateId: string;
  readonly caseId: string;
  readonly scheduleId: string;
  /** SelectionResultの最終schema確定前の参照値。 */
  readonly selectionResultRef?: string;
  readonly connectionId: string;
  readonly operation: OperationRef;
  readonly expectedSourceRevision: string;
  readonly sourceRevisionAfter?: string;
  readonly revisionCheckEnforced: boolean;
  readonly artifactRef?: string;
  readonly state: ScheduleUpdateState;
  readonly externalAttemptState: ExternalAttemptState;
  readonly resultKind?: UpdateResultKind;
  readonly readBack: ReadBackObservation;
  /** 案件状態と別に保持する採用済み事実。 */
  readonly adoptionFact: AdoptionFact;
  readonly resultMappings: readonly ResultMapping[];
  readonly resultDetail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StartScheduleUpdateInput {
  readonly scheduleUpdateId: string;
  readonly caseId: string;
  readonly scheduleId: string;
  readonly selectionResultRef?: string;
  readonly connectionId: string;
  readonly operation: OperationRef;
  readonly expectedSourceRevision: string;
}

export interface RecordScheduleUpdateOutcomeInput {
  readonly connectionId: string;
  readonly operation: OperationRef;
  readonly state: ScheduleUpdateState;
  readonly resultKind?: UpdateResultKind;
  readonly sourceRevisionAfter?: string;
  readonly revisionCheckEnforced: boolean;
  readonly artifactRef?: string;
  readonly readBack: ReadBackObservation;
  readonly adoptionFact: AdoptionFact;
  readonly resultMappings: readonly ResultMapping[];
  readonly resultDetail?: string;
}

export interface RecordScheduleUpdateReadBackInput {
  readonly connectionId: string;
  readonly operation: OperationRef;
  readonly readBack: ReadBackObservation;
}

export interface OperationWrite<T> {
  readonly match: OperationMatch;
  readonly record: T;
}

export const RESULT_WRITE_MATCH = {
  APPLIED: "APPLIED",
  REPLAY: "REPLAY",
} as const;

export type ResultWriteMatch = (typeof RESULT_WRITE_MATCH)[keyof typeof RESULT_WRITE_MATCH];

export interface ResultWrite<T> {
  readonly match: ResultWriteMatch;
  readonly record: T;
}

export const EXTERNAL_ATTEMPT_STATE = {
  IN_FLIGHT: "IN_FLIGHT",
  RESULT_RECORDED: "RESULT_RECORDED",
} as const;

export type ExternalAttemptState =
  (typeof EXTERNAL_ATTEMPT_STATE)[keyof typeof EXTERNAL_ATTEMPT_STATE];

export const OUTBOUND_OPERATION_STATE = {
  NEW: "NEW",
  IN_FLIGHT: "IN_FLIGHT",
  ACCEPTED: "ACCEPTED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
  RECONCILE_REQUIRED: "RECONCILE_REQUIRED",
} as const;

export type OutboundOperationState =
  (typeof OUTBOUND_OPERATION_STATE)[keyof typeof OUTBOUND_OPERATION_STATE];

export const EXTERNAL_ATTEMPT_DECISION = {
  START: "START",
  LOOKUP_REQUIRED: "LOOKUP_REQUIRED",
  REPLAY: "REPLAY",
} as const;

export type ExternalAttemptDecision =
  (typeof EXTERNAL_ATTEMPT_DECISION)[keyof typeof EXTERNAL_ATTEMPT_DECISION];

export interface ExternalAttemptResult {
  readonly decision: ExternalAttemptDecision;
  readonly record: OutboundOperationRecord;
}

export interface OutboundOperationRecord {
  readonly outboundOperationId: string;
  readonly provider: string;
  readonly connectionId: string;
  readonly operation: OperationRef;
  readonly operationKind: string;
  readonly state: OutboundOperationState;
  readonly providerOperationRef?: string;
  readonly artifactRef?: string;
  /** 外部providerの結果metadata。本文・秘密値を含めない。 */
  readonly resultMetadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReserveOutboundOperationInput {
  readonly outboundOperationId: string;
  readonly provider: string;
  readonly connectionId: string;
  readonly operation: OperationRef;
  readonly operationKind: string;
}

export interface RecordOutboundOperationResultInput {
  readonly provider: string;
  readonly connectionId: string;
  readonly operation: OperationRef;
  readonly state: OutboundOperationState;
  readonly providerOperationRef?: string;
  readonly artifactRef?: string;
  readonly resultMetadata?: Readonly<Record<string, unknown>>;
}
