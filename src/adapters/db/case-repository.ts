/**
 * 案件の永続化（RFC-011 §5、ADR-022）。
 *
 * 遷移は `isAllowedCaseTransition` を通したうえで、期待版と一致する場合だけ書く。
 * 版が動いていれば `VERSION_CONFLICT` を返し、呼出し元が読み直す（D08）。
 *
 * 採用事実（`adoption_fact`）は案件状態と別の列で持つ。状態から採用可否を推定しない。
 */

import "server-only";
import {
  isAllowedCaseTransition,
  type AdoptionFact,
  type CaseState,
  type Handoff,
  type StopCause,
} from "../../contracts/case-state";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import type {
  AbsenceCaseRepository,
  CaseSnapshot,
  CreateCaseInput,
  TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

interface CaseRow {
  readonly case_id: string;
  readonly store_id: string;
  readonly connection_id: string;
  readonly schedule_id: string;
  readonly business_date: string;
  readonly absent_shift_assignment_id: string;
  readonly absent_staff_id: string;
  readonly role_code: string;
  readonly required_start_at: Date;
  readonly required_end_at: Date;
  readonly deadline_at: Date;
  readonly state: CaseState;
  readonly version: number;
  readonly adoption_fact: AdoptionFact;
  readonly handoff_reason: Handoff["reason"] | null;
  readonly handed_off_at: Date | null;
  readonly stop_cause: StopCause | null;
  readonly stopped_at: Date | null;
  readonly run_id: string;
  readonly created_at: Date;
}

// date 型を Date で受けるとローカル深夜として解釈され、JSTでは日付が1日ずれる。
// 営業日は文字列のまま受け取る。
const COLUMNS = `case_id, store_id, connection_id, schedule_id,
  to_char(business_date, 'YYYY-MM-DD') as business_date,
  absent_shift_assignment_id, absent_staff_id, role_code,
  required_start_at, required_end_at, deadline_at, state, version,
  adoption_fact, handoff_reason, handed_off_at, stop_cause, stopped_at, run_id, created_at`;

/** 時刻は ISO 文字列で返す。Date のままだと computeRequestHash が拒否する。 */
function toSnapshot(row: CaseRow): CaseSnapshot {
  return {
    caseId: row.case_id,
    storeId: row.store_id,
    connectionId: row.connection_id,
    scheduleId: row.schedule_id,
    businessDate: row.business_date,
    absentShiftAssignmentId: row.absent_shift_assignment_id,
    absentStaffId: row.absent_staff_id,
    roleCode: row.role_code,
    requiredStartAt: row.required_start_at.toISOString(),
    requiredEndAt: row.required_end_at.toISOString(),
    deadlineAt: row.deadline_at.toISOString(),
    state: row.state,
    version: row.version,
    adoptionFact: row.adoption_fact,
    handoff:
      row.handoff_reason && row.handed_off_at
        ? {
            reason: row.handoff_reason,
            adoptionFact: row.adoption_fact,
            handedOffAt: row.handed_off_at.toISOString(),
          }
        : undefined,
    stopCause: row.stop_cause ?? undefined,
    stoppedAt: row.stopped_at?.toISOString(),
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
  };
}

/** 一意制約違反。 */
const UNIQUE_VIOLATION = "23505";

export function createPgAbsenceCaseRepository(): AbsenceCaseRepository {
  async function fetch(tx: Tx, caseId: string, lock: boolean) {
    const { rows } = await tx.query<CaseRow>(
      `select ${COLUMNS} from absence_case where case_id = $1${lock ? " for update" : ""}`,
      [caseId],
    );
    const row = rows[0];
    return row ? toSnapshot(row) : ("NOT_FOUND" as const);
  }

  return {
    async lockForUpdate(handle: TxHandle, caseId: string) {
      return fetch(handle as Tx, caseId, true);
    },

    async findById(handle: TxHandle, caseId: string) {
      return fetch(handle as Tx, caseId, false);
    },

    async listActive(handle: TxHandle, storeId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<CaseRow>(
        `select ${COLUMNS} from absence_case
          where store_id = $1 and state not in ('COMPLETED', 'HANDED_OFF', 'CANCELLED')
          order by created_at desc`,
        [storeId],
      );
      return rows.map(toSnapshot);
    },

    async create(handle: TxHandle, input: CreateCaseInput) {
      const tx = handle as Tx;
      // 制約違反は取引全体を中断させる。SAVEPOINT で囲まないと、重複を検出した後に
      // 呼出し元が拒否の記録を書けない（「current transaction is aborted」）。
      await tx.query("savepoint create_case");
      try {
        const { rows } = await tx.query<CaseRow>(
          `insert into absence_case
             (case_id, store_id, connection_id, schedule_id, business_date,
              absent_shift_assignment_id, absent_staff_id, role_code,
              required_start_at, required_end_at, deadline_at, state, run_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'COORDINATING', $12)
           returning ${COLUMNS}`,
          [
            input.caseId,
            input.storeId,
            input.connectionId,
            input.scheduleId,
            input.businessDate,
            input.absentShiftAssignmentId,
            input.absentStaffId,
            input.roleCode,
            input.requiredStartAt,
            input.requiredEndAt,
            input.deadlineAt,
            input.runId,
          ],
        );
        await tx.query("release savepoint create_case");
        return toSnapshot(rows[0]);
      } catch (error) {
        await tx.query("rollback to savepoint create_case");
        // D02：稼働中の重複案件。部分一意索引が拒否する。
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          return "DUPLICATE_ACTIVE_CASE";
        }
        throw error;
      }
    },

    async applyTransition(handle: TxHandle, input) {
      const tx = handle as Tx;
      const current = await fetch(tx, input.caseId, true);
      if (current === "NOT_FOUND") return "VERSION_CONFLICT";
      if (current.version !== input.expectedVersion) return "VERSION_CONFLICT";

      // 矢印だけで動かさない。条件付きの遷移は呼出し元が解決関数を通す。
      if (!isAllowedCaseTransition(current.state, input.to)) {
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          `許可されていない案件の遷移です: ${current.state} -> ${input.to}`,
        );
      }

      const { rowCount } = await tx.query(
        `update absence_case
            set state = $3,
                version = version + 1,
                adoption_fact = coalesce($4, adoption_fact),
                handoff_reason = $5,
                handed_off_at = $6,
                stop_cause = coalesce($7, stop_cause),
                stopped_at = coalesce($8, stopped_at)
          where case_id = $1 and version = $2`,
        [
          input.caseId,
          input.expectedVersion,
          input.to,
          input.adoptionFact ?? null,
          input.handoff?.reason ?? null,
          input.handoff?.handedOffAt ?? null,
          input.stop?.cause ?? null,
          input.stop?.at ?? null,
        ],
      );
      return rowCount === 1 ? "UPDATED" : "VERSION_CONFLICT";
    },

    async recordEvent(handle: TxHandle, input) {
      const tx = handle as Tx;
      await tx.query(
        `insert into case_processing_event (event_id, case_id, kind, detail)
         values (gen_random_uuid(), $1, $2, $3::jsonb)`,
        [input.caseId, input.kind, input.detail ? JSON.stringify(input.detail) : null],
      );
    },
  };
}
