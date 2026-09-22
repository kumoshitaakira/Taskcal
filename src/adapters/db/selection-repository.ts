/**
 * 選定結果の永続化（RFC-009 §3、D08）。
 *
 * **保存後に書き換えない。** 承諾0件の評価でも残す。書き換えると「なぜその計画に
 * したか」を後から説明できなくなり、正式採用直前の再検査（D08）が照合する相手を失う。
 *
 * 非選定の承諾も `selected = false` で残す。誰に非選定通知を出すかはここから決まる
 * （Q07）。承諾の版は保存時点の `commitment` 行から取る——呼出し元が別に持ち回ると、
 * ロックの外で読んだ古い版を書き込み得る。
 */

import "server-only";
import type { SelectionResultRepository, TxHandle } from "../../contracts/repository";
import type {
  SelectedCommitment,
  SelectionNotFeasibleReason,
  SelectionResult,
} from "../../contracts/selection";
import type { Tx } from "./transaction";

interface ResultRow {
  readonly selection_id: string;
  readonly case_id: string;
  readonly case_version: number;
  readonly rules_version: string;
  readonly outcome: SelectionResult["outcome"];
  readonly not_feasible_reason: SelectionNotFeasibleReason | null;
  readonly connection_id: string;
  readonly schedule_id: string;
  readonly source_revision: string;
  readonly monthly_completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  readonly missing_dates: string[];
  readonly decided_at: Date;
}

interface ItemRow {
  readonly commitment_id: string;
  readonly commitment_version: number;
  readonly selected: boolean;
  readonly planned_shift_assignment_id: string | null;
  readonly staff_id: string;
  readonly start_at: Date;
  readonly end_at: Date;
}

export function createPgSelectionResultRepository(): SelectionResultRepository {
  return {
    async save(handle: TxHandle, result: SelectionResult) {
      const tx = handle as Tx;
      await tx.query(
        `insert into selection_result
           (selection_id, case_id, case_version, rules_version, outcome, not_feasible_reason,
            connection_id, schedule_id, source_revision, monthly_completeness,
            missing_dates, decided_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date[], $12)`,
        [
          result.selectionId,
          result.caseId,
          result.caseVersion,
          result.rulesVersion,
          result.outcome,
          result.notFeasibleReason ?? null,
          result.inputs.connectionId,
          result.inputs.scheduleId,
          result.inputs.sourceRevision,
          result.inputs.monthlyCompleteness,
          [...result.inputs.missingDates],
          result.decidedAt,
        ],
      );

      for (const item of result.selected) {
        // 承諾の版は行から取る。呼出し元が持ち回った版を信用しない。
        await tx.query(
          `insert into selection_item
             (selection_id, commitment_id, commitment_version, selected,
              planned_shift_assignment_id)
           select $1, c.commitment_id, c.version, true, $3
             from commitment c where c.commitment_id = $2`,
          [result.selectionId, item.commitmentId, item.plannedShiftAssignmentId],
        );
      }
      for (const commitmentId of result.notSelectedCommitmentIds) {
        await tx.query(
          `insert into selection_item
             (selection_id, commitment_id, commitment_version, selected,
              planned_shift_assignment_id)
           select $1, c.commitment_id, c.version, false, null
             from commitment c where c.commitment_id = $2`,
          [result.selectionId, commitmentId],
        );
      }
    },

    async findById(handle: TxHandle, selectionId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<ResultRow>(
        // date[] を Date[] で受けるとローカル深夜として解釈され、JSTでは1日ずれる。
        // 営業日は SQL 側で文字列にする。
        `select selection_id, case_id, case_version, rules_version, outcome,
                not_feasible_reason, connection_id, schedule_id, source_revision,
                monthly_completeness,
                array(select to_char(d, 'YYYY-MM-DD') from unnest(missing_dates) d)
                  as missing_dates,
                decided_at
           from selection_result where selection_id = $1`,
        [selectionId],
      );
      const row = rows[0];
      if (!row) return "NOT_FOUND" as const;

      const items = await tx.query<ItemRow>(
        `select i.commitment_id, i.commitment_version, i.selected,
                i.planned_shift_assignment_id, c.staff_id, c.start_at, c.end_at
           from selection_item i
           join commitment c on c.commitment_id = i.commitment_id
          where i.selection_id = $1
          order by i.commitment_id`,
        [selectionId],
      );

      const selected: SelectedCommitment[] = items.rows
        .filter((item) => item.selected && item.planned_shift_assignment_id)
        .map((item) => ({
          commitmentId: item.commitment_id,
          commitmentVersion: item.commitment_version,
          staffId: item.staff_id,
          // 時刻は ISO 文字列で返す。Date のままだと computeRequestHash が拒否する。
          startAt: item.start_at.toISOString(),
          endAt: item.end_at.toISOString(),
          plannedShiftAssignmentId: item.planned_shift_assignment_id as string,
        }));

      return {
        selectionId: row.selection_id,
        caseId: row.case_id,
        caseVersion: row.case_version,
        rulesVersion: row.rules_version,
        outcome: row.outcome,
        notFeasibleReason: row.not_feasible_reason ?? undefined,
        inputs: {
          connectionId: row.connection_id,
          scheduleId: row.schedule_id,
          sourceRevision: row.source_revision,
          monthlyCompleteness: row.monthly_completeness,
          missingDates: row.missing_dates,
        },
        selected,
        notSelectedCommitmentIds: items.rows
          .filter((item) => !item.selected)
          .map((item) => item.commitment_id),
        decidedAt: row.decided_at.toISOString(),
      } satisfies SelectionResult;
    },
  };
}
