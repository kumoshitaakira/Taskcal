/**
 * 名簿の候補列挙。**適格性検査ではない。**
 *
 * D01 のうち名簿の部分だけを見る：
 *   - 同じ店舗・同じ職種・在籍中
 *   - 欠勤者本人を除く（D01）
 *   - 打診に使う宛先（接続範囲つき）
 *   - 人数の上限（Q10：最大8人）
 *
 * 時間・勤務条件上の適格性（同日の勤務との重複、月次上限）は、ここが返した名簿を
 * `outreach-eligibility.ts` が担当Bの規則（`evaluateCandidateEligibility`）へ通して
 * 決める。名簿の列挙と判定を分けているのは、判定を純粋関数に保つため（Q15と同じ）。
 *
 * 過去の辞退を候補の順位の減点に使わない（AGENTS.md）。順序は `staff_id` の昇順。
 */

import "server-only";
import { MAX_STAFF } from "../config/mvp-policy";
import { ERROR_CODES, TaskcalError } from "../contracts/errors";
import type { RosterCandidate } from "../contracts/selection";
import type { TxHandle } from "../contracts/repository";
import type { Tx } from "../adapters/db/transaction";

/** 名簿の候補列挙。DBを読むため、取引ハンドルを取る。 */
export interface RosterEligibility {
  listRoster(
    tx: TxHandle,
    input: {
      readonly storeId: string;
      readonly connectionId: string;
      readonly roleCode: string;
      readonly absentStaffId: string;
    },
  ): Promise<readonly RosterCandidate[]>;
}

export function createRosterEligibility(): RosterEligibility {
  return {
    async listRoster(handle, input) {
      const tx = handle as Tx;
      const { rows } = await tx.query<{
        staff_id: string;
        endpoint_key: string;
        endpoint_version: number;
      }>(
        `select s.staff_id, e.endpoint_key, e.endpoint_version
           from staff s
           join contact_endpoint e
             on e.staff_id = s.staff_id and e.connection_id = $4
          where s.store_id = $1
            and s.role_code = $2
            and s.active
            and s.staff_id <> $3
          order by s.staff_id`,
        [input.storeId, input.roleCode, input.absentStaffId, input.connectionId],
      );

      // Q10の8人はMVPの範囲の上限であって、黙って切る根拠ではない。
      // 超えたら範囲外として明示的に断る。切り捨てると、打診されなかった人が
      // 記録にも画面にも残らない（RFC-011 §2「適格な全員へ個別に打診」）。
      if (rows.length > MAX_STAFF) {
        throw new TaskcalError(
          ERROR_CODES.OUT_OF_SCOPE,
          `候補が${rows.length}人おり、MVPの上限${MAX_STAFF}人を超えています。`,
        );
      }

      return rows.map((row) => ({
        staffId: row.staff_id,
        endpointKey: row.endpoint_key,
        endpointVersion: row.endpoint_version,
      }));
    },
  };
}
