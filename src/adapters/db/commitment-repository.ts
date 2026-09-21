/**
 * 承諾の永続化（RFC-011 §4）。
 *
 * 訂正で内容を上書きしない。旧版を `SUPERSEDED` にしてから、新しいIDと
 * `supersedes` を持つ行を作る。版番号は案件・スタッフ内で採番する。
 *
 * D04：同一案件・スタッフで `ACTIVE` は一つ。部分一意索引が最後に拒否する。
 */

import "server-only";
import {
  isAllowedCommitmentTransition,
  type Commitment,
  type CommitmentStatus,
} from "../../contracts/commitment";
import type {
  CommitmentRepository,
  CreateCommitmentInput,
  TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

interface CommitmentRow {
  readonly commitment_id: string;
  readonly case_id: string;
  readonly staff_id: string;
  readonly outreach_id: string;
  readonly version: number;
  readonly supersedes: string | null;
  readonly role_code: string;
  readonly start_at: Date;
  readonly end_at: Date;
  readonly status: CommitmentStatus;
  readonly accepted_interpretation_id: string;
  readonly source_received_seq: string;
  readonly created_at: Date;
}

const COLUMNS = `commitment_id, case_id, staff_id, outreach_id, version, supersedes,
  role_code, start_at, end_at, status, accepted_interpretation_id,
  source_received_seq, created_at`;

function toCommitment(row: CommitmentRow): Commitment {
  return {
    commitmentId: row.commitment_id,
    caseId: row.case_id,
    staffId: row.staff_id,
    outreachId: row.outreach_id,
    version: row.version,
    supersedes: row.supersedes ?? undefined,
    roleCode: row.role_code,
    // 時刻は ISO 文字列で返す。Date のままだと computeRequestHash が拒否する。
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    status: row.status,
    acceptedInterpretationId: row.accepted_interpretation_id,
    sourceReceivedSeq: Number(row.source_received_seq),
    createdAt: row.created_at.toISOString(),
  };
}

export function createPgCommitmentRepository(): CommitmentRepository {
  return {
    async createVersion(handle: TxHandle, input: CreateCommitmentInput) {
      const tx = handle as Tx;

      // 旧版を先に閉じる。D04 の部分一意索引があるため、順序を逆にすると落ちる。
      if (input.supersedes) {
        await tx.query(
          `update commitment set status = 'SUPERSEDED'
            where commitment_id = $1 and status in ('ACTIVE', 'HELD')`,
          [input.supersedes],
        );
      }

      const next = await tx.query<{ version: number }>(
        `select coalesce(max(version), 0) + 1 as version from commitment
          where case_id = $1 and staff_id = $2`,
        [input.caseId, input.staffId],
      );

      const { rows } = await tx.query<CommitmentRow>(
        `insert into commitment
           (commitment_id, case_id, staff_id, outreach_id, version, supersedes,
            accepted_interpretation_id, role_code, start_at, end_at, status,
            source_received_seq)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11)
         returning ${COLUMNS}`,
        [
          input.commitmentId,
          input.caseId,
          input.staffId,
          input.outreachId,
          next.rows[0]?.version ?? 1,
          input.supersedes ?? null,
          input.acceptedInterpretationId,
          input.roleCode,
          input.startAt,
          input.endAt,
          input.sourceReceivedSeq,
        ],
      );
      return toCommitment(rows[0]);
    },

    async listByCase(handle: TxHandle, caseId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<CommitmentRow>(
        `select ${COLUMNS} from commitment where case_id = $1
          order by staff_id, version`,
        [caseId],
      );
      return rows.map(toCommitment);
    },

    async changeStatus(handle: TxHandle, input) {
      const tx = handle as Tx;
      const current = await tx.query<{ status: CommitmentStatus }>(
        "select status from commitment where commitment_id = $1 for update",
        [input.commitmentId],
      );
      const status = current.rows[0]?.status;
      if (!status) return "NOT_ALLOWED";
      // 矢印だけで動かさない。終端からは戻さない。
      if (!isAllowedCommitmentTransition(status, input.to)) return "NOT_ALLOWED";

      await tx.query("update commitment set status = $2 where commitment_id = $1", [
        input.commitmentId,
        input.to,
      ]);
      return "UPDATED";
    },
  };
}
