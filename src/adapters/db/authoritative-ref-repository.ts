/**
 * 正式版参照の読み書き（RFC-010 §2・§5、D11、A01、A04）。
 *
 * 全ての照会・再起動・次案件はここから始める。勤務行を直接引かない。
 *
 * 差し替えは**期待版付きのCAS**で行う。直前のhash比較だけでは、その後に起きる変更を
 * 防げない（RFC-010 §5）。読んでから書くまでの間に別の採用が通った場合、`swap` が
 * 1行も更新せず `REVISION_CONFLICT` を返す。同じ旧版から作った二つの計画の一方だけが
 * 正式版になる（A04）。
 */

import "server-only";
import type {
  AuthoritativeRefSnapshot,
  AuthoritativeScheduleRefRepository,
  TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

interface RefRow {
  readonly connection_id: string;
  readonly schedule_id: string;
  readonly source_revision: string;
  readonly artifact_ref: string;
  readonly adopted_at: Date;
  readonly version: number;
  readonly adopted_by_schedule_update_id: string | null;
}

export function createPgAuthoritativeScheduleRefRepository(): AuthoritativeScheduleRefRepository {
  return {
    async get(handle: TxHandle, ref) {
      const tx = handle as Tx;
      const { rows } = await tx.query<RefRow>(
        `select connection_id, schedule_id, source_revision, artifact_ref, adopted_at,
                version, adopted_by_schedule_update_id
           from authoritative_schedule_ref
          where connection_id = $1 and schedule_id = $2`,
        [ref.connectionId, ref.scheduleId],
      );
      const row = rows[0];
      if (!row) return "NOT_FOUND" as const;
      return {
        connectionId: row.connection_id,
        scheduleId: row.schedule_id,
        sourceRevision: row.source_revision,
        artifactRef: row.artifact_ref,
        // 時刻は ISO 文字列で返す。Date のままだと computeRequestHash が拒否する。
        adoptedAt: row.adopted_at.toISOString(),
        version: row.version,
        adoptedByScheduleUpdateId: row.adopted_by_schedule_update_id ?? undefined,
      } satisfies AuthoritativeRefSnapshot;
    },

    async swap(handle: TxHandle, input) {
      const tx = handle as Tx;
      // 期待版と一致する行だけを更新する。0行なら、読んでから書くまでの間に
      // 別の採用が通っている（A04）。ここで止めないと二重採用になる。
      const { rowCount } = await tx.query(
        `update authoritative_schedule_ref
            set source_revision = $4,
                artifact_ref = $5,
                adopted_at = $6,
                version = version + 1,
                adopted_by_schedule_update_id = $7
          where connection_id = $1 and schedule_id = $2 and version = $3`,
        [
          input.connectionId,
          input.scheduleId,
          input.expectedVersion,
          input.sourceRevision,
          input.artifactRef,
          input.adoptedAt,
          input.adoptedByScheduleUpdateId,
        ],
      );
      return rowCount === 1 ? "UPDATED" : "REVISION_CONFLICT";
    },
  };
}
