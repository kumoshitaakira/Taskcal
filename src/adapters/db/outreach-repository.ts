/**
 * 打診の永続化（RFC-011 §2）。
 *
 * 宛先は打診時点の版まで固定して保存する。途中で宛先が変わっても、旧打診を
 * 別人へ送らない（A15、RFC-011 §6）。
 *
 * 遷移は `isAllowedOutreachTransition` を通し、期待版と一致する場合だけ書く。
 */

import "server-only";
import type { ContactEndpointRef } from "../../contracts/messaging-gateway";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import { isAllowedOutreachTransition, type OutreachState } from "../../contracts/outreach-state";
import type {
  CreateOutreachInput,
  OutreachRepository,
  OutreachSnapshot,
  TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

interface OutreachRow {
  readonly outreach_id: string;
  readonly case_id: string;
  readonly staff_id: string;
  readonly endpoint_provider: string;
  readonly endpoint_connection_id: string;
  readonly endpoint_key: string;
  readonly endpoint_version: number;
  readonly offered_start_at: Date;
  readonly offered_end_at: Date;
  readonly state: OutreachState;
  readonly version: number;
  readonly last_applied_seq: string;
  readonly anonymous_staff_ref: string;
  readonly created_at: Date;
}

const COLUMNS = `outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
  endpoint_key, endpoint_version, offered_start_at, offered_end_at, state, version,
  last_applied_seq, anonymous_staff_ref, created_at`;

function toSnapshot(row: OutreachRow): OutreachSnapshot {
  const endpoint: ContactEndpointRef = {
    provider: row.endpoint_provider,
    connectionId: row.endpoint_connection_id,
    endpointKey: row.endpoint_key,
    endpointVersion: row.endpoint_version,
  };
  return {
    outreachId: row.outreach_id,
    caseId: row.case_id,
    staffId: row.staff_id,
    endpoint,
    // 時刻は ISO 文字列で返す。Date のままだと computeRequestHash が拒否する。
    offeredStartAt: row.offered_start_at.toISOString(),
    offeredEndAt: row.offered_end_at.toISOString(),
    state: row.state,
    version: row.version,
    // bigint は pg が文字列で返す。案件内の受信順は number で扱う。
    lastAppliedSeq: Number(row.last_applied_seq),
    anonymousStaffRef: row.anonymous_staff_ref,
    createdAt: row.created_at.toISOString(),
  };
}

export function createPgOutreachRepository(): OutreachRepository {
  return {
    async create(handle: TxHandle, input: CreateOutreachInput) {
      const tx = handle as Tx;
      const { rows } = await tx.query<OutreachRow>(
        `insert into outreach
           (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
            endpoint_key, endpoint_version, offered_start_at, offered_end_at,
            state, anonymous_staff_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_SEND', $10)
         returning ${COLUMNS}`,
        [
          input.outreachId,
          input.caseId,
          input.staffId,
          input.endpoint.provider,
          input.endpoint.connectionId,
          input.endpoint.endpointKey,
          input.endpoint.endpointVersion,
          input.offeredStartAt,
          input.offeredEndAt,
          input.anonymousStaffRef,
        ],
      );
      return toSnapshot(rows[0]);
    },

    async listByCase(handle: TxHandle, caseId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<OutreachRow>(
        `select ${COLUMNS} from outreach where case_id = $1 order by created_at, outreach_id`,
        [caseId],
      );
      return rows.map(toSnapshot);
    },

    async findById(handle: TxHandle, outreachId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<OutreachRow>(
        `select ${COLUMNS} from outreach where outreach_id = $1`,
        [outreachId],
      );
      const row = rows[0];
      return row ? toSnapshot(row) : ("NOT_FOUND" as const);
    },

    async findByRepliedMessage(handle: TxHandle, messageId: string) {
      const tx = handle as Tx;
      // 送信したMessageは打診に属する。ここから引けば、同じ相手への過去の打診と
      // 現在の打診を取り違えない（RFC-011 §3）。送信（OUTBOUND）だけを対象にする。
      const { rows } = await tx.query<OutreachRow>(
        `select ${COLUMNS.split(",")
          .map((column) => `o.${column.trim()}`)
          .join(", ")}
           from outreach_message m
           join outreach o on o.outreach_id = m.outreach_id
          where m.message_id = $1 and m.direction = 'OUTBOUND'`,
        [messageId],
      );
      const row = rows[0];
      return row ? toSnapshot(row) : ("NOT_FOUND" as const);
    },

    async applyTransition(handle: TxHandle, input) {
      const tx = handle as Tx;
      const current = await this.findById(tx, input.outreachId);
      if (current === "NOT_FOUND") return "VERSION_CONFLICT";
      if (current.version !== input.expectedVersion) return "VERSION_CONFLICT";
      if (!isAllowedOutreachTransition(current.state, input.to)) {
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          `許可されていない打診の遷移です: ${current.state} -> ${input.to}`,
        );
      }
      const { rowCount } = await tx.query(
        `update outreach set state = $3, version = version + 1
          where outreach_id = $1 and version = $2`,
        [input.outreachId, input.expectedVersion, input.to],
      );
      return rowCount === 1 ? "UPDATED" : "VERSION_CONFLICT";
    },
  };
}
