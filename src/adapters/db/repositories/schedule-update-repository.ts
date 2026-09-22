import type { QueryResultRow } from "pg";
import { computeRequestHash } from "@/contracts/operation";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import { isAllowedScheduleUpdateTransition } from "@/contracts/schedule-update";
import { matchStoredRequest } from "./operation-match";
import type {
  OperationWrite,
  RecordScheduleUpdateOutcomeInput,
  RepositoryTx,
  ScheduleUpdateRecord,
  ReadBackStatus,
  ResultWrite,
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
  revision_check_enforced: boolean;
  artifact_ref: string | null;
  state: ScheduleUpdateRecord["state"];
  external_attempt_state: ScheduleUpdateRecord["externalAttemptState"];
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
  revision_check_enforced,
  artifact_ref,
  state,
  external_attempt_state,
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
  ): Promise<ResultWrite<ScheduleUpdateRecord>>;
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
         revision_check_enforced,
         external_attempt_state,
         state,
         read_back_status,
         adoption_fact,
         result_mappings
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, false, 'IN_FLIGHT', 'PREPARING', 'NOT_ATTEMPTED', 'NOT_ADOPTED', '[]'::jsonb)
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
  ): Promise<ResultWrite<ScheduleUpdateRecord>> {
    validateOutcomeEvidence(input);
    const existing = await this.findByOperationForUpdate(tx, {
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

    if (sameOutcome(existing, input)) {
      return { match: "REPLAY", record: existing };
    }
    if (!isAllowedScheduleUpdateTransition(existing.state, input.state)) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        `ScheduleUpdateの状態を${existing.state}から${input.state}へ変更できません。照合が必要です。`,
      );
    }

    const { rows } = await tx.query<ScheduleUpdateRow>(
      `update schedule_update
          set state = $1,
              result_kind = $2,
              source_revision_after = $3,
              revision_check_enforced = $4,
              artifact_ref = $5,
              read_back_status = $6,
              read_back_source_revision = $7,
              read_back_artifact_ref = $8,
              read_back_detail = $9,
              adoption_fact = $10,
              result_mappings = $11::jsonb,
              result_detail = $12,
              external_attempt_state = 'RESULT_RECORDED',
              updated_at = now()
        where connection_id = $13 and operation_id = $14 and state = $15
        returning ${SCHEDULE_UPDATE_COLUMNS}`,
      [
        input.state,
        input.resultKind ?? null,
        input.sourceRevisionAfter ?? null,
        input.revisionCheckEnforced,
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
        existing.state,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskcalError(
        ERROR_CODES.RECONCILE_REQUIRED,
        "ScheduleUpdateの結果保存後の読出しを照合できません。",
      );
    }
    return { match: "APPLIED", record: toScheduleUpdateRecord(row) };
  }

  private async findByOperationForUpdate(
    tx: RepositoryTx,
    ref: { readonly connectionId: string; readonly operationId: string },
  ): Promise<ScheduleUpdateRecord | undefined> {
    const { rows } = await tx.query<ScheduleUpdateRow>(
      `select ${SCHEDULE_UPDATE_COLUMNS}
         from schedule_update
        where connection_id = $1 and operation_id = $2
        for update`,
      [ref.connectionId, ref.operationId],
    );
    return rows[0] ? toScheduleUpdateRecord(rows[0]) : undefined;
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
    revisionCheckEnforced: row.revision_check_enforced,
    artifactRef: row.artifact_ref ?? undefined,
    state: row.state,
    externalAttemptState: row.external_attempt_state,
    resultKind: row.result_kind ?? undefined,
    readBack: toReadBackObservation(row),
    adoptionFact: row.adoption_fact,
    resultMappings: parseResultMappings(row.result_mappings),
    resultDetail: row.result_detail ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toReadBackObservation(row: ScheduleUpdateRow): ScheduleUpdateRecord["readBack"] {
  if (row.read_back_status === "MATCHED") {
    if (!row.read_back_source_revision || !row.read_back_artifact_ref) {
      throw new Error("MATCHED read-back is missing source revision or artifact reference");
    }
    return {
      status: "MATCHED",
      sourceRevision: row.read_back_source_revision,
      artifactRef: row.read_back_artifact_ref,
      detail: row.read_back_detail ?? undefined,
    };
  }
  return {
    status: row.read_back_status,
    sourceRevision: row.read_back_source_revision ?? undefined,
    artifactRef: row.read_back_artifact_ref ?? undefined,
    detail: row.read_back_detail ?? undefined,
  };
}

function validateOutcomeEvidence(input: RecordScheduleUpdateOutcomeInput): void {
  if (input.readBack.status === "MATCHED") {
    if (!input.readBack.sourceRevision || !input.readBack.artifactRef) {
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        "MATCHEDの読戻しにはsourceRevisionとartifactRefが必要です。",
      );
    }
  }
  if (input.state !== "ADOPTED") return;
  if (
    !input.revisionCheckEnforced ||
    input.readBack.status !== "MATCHED" ||
    !input.sourceRevisionAfter ||
    !input.artifactRef ||
    input.sourceRevisionAfter !== input.readBack.sourceRevision ||
    input.artifactRef !== input.readBack.artifactRef ||
    input.adoptionFact !== "ADOPTED"
  ) {
    throw new TaskcalError(
      ERROR_CODES.INVALID_INPUT,
      "ADOPTEDにはrevision検査、読戻し証拠、artifact、採用事実が必要です。",
    );
  }
}

function sameOutcome(
  existing: ScheduleUpdateRecord,
  input: RecordScheduleUpdateOutcomeInput,
): boolean {
  return (
    computeRequestHash({
      state: input.state,
      resultKind: input.resultKind,
      sourceRevisionAfter: input.sourceRevisionAfter,
      revisionCheckEnforced: input.revisionCheckEnforced,
      artifactRef: input.artifactRef,
      readBack: input.readBack,
      adoptionFact: input.adoptionFact,
      resultMappings: input.resultMappings,
      resultDetail: input.resultDetail,
    }) ===
    computeRequestHash({
      state: existing.state,
      resultKind: existing.resultKind,
      sourceRevisionAfter: existing.sourceRevisionAfter,
      revisionCheckEnforced: existing.revisionCheckEnforced,
      artifactRef: existing.artifactRef,
      readBack: existing.readBack,
      adoptionFact: existing.adoptionFact,
      resultMappings: existing.resultMappings,
      resultDetail: existing.resultDetail,
    })
  );
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
