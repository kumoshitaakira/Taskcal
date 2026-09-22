/**
 * 内部勤務表の読み取り（RFC-010 §2 の Schedule）。
 *
 * D11：読込・再起動・次案件は、正式版参照（`authoritative_schedule_ref`）から始める。
 * 勤務行を直接引かず、必ず参照を経由する。参照が無い勤務表は「取り込んでいない」の
 * であって「勤務が無い」ではない。
 *
 * CSV原本の取込み・正規化は担当Bの `src/adapters/csv/` が行う。ここが読むのは、取り込んだ
 * 結果が入る内部表。中身は `npm run seed:dev` / `reset:dev` が固定fixtureのCSVを
 * `parseMonthlyCsv` で検査して入れたもので、正式版参照は同じ内容の管理版
 * （`var/schedule/.../revisions/<sourceRevision>`）を指す（ADR-026）。
 */

import "server-only";
import type {
  LoadedAssignment,
  ScheduleId,
  SourceRevision,
} from "../../contracts/schedule-gateway";
import type { TxHandle } from "../../contracts/repository";
import type { Tx } from "./transaction";

export interface StoredSchedule {
  readonly scheduleId: ScheduleId;
  readonly storeId: string;
  readonly businessDate: string;
  /** 正式版参照が指す版。無い場合は取り込んでいない。 */
  readonly sourceRevision: SourceRevision;
  readonly assignments: readonly LoadedAssignment[];
}

export interface ScheduleReadRepository {
  /** 正式版参照を経由して1営業日の勤務表を読む。参照が無ければ `NOT_ADOPTED`。 */
  loadByDate(
    tx: TxHandle,
    input: { connectionId: string; storeId: string; businessDate: string },
  ): Promise<StoredSchedule | "NOT_ADOPTED">;
  /** 交代を依頼できる候補として画面に出す、予定済みの勤務。 */
  listScheduled(
    tx: TxHandle,
    input: { connectionId: string; storeId: string; from: string },
  ): Promise<readonly (LoadedAssignment & { businessDate: string; scheduleId: ScheduleId })[]>;
}

interface AssignmentRow {
  readonly shift_assignment_id: string;
  readonly staff_id: string;
  readonly role_code: string;
  readonly start_at: Date;
  readonly end_at: Date;
  readonly status: LoadedAssignment["status"];
  readonly source_case_id: string | null;
  readonly business_date: string;
  readonly schedule_id: string;
}

/**
 * `pg` は timestamptz を Date で返す。契約の時刻は ISO 文字列で持つ——
 * `computeRequestHash` が Date を拒否するため、ここで必ず文字列へ直す。
 */
function toAssignment(row: AssignmentRow): LoadedAssignment {
  return {
    shiftAssignmentId: row.shift_assignment_id,
    staffId: row.staff_id,
    roleCode: row.role_code,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    status: row.status,
    sourceCaseId: row.source_case_id ?? undefined,
  };
}

export function createPgScheduleReadRepository(): ScheduleReadRepository {
  return {
    async loadByDate(handle, input) {
      const tx = handle as Tx;
      const ref = await tx.query<{ schedule_id: string; source_revision: string }>(
        `select r.schedule_id, r.source_revision
           from authoritative_schedule_ref r
           join schedule s on s.schedule_id = r.schedule_id
          where r.connection_id = $1 and s.store_id = $2 and s.business_date = $3`,
        [input.connectionId, input.storeId, input.businessDate],
      );
      const found = ref.rows[0];
      if (!found) return "NOT_ADOPTED";

      const { rows } = await tx.query<AssignmentRow>(
        `select a.shift_assignment_id, a.staff_id, a.role_code, a.start_at, a.end_at,
                a.status, a.source_case_id,
                to_char(s.business_date, 'YYYY-MM-DD') as business_date, s.schedule_id
           from shift_assignment a
           join schedule s on s.schedule_id = a.schedule_id
          where a.schedule_id = $1
          order by a.shift_assignment_id`,
        [found.schedule_id],
      );

      return {
        scheduleId: found.schedule_id,
        storeId: input.storeId,
        businessDate: input.businessDate,
        sourceRevision: found.source_revision,
        assignments: rows.map(toAssignment),
      };
    },

    async listScheduled(handle, input) {
      const tx = handle as Tx;
      const { rows } = await tx.query<AssignmentRow>(
        `select a.shift_assignment_id, a.staff_id, a.role_code, a.start_at, a.end_at,
                a.status, a.source_case_id,
                to_char(s.business_date, 'YYYY-MM-DD') as business_date, s.schedule_id
           from shift_assignment a
           join schedule s on s.schedule_id = a.schedule_id
           join authoritative_schedule_ref r
             on r.schedule_id = s.schedule_id and r.connection_id = $1
          where s.store_id = $2 and a.status = 'SCHEDULED' and a.start_at >= $3
          order by a.start_at, a.shift_assignment_id`,
        [input.connectionId, input.storeId, input.from],
      );
      return rows.map((row) => ({
        ...toAssignment(row),
        businessDate: row.business_date,
        scheduleId: row.schedule_id,
      }));
    },
  };
}
