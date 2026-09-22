/**
 * 正式版参照の読み書き（RFC-010 §2・§5、D11、A01、A04）。
 *
 * 全ての照会・再起動・次案件はここから始める。勤務行を直接引かない。
 *
 * 差し替えは**期待版付きのCAS**で行う。直前のhash比較だけでは、その後に起きる変更を
 * 防げない（RFC-010 §5）。読んでから書くまでの間に別の採用が通った場合、`swap` が
 * 1行も更新せず `REVISION_CONFLICT` を返す。同じ旧版から作った二つの計画の一方だけが
 * 正式版になる（A04）。
 *
 * 参照は営業日単位の行、CSVの管理版は月単位の成果物（ADR-026）。採用取引は対象日を
 * `swap` で切り替えた後、同月の他営業日を `advanceSiblings` で同じ版へ進める。
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

    async advanceSiblings(handle: TxHandle, input) {
      const tx = handle as Tx;
      const monthStart = `${input.month}-01`;
      const [year, index] = input.month.split("-").map(Number);
      const nextMonthStart =
        index === 12 ? `${year + 1}-01-01` : `${year}-${String(index + 1).padStart(2, "0")}-01`;
      // 旧版を指す同月の他営業日だけを進める。版も進める（A04：CASの前提）。
      const updated = await tx.query(
        `update authoritative_schedule_ref r
            set source_revision = $5,
                artifact_ref = $6,
                adopted_at = $7,
                version = r.version + 1,
                adopted_by_schedule_update_id = $8
           from schedule s
          where s.schedule_id = r.schedule_id
            and r.connection_id = $1
            and r.schedule_id <> $2
            and s.store_id = (select store_id from schedule where schedule_id = $2)
            and s.business_date >= $3 and s.business_date < $4
            and r.source_revision = $9`,
        [
          input.connectionId,
          input.scheduleId,
          monthStart,
          nextMonthStart,
          input.sourceRevision,
          input.artifactRef,
          input.adoptedAt,
          input.adoptedByScheduleUpdateId,
          input.fromSourceRevision,
        ],
      );
      // 新版以外を指す行が残っていれば、月内の参照が食い違っている。
      const stale = await tx.query<{ n: number }>(
        `select count(*)::int as n
           from authoritative_schedule_ref r
           join schedule s on s.schedule_id = r.schedule_id
          where r.connection_id = $1
            and s.store_id = (select store_id from schedule where schedule_id = $5)
            and s.business_date >= $2 and s.business_date < $3
            and r.source_revision <> $4`,
        [input.connectionId, monthStart, nextMonthStart, input.sourceRevision, input.scheduleId],
      );
      return { updated: updated.rowCount ?? 0, stale: stale.rows[0]?.n ?? 0 };
    },
  };
}
