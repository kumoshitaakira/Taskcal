/**
 * 勤務表更新の永続化（RFC-010 §6・§7、ADR-016）。
 *
 * 作業用成果物の作成（`PREPARED`）と正式採用（`ADOPTED`）を別の状態として持つ。
 * 遷移は `isAllowedScheduleUpdateTransition` を通す。矢印だけで動かさない——
 * `RECONCILE_REQUIRED` からの解消は、呼出し元が `resolveReconcile` で照合結果から
 * 決めたものだけを渡す。
 *
 * D05：1案件で `ADOPTED` は一つ。**別の操作キーでも二重採用しない**（A04）。
 * 部分一意索引が最後に拒否するので、その違反を `ALREADY_ADOPTED` として返す。
 */

import "server-only";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import type {
  CreateScheduleUpdateInput,
  ScheduleUpdateRepository,
  ScheduleUpdateSnapshot,
  TxHandle,
} from "../../contracts/repository";
import {
  TERMINAL_SCHEDULE_UPDATE_STATES,
  isAllowedScheduleUpdateTransition,
  type ScheduleUpdateState,
  type UpdateResultKind,
} from "../../contracts/schedule-update";
import type { Tx } from "./transaction";

interface UpdateRow {
  readonly schedule_update_id: string;
  readonly case_id: string;
  readonly case_version: number;
  readonly selection_id: string;
  readonly operation_id: string;
  readonly connection_id: string;
  readonly schedule_id: string;
  readonly expected_source_revision: string;
  readonly state: ScheduleUpdateState;
  readonly result_kind: UpdateResultKind | null;
  readonly artifact_ref: string | null;
  readonly new_source_revision: string | null;
  readonly revision_check_enforced: boolean;
  readonly adopted_at: Date | null;
  readonly created_at: Date;
}

const COLUMNS = `schedule_update_id, case_id, case_version, selection_id, operation_id, connection_id,
  schedule_id, expected_source_revision, state, result_kind, artifact_ref,
  new_source_revision, revision_check_enforced, adopted_at, created_at`;

/** 時刻は ISO 文字列で返す。Date のままだと computeRequestHash が拒否する。 */
function toSnapshot(row: UpdateRow): ScheduleUpdateSnapshot {
  return {
    scheduleUpdateId: row.schedule_update_id,
    caseId: row.case_id,
    caseVersion: row.case_version,
    selectionId: row.selection_id,
    operationId: row.operation_id,
    connectionId: row.connection_id,
    scheduleId: row.schedule_id,
    expectedSourceRevision: row.expected_source_revision,
    state: row.state,
    resultKind: row.result_kind ?? undefined,
    artifactRef: row.artifact_ref ?? undefined,
    newSourceRevision: row.new_source_revision ?? undefined,
    revisionCheckEnforced: row.revision_check_enforced,
    adoptedAt: row.adopted_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/** 一意制約違反。 */
const UNIQUE_VIOLATION = "23505";

export function createPgScheduleUpdateRepository(): ScheduleUpdateRepository {
  async function fetch(tx: Tx, where: string, value: string) {
    const { rows } = await tx.query<UpdateRow>(
      `select ${COLUMNS} from schedule_update where ${where} = $1`,
      [value],
    );
    const row = rows[0];
    return row ? toSnapshot(row) : ("NOT_FOUND" as const);
  }

  return {
    async create(handle: TxHandle, input: CreateScheduleUpdateInput) {
      const tx = handle as Tx;
      const { rows } = await tx.query<UpdateRow>(
        `insert into schedule_update
           (schedule_update_id, case_id, case_version, selection_id, operation_id,
            connection_id, schedule_id, expected_source_revision, state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'PREPARING')
         returning ${COLUMNS}`,
        [
          input.scheduleUpdateId,
          input.caseId,
          input.caseVersion,
          input.selectionId,
          input.operationId,
          input.connectionId,
          input.scheduleId,
          input.expectedSourceRevision,
        ],
      );
      return toSnapshot(rows[0]);
    },

    async advance(handle: TxHandle, input) {
      const tx = handle as Tx;
      const { rows } = await tx.query<{ state: ScheduleUpdateState }>(
        "select state from schedule_update where schedule_update_id = $1 for update",
        [input.scheduleUpdateId],
      );
      const current = rows[0]?.state;
      if (!current) return "NOT_ALLOWED";
      // 矢印だけで動かさない。未知の状態は false ではなく例外にする。
      if (!isAllowedScheduleUpdateTransition(current, input.to)) return "NOT_ALLOWED";
      if (input.to === "ADOPTED" && !input.adoptedAt) {
        // DBの制約（adopted_pair）と同じことをコード側でも要求する。採用時刻の
        // 無い ADOPTED を作ると、いつ確定したか説明できない。
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          "ADOPTED へ進めるには採用時刻が要ります。",
        );
      }

      // D05 の部分一意索引が拒否すると取引全体が中断する。SAVEPOINT で囲まないと、
      // 二重採用を検出した後に呼出し元が事実を記録できない。
      await tx.query("savepoint advance_schedule_update");
      try {
        await tx.query(
          `update schedule_update
              set state = $2,
                  result_kind = coalesce($3, result_kind),
                  artifact_ref = coalesce($4, artifact_ref),
                  new_source_revision = coalesce($5, new_source_revision),
                  revision_check_enforced = coalesce($6, revision_check_enforced),
                  adopted_at = $7
            where schedule_update_id = $1`,
          [
            input.scheduleUpdateId,
            input.to,
            input.resultKind ?? null,
            input.artifactRef ?? null,
            input.newSourceRevision ?? null,
            input.revisionCheckEnforced ?? null,
            input.adoptedAt ?? null,
          ],
        );
        await tx.query("release savepoint advance_schedule_update");
        return "UPDATED";
      } catch (error) {
        await tx.query("rollback to savepoint advance_schedule_update");
        // A04：この案件はすでに別の計画を正式採用している。別の操作キーでも通さない。
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return "ALREADY_ADOPTED";
        throw error;
      }
    },

    async findById(handle: TxHandle, scheduleUpdateId: string) {
      return fetch(handle as Tx, "schedule_update_id", scheduleUpdateId);
    },

    async findByOperation(handle: TxHandle, operationId: string) {
      return fetch(handle as Tx, "operation_id", operationId);
    },

    async findOpenByCase(handle: TxHandle, caseId: string) {
      const tx = handle as Tx;
      // 終端（ADOPTED / REJECTED）は再開の対象にしない。確定済みの取消は
      // 別の変更操作にする（D10）。
      const { rows } = await tx.query<UpdateRow>(
        `select ${COLUMNS} from schedule_update
          where case_id = $1 and state <> all($2::text[])
          order by created_at desc limit 1`,
        [caseId, [...TERMINAL_SCHEDULE_UPDATE_STATES]],
      );
      const row = rows[0];
      return row ? toSnapshot(row) : ("NONE" as const);
    },
  };
}
