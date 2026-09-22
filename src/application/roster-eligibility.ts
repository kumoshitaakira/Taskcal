/**
 * 名簿だけの候補列挙。**適格性検査ではない。**
 *
 * `EligibilityChecker`（`src/contracts/selection.ts`）の完全な実装は担当Bが
 * `src/domain/interval/` と `src/domain/selection/` で行う（未実装）。ここが見るのは
 * D01 のうち名簿の部分だけ：
 *
 *   - 同じ店舗・同じ職種・在籍中
 *   - 欠勤者本人を除く（D01）
 *   - 人数の上限（Q10：最大8人）
 *
 * **見ていないもの（担当B、未実装）**：
 *   - 本人の可能時間と、既存勤務を差し引いた空き（Q03の分断判定を含む）
 *   - 月次割当上限と、月内入力の完全性（Q06 / A09）
 *   - 同じ時間帯の勤務との重複
 *
 * したがってここが返すのは「打診してよい相手」ではなく「名簿上の同職種の在籍者」。
 * 打診の宛先としては使えるが、**選定・正式採用の根拠にはできない。**
 * `recheck` は未実装のまま `NOT_IMPLEMENTED` を投げる。正式採用の直前の再検査
 * （D08）を、検査していないのに通ったことにしないため。
 *
 * 過去の辞退を候補の順位の減点に使わない（AGENTS.md）。
 */

import "server-only";
import { MAX_STAFF } from "../config/mvp-policy";
import { ERROR_CODES, TaskcalError } from "../contracts/errors";
import type {
  EligibilityChecker,
  EligibilityInput,
  EligibilityRecheckResult,
  EligibleCandidate,
} from "../contracts/selection";
import type { TxHandle } from "../contracts/repository";
import type { Tx } from "../adapters/db/transaction";

/** 名簿だけの候補列挙。DBを読むため、取引ハンドルを取る。 */
export interface RosterEligibility {
  listEligible(
    tx: TxHandle,
    input: EligibilityInput & { connectionId: string },
  ): Promise<readonly EligibleCandidate[]>;
}

export function createRosterEligibility(): RosterEligibility {
  return {
    async listEligible(handle, input) {
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
        [input.storeId, input.requirement.roleCode, input.absentStaffId, input.connectionId],
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
        // 提示するのは必要枠そのもの。可能時間で切り詰めていない（未実装）。
        offeredStartAt: input.requirement.startAt,
        offeredEndAt: input.requirement.endAt,
      }));
    },
  };
}

/**
 * 正式採用の直前の再検査（D08）。**未実装。**
 *
 * 月次上限・可能時間・重複を検査できないため、成功を返さない。検査していない
 * ものを通ったことにすると、上限を超えた勤務を確定し得る（A09）。
 */
export function createUnimplementedEligibilityRecheck(): Pick<EligibilityChecker, "recheck"> {
  return {
    recheck(): EligibilityRecheckResult {
      throw new TaskcalError(
        ERROR_CODES.NOT_IMPLEMENTED,
        "適格性の再検査（可能時間・月次上限・重複）は未実装です（担当B）。正式採用へ進めません。",
      );
    },
  };
}
