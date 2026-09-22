import type { QueryResultRow } from "pg";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import { matchStoredRequest } from "./operation-match";
import type {
  OperationWrite,
  RecordScheduleUpdateOutcomeInput,
  RepositoryTx,
  ScheduleUpdateRecord,
  ReadBackStatus,
  ResultMapping,
  StartScheduleUpdateInput,
} from "./types";

interface ScheduleUpdateRow extends QueryResultRow {
  schedule_update_id: string;
  case_id: string;
  schedule_id: string;
  selection_result_ref: string | null;
  connection_id: string;
  operation_id: string;
  request_hash: string;
  expected_source_revision: string;
  source_revision_after: string | null;
  artifact_ref: string | null;
  state: ScheduleUpdateRecord["state"];
  result_kind: ScheduleUpdateRecord["resultKind"] | null;
  read_back_status: ReadBackStatus;
  read_back_source_revision: string | null;
  read_back_artifact_ref: string | null;
  read_back_detail: string | null;
  adoption_fact: ScheduleUpdateRecord["adoptionFact"];
  result_mappings: unknown;
  result_detail: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SCHEDULE_UPDATE_COLUMNS = `
  schedule_update_id,
  case_id,
  schedule_id,
  selection_result_ref,
  connection_id,
  operation_id,
  request_hash,
  expected_source_revision,
  source_revision_after,
  artifact_ref,
  state,
  result_kind,
  read_back_status,
  read_back_source_revision,
  read_back_artifact_ref,
  read_back_detail,
  adoption_fact,
  result_mappings,
  result_detail,
  created_at,
  updated_at`;

export interface ScheduleUpdateRepository {
  findByOperation(
    tx: RepositoryTx,
    ref: { readonly connectionId: string; readonly operationId: string },
  ): Promise<ScheduleUpdateRecord | undefined>;
  start(
    tx: RepositoryTx,
    input: StartScheduleUpdateInput,
  ): Promise<OperationWrite<ScheduleUpdateRecord>>;
  recordOutcome(
    tx: RepositoryTx,
    input: RecordScheduleUpdateOutcomeInput,
  ): Promise<ScheduleUpdateRecord>;
}

/**
 * ScheduleUpdateのDB境界の下書き。
 *
 * 取引は呼出し側が所有する。ここでは操作IDの競合判定と保存済み結果の再利用だけを
 * 行い、案件状態機械・正式採用直前の再検査・一括採用の判断は行わない。
 */
export class PgScheduleUpdateRepository implements ScheduleUpdateRepository {
  async findByOperation(
    tx: RepositoryTx,
    ref: { readonly connectionId: string; readonly operationId: string },
  ): Promise<ScheduleUpdateRecord | undefined> {
    const { rows } = await tx.query<ScheduleUpdateRow>(
      `select ${SCHEDULE_UPDATE_COLUMNS}
         from schedule_update
        where connection_id = $1 and operation_id = $2`,
      [ref.connectionId, ref.operationId],
    );
    return rows[0] ? toScheduleUpdateRecord(rows[0]) : undefined;
  }

  async start(
    tx: RepositoryTx,
    input: StartScheduleUpdateInput,
  ): Promise<OperationWrite<ScheduleUpdateRecord>> {
    const existing = await this.findByOperation(tx, {
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
    });
    if (existing) {
      const match = matchStoredRequest(existing.operation.requestHash, input.operation.requestHash);
      return { match, record: existing };
    }

    const { rows } = await tx.query<ScheduleUpdateRow>(
      `insert into schedule_update (
         schedule_update_id,
         case_id,
         schedule_id,
         selection_result_ref,
         connection_id,
         operation_id,
         request_hash,
         expected_source_revision,
         state,
         read_back_status,
         adoption_fact,
         result_mappings
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'PREPARING', 'NOT_ATTEMPTED', 'NOT_ADOPTED', '[]'::jsonb)
       on conflict (connection_id, operation_id) do nothing
       returning ${SCHEDULE_UPDATE_COLUMNS}`,
      [
        input.scheduleUpdateId,
        input.caseId,
        input.scheduleId,
        input.selectionResultRef ?? null,
        input.connectionId,
        input.operation.operationId,
        input.operation.requestHash,
        input.expectedSourceRevision,
      ],
    );

    if (rows[0]) {
      return { match: "NEW", record: toScheduleUpdateRecord(rows[0]) };
    }

    // 同時insertで先行した取引を再読し、hashを比較する。衝突をREPLAYにしない。
    const raced = await this.findByOperation(tx, {
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
    });
    if (!raced) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        "ScheduleUpdateの保存結果を照合できません。外部作用を再実行しないでください。",
      );
    }
    const match = matchStoredRequest(raced.operation.requestHash, input.operation.requestHash);
    return { match, record: raced };
  }

  async recordOutcome(
    tx: RepositoryTx,
    input: RecordScheduleUpdateOutcomeInput,
  ): Promise<ScheduleUpdateRecord> {
    const existing = await this.findByOperation(tx, {
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
    });
    if (!existing) {
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        "保存済みのScheduleUpdateがありません。結果を新規操作として保存しません。",
      );
    }
    matchStoredRequest(existing.operation.requestHash, input.operation.requestHash);

    const { rows } = await tx.query<ScheduleUpdateRow>(
      `update schedule_update
          set state = $1,
              result_kind = $2,
              source_revision_after = $3,
              artifact_ref = $4,
              read_back_status = $5,
              read_back_source_revision = $6,
              read_back_artifact_ref = $7,
              read_back_detail = $8,
              adoption_fact = $9,
              result_mappings = $10::jsonb,
              result_detail = $11,
              updated_at = now()
        where connection_id = $12 and operation_id = $13
        returning ${SCHEDULE_UPDATE_COLUMNS}`,
      [
        input.state,
        input.resultKind ?? null,
        input.sourceRevisionAfter ?? null,
        input.artifactRef ?? null,
        input.readBack.status,
        input.readBack.sourceRevision ?? null,
        input.readBack.artifactRef ?? null,
        input.readBack.detail ?? null,
        input.adoptionFact,
        JSON.stringify(input.resultMappings),
        input.resultDetail ?? null,
        input.connectionId,
        input.operation.operationId,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        "ScheduleUpdateの結果保存後の読出しを照合できません。",
      );
    }
    return toScheduleUpdateRecord(row);
  }
}

function toScheduleUpdateRecord(row: ScheduleUpdateRow): ScheduleUpdateRecord {
  return {
    scheduleUpdateId: row.schedule_update_id,
    caseId: row.case_id,
    scheduleId: row.schedule_id,
    selectionResultRef: row.selection_result_ref ?? undefined,
    connectionId: row.connection_id,
    operation: { operationId: row.operation_id, requestHash: row.request_hash },
    expectedSourceRevision: row.expected_source_revision,
    sourceRevisionAfter: row.source_revision_after ?? undefined,
    artifactRef: row.artifact_ref ?? undefined,
    state: row.state,
    resultKind: row.result_kind ?? undefined,
    readBack: {
      status: row.read_back_status,
      sourceRevision: row.read_back_source_revision ?? undefined,
      artifactRef: row.read_back_artifact_ref ?? undefined,
      detail: row.read_back_detail ?? undefined,
    },
    adoptionFact: row.adoption_fact,
    resultMappings: parseResultMappings(row.result_mappings),
    resultDetail: row.result_detail ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function parseResultMappings(value: unknown): readonly ResultMapping[] {
  if (!Array.isArray(value)) {
    throw new Error("schedule_update.result_mappings is not an array");
  }
  return value.map((entry) => {
    if (!isMapping(entry)) {
      throw new Error("schedule_update.result_mappings contains an invalid entry");
    }
    return entry;
  });
}

function isMapping(value: unknown): value is ResultMapping {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commitmentId === "string" &&
    typeof record.shiftAssignmentId === "string" &&
    (record.externalAssignmentId === undefined || typeof record.externalAssignmentId === "string")
  );
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
