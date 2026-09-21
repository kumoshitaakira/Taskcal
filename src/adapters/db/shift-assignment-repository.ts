/**
 * 内部勤務表への書込み（RFC-009 §3・§4、D05・D06、A08）。
 *
 * 通常勤務と代替勤務を同じ `shift_assignment` で持つ。代替勤務だけが生成元
 * （案件・承諾）を持つ。
 *
 * **採用取引の中で全件を入れる。** 制約違反は取引全体を中断させるため、内部で
 * SAVEPOINT を張って理由を返す。呼出し元は1件でも拒否されたら取引ごと巻き戻す
 * ——一部だけを正式勤務にしない（A08）。
 */

import "server-only";
import {
  ADD_ASSIGNMENT_REFUSAL,
  type AddAssignmentInput,
  type ShiftAssignmentRepository,
  type TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

/** 一意制約違反（D05：1つの承諾から作る勤務は1つ）。 */
const UNIQUE_VIOLATION = "23505";
/** 排他制約違反（ADR-006：同じスタッフの勤務が重なる）。 */
const EXCLUSION_VIOLATION = "23P01";

export function createPgShiftAssignmentRepository(): ShiftAssignmentRepository {
  return {
    async addAdditional(handle: TxHandle, input: AddAssignmentInput) {
      const tx = handle as Tx;
      await tx.query("savepoint add_assignment");
      try {
        await tx.query(
          `insert into shift_assignment
             (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
              start_at, end_at, status, source_case_id, source_commitment_id)
           values ($1, $2, $3, $4, $5, $6, $7, 'SCHEDULED', $8, $9)`,
          [
            input.shiftAssignmentId,
            input.scheduleId,
            input.storeId,
            input.staffId,
            input.roleCode,
            input.startAt,
            input.endAt,
            input.sourceCaseId,
            input.sourceCommitmentId,
          ],
        );
        await tx.query("release savepoint add_assignment");
        return "INSERTED";
      } catch (error) {
        await tx.query("rollback to savepoint add_assignment");
        const code = (error as { code?: string }).code;
        if (code === UNIQUE_VIOLATION) return ADD_ASSIGNMENT_REFUSAL.DUPLICATE_COMMITMENT;
        if (code === EXCLUSION_VIOLATION) return ADD_ASSIGNMENT_REFUSAL.OVERLAP;
        throw error;
      }
    },

    async markAbsent(handle: TxHandle, input) {
      const tx = handle as Tx;
      // ABSENT（勤務の枠は残るが本人は働かない）と CANCELLED（勤務自体が無くなった）を
      // 混同しない。月次上限は両方を除くが、再読込で区別が失われると集計が狂う。
      const { rowCount } = await tx.query(
        `update shift_assignment set status = 'ABSENT'
          where shift_assignment_id = $1 and status = 'SCHEDULED'`,
        [input.shiftAssignmentId],
      );
      return rowCount === 1 ? "UPDATED" : "NOT_SCHEDULED";
    },
  };
}
