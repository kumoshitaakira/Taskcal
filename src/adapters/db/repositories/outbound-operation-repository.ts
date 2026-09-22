import type { QueryResultRow } from "pg";
import { computeRequestHash } from "@/contracts/operation";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import {
  decideExternalAttempt,
  isAllowedOutboundTransition,
  matchStoredRequest,
} from "./operation-match";
import type {
  ExternalAttemptResult,
  OperationWrite,
  OutboundOperationRecord,
  RecordOutboundOperationResultInput,
  RepositoryTx,
  ResultWrite,
  ReserveOutboundOperationInput,
} from "./types";

interface OutboundOperationRow extends QueryResultRow {
  outbound_operation_id: string;
  provider: string;
  connection_id: string;
  operation_id: string;
  request_hash: string;
  operation_kind: string;
  state: OutboundOperationRecord["state"];
  provider_operation_ref: string | null;
  artifact_ref: string | null;
  result_metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

const OUTBOUND_OPERATION_COLUMNS = `
  outbound_operation_id,
  provider,
  connection_id,
  operation_id,
  request_hash,
  operation_kind,
  state,
  provider_operation_ref,
  artifact_ref,
  result_metadata,
  created_at,
  updated_at`;

export interface OutboundOperationRepository {
  findByOperation(
    tx: RepositoryTx,
    ref: { readonly provider: string; readonly connectionId: string; readonly operationId: string },
  ): Promise<OutboundOperationRecord | undefined>;
  reserve(
    tx: RepositoryTx,
    input: ReserveOutboundOperationInput,
  ): Promise<OperationWrite<OutboundOperationRecord>>;
  beginExternalAttempt(
    tx: RepositoryTx,
    input: {
      readonly provider: string;
      readonly connectionId: string;
      readonly operation: RecordOutboundOperationResultInput["operation"];
    },
  ): Promise<ExternalAttemptResult>;
  recordResult(
    tx: RepositoryTx,
    input: RecordOutboundOperationResultInput,
  ): Promise<ResultWrite<OutboundOperationRecord>>;
}

/**
 * 外部作用の結果照合境界の下書き。
 *
 * reserveは外部providerを呼ばない。applicationは短い取引でbeginExternalAttemptを呼び、
 * IN_FLIGHTのcommit成功を確認してから、取引の外で外部providerを呼ぶ。結果は別の取引で
 * recordResultへ保存する。commit成否が不明な場合もproviderを呼ばず、IN_FLIGHT／UNKNOWN／
 * RECONCILE_REQUIREDの照会を先に行う。
 */
export class PgOutboundOperationRepository implements OutboundOperationRepository {
  async findByOperation(
    tx: RepositoryTx,
    ref: { readonly provider: string; readonly connectionId: string; readonly operationId: string },
  ): Promise<OutboundOperationRecord | undefined> {
    const { rows } = await tx.query<OutboundOperationRow>(
      `select ${OUTBOUND_OPERATION_COLUMNS}
         from outbound_operation
        where provider = $1 and connection_id = $2 and operation_id = $3`,
      [ref.provider, ref.connectionId, ref.operationId],
    );
    return rows[0] ? toOutboundOperationRecord(rows[0]) : undefined;
  }

  async reserve(
    tx: RepositoryTx,
    input: ReserveOutboundOperationInput,
  ): Promise<OperationWrite<OutboundOperationRecord>> {
    const existing = await this.findByOperation(tx, {
      provider: input.provider,
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
    });
    if (existing) {
      const match = matchStoredRequest(existing.operation.requestHash, input.operation.requestHash);
      return { match, record: existing };
    }

    const { rows } = await tx.query<OutboundOperationRow>(
      `insert into outbound_operation (
         outbound_operation_id,
         provider,
         connection_id,
         operation_id,
         request_hash,
         operation_kind,
         state
       ) values ($1, $2, $3, $4, $5, $6, 'NEW')
       on conflict (provider, connection_id, operation_id) do nothing
       returning ${OUTBOUND_OPERATION_COLUMNS}`,
      [
        input.outboundOperationId,
        input.provider,
        input.connectionId,
        input.operation.operationId,
        input.operation.requestHash,
        input.operationKind,
      ],
    );

    if (rows[0]) {
      return { match: "NEW", record: toOutboundOperationRecord(rows[0]) };
    }

    const raced = await this.findByOperation(tx, {
      provider: input.provider,
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
    });
    if (!raced) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        "outbound operationの保存結果を照合できません。外部作用を再実行しないでください。",
      );
    }
    const match = matchStoredRequest(raced.operation.requestHash, input.operation.requestHash);
    return { match, record: raced };
  }

  async recordResult(
    tx: RepositoryTx,
    input: RecordOutboundOperationResultInput,
  ): Promise<ResultWrite<OutboundOperationRecord>> {
    if (input.state === "NEW" || input.state === "IN_FLIGHT") {
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        "外部作用の結果にはNEWまたはIN_FLIGHT以外の状態を指定してください。",
      );
    }
    const existing = await this.findByOperationForUpdate(tx, {
      provider: input.provider,
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
    });
    if (!existing) {
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        "outbound operationをreserveせずに結果を保存できません。",
      );
    }
    matchStoredRequest(existing.operation.requestHash, input.operation.requestHash);

    if (sameOutboundResult(existing, input)) {
      return { match: "REPLAY", record: existing };
    }
    if (!isAllowedOutboundTransition(existing.state, input.state)) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        `outbound operationの状態を${existing.state}から${input.state}へ変更できません。照合が必要です。`,
      );
    }

    const { rows } = await tx.query<OutboundOperationRow>(
      `update outbound_operation
          set state = $1,
              provider_operation_ref = $2,
              artifact_ref = $3,
              result_metadata = $4::jsonb,
              updated_at = now()
        where provider = $5 and connection_id = $6 and operation_id = $7 and state = $8
        returning ${OUTBOUND_OPERATION_COLUMNS}`,
      [
        input.state,
        input.providerOperationRef ?? null,
        input.artifactRef ?? null,
        input.resultMetadata === undefined ? null : JSON.stringify(input.resultMetadata),
        input.provider,
        input.connectionId,
        input.operation.operationId,
        existing.state,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        "outbound operationの結果保存後の読出しを照合できません。",
      );
    }
    return { match: "APPLIED", record: toOutboundOperationRecord(row) };
  }

  async beginExternalAttempt(
    tx: RepositoryTx,
    input: {
      readonly provider: string;
      readonly connectionId: string;
      readonly operation: RecordOutboundOperationResultInput["operation"];
    },
  ): Promise<ExternalAttemptResult> {
    const existing = await this.findByOperationForUpdate(tx, {
      provider: input.provider,
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
    });
    if (!existing) {
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        "外部作用を開始するには、先にreserveで操作を保存してください。",
      );
    }
    const decision = decideExternalAttempt(
      existing.state,
      existing.operation.requestHash,
      input.operation.requestHash,
    );
    if (decision !== "START") {
      return { decision, record: existing };
    }

    const { rows } = await tx.query<OutboundOperationRow>(
      `update outbound_operation
          set state = 'IN_FLIGHT', updated_at = now()
        where provider = $1 and connection_id = $2 and operation_id = $3
          and state = 'NEW'
        returning ${OUTBOUND_OPERATION_COLUMNS}`,
      [input.provider, input.connectionId, input.operation.operationId],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        "外部作用開始の永続化結果を照合できません。再送せず照会してください。",
      );
    }
    return { decision, record: toOutboundOperationRecord(row) };
  }

  private async findByOperationForUpdate(
    tx: RepositoryTx,
    ref: { readonly provider: string; readonly connectionId: string; readonly operationId: string },
  ): Promise<OutboundOperationRecord | undefined> {
    const { rows } = await tx.query<OutboundOperationRow>(
      `select ${OUTBOUND_OPERATION_COLUMNS}
         from outbound_operation
        where provider = $1 and connection_id = $2 and operation_id = $3
        for update`,
      [ref.provider, ref.connectionId, ref.operationId],
    );
    return rows[0] ? toOutboundOperationRecord(rows[0]) : undefined;
  }
}

function sameOutboundResult(
  existing: OutboundOperationRecord,
  input: RecordOutboundOperationResultInput,
): boolean {
  return (
    computeRequestHash({
      state: input.state,
      providerOperationRef: input.providerOperationRef,
      artifactRef: input.artifactRef,
      resultMetadata: input.resultMetadata,
    }) ===
    computeRequestHash({
      state: existing.state,
      providerOperationRef: existing.providerOperationRef,
      artifactRef: existing.artifactRef,
      resultMetadata: existing.resultMetadata,
    })
  );
}

function toOutboundOperationRecord(row: OutboundOperationRow): OutboundOperationRecord {
  return {
    outboundOperationId: row.outbound_operation_id,
    provider: row.provider,
    connectionId: row.connection_id,
    operation: { operationId: row.operation_id, requestHash: row.request_hash },
    operationKind: row.operation_kind,
    state: row.state,
    providerOperationRef: row.provider_operation_ref ?? undefined,
    artifactRef: row.artifact_ref ?? undefined,
    resultMetadata: parseMetadata(row.result_metadata),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function parseMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("outbound_operation.result_metadata is not an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
