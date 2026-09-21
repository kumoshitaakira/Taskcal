/**
 * 受信イベントの永続化と、案件内の受信順の採番（RFC-011 §4）。
 *
 * 受信は**モデル処理の前に**保存する。返信順はモデル処理の完了時刻ではなく、
 * ここで採番した `receivedSeq` で決める（A12）。
 *
 * 採番は案件行のカウンタを `update ... returning` で進める。この文が案件行の排他
 * ロックを取るため、同じ案件への同時受信は直列化され、欠番も重複も出ない。
 * `max(received_seq) + 1` は使わない——read committed では二本が同じ値を読み、
 * 片方が必ず一意違反で落ちるうえ、再試行のたびに欠番が出る。
 */

import "server-only";
import { randomUUID } from "node:crypto";
import type { InboundEvent, PersistedInboundEvent } from "../../contracts/messaging-gateway";
import type {
  InboundEventRepository,
  PersistInboundResult,
  TxHandle,
} from "../../contracts/repository";
import type { Tx } from "./transaction";

interface ExistingRow {
  readonly inbound_event_id: string;
  readonly case_id: string | null;
  readonly received_seq: string | null;
  readonly message_id: string | null;
}

async function findExisting(tx: Tx, event: InboundEvent): Promise<ExistingRow | undefined> {
  const { rows } = await tx.query<ExistingRow>(
    `select inbound_event_id, case_id, received_seq, message_id
       from inbound_event
      where provider = $1 and connection_id = $2 and provider_event_id = $3`,
    [event.provider, event.connectionId, event.eventId],
  );
  return rows[0];
}

function linked(
  event: InboundEvent,
  row: { inboundEventId: string; caseId: string; receivedSeq: number; messageId: string },
  match: "NEW" | "DUPLICATE",
): PersistInboundResult {
  const stored: PersistedInboundEvent = {
    event,
    caseId: row.caseId,
    receivedSeq: row.receivedSeq,
  };
  return {
    linked: true,
    match,
    stored,
    inboundEventId: row.inboundEventId,
    messageId: row.messageId,
  };
}

export function createPgInboundEventRepository(): InboundEventRepository {
  return {
    async persist(handle: TxHandle, event: InboundEvent, resolved) {
      const tx = handle as Tx;

      // 1. 先に重複を確かめる。採番を消費しないため（欠番を出さない）。
      const existing = await findExisting(tx, event);
      if (existing) {
        if (existing.case_id && existing.received_seq && existing.message_id) {
          return linked(
            event,
            {
              inboundEventId: existing.inbound_event_id,
              caseId: existing.case_id,
              receivedSeq: Number(existing.received_seq),
              messageId: existing.message_id,
            },
            "DUPLICATE",
          );
        }
        return {
          linked: false,
          match: "DUPLICATE",
          inboundEventId: existing.inbound_event_id,
          senderIdentity: resolved.senderIdentity,
        };
      }

      const inboundEventId = randomUUID();

      // 2. 案件へ結び付く受信だけが順序を持つ。
      let receivedSeq: number | undefined;
      if (resolved.caseId) {
        const { rows } = await tx.query<{ received_seq: string }>(
          `update absence_case set next_inbound_seq = next_inbound_seq + 1
            where case_id = $1
           returning next_inbound_seq - 1 as received_seq`,
          [resolved.caseId],
        );
        if (rows[0]) receivedSeq = Number(rows[0].received_seq);
      }

      // 案件へ結び付いた受信は Message も同じ取引で作る。片方だけが残ると、
      // 解釈が参照する Message の無い受信ができる。
      const messageId = resolved.caseId ? randomUUID() : null;
      if (resolved.caseId && messageId) {
        await tx.query(
          `insert into outreach_message (message_id, case_id, outreach_id, direction, body)
           values ($1, $2, $3, 'INBOUND', $4)`,
          [messageId, resolved.caseId, resolved.outreachId ?? null, event.body ?? ""],
        );
      }

      // 1 と ここ の間に同じイベントが割り込んだ場合は一意違反になり、取引ごと
      // 巻き戻る。案件行のカウンタも戻るので、欠番は残らない。
      await tx.query(
        `insert into inbound_event
           (inbound_event_id, case_id, outreach_id, received_seq, provider, connection_id,
            provider_event_id, occurred_at, received_at, from_provider, from_connection_id,
            from_endpoint_key, from_endpoint_version, body, channel_verified, sender_identity,
            message_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          inboundEventId,
          resolved.caseId ?? null,
          resolved.outreachId ?? null,
          receivedSeq ?? null,
          event.provider,
          event.connectionId,
          event.eventId,
          event.occurredAt,
          event.receivedAt,
          event.from.provider,
          event.from.connectionId,
          event.from.endpointKey,
          event.from.endpointVersion,
          event.body ?? null,
          event.channelVerified,
          resolved.senderIdentity,
          messageId,
        ],
      );

      if (resolved.caseId && receivedSeq !== undefined && messageId) {
        return linked(
          event,
          { inboundEventId, caseId: resolved.caseId, receivedSeq, messageId },
          "NEW",
        );
      }

      return {
        linked: false,
        match: "NEW",
        inboundEventId,
        senderIdentity: resolved.senderIdentity,
      };
    },

    async findById(handle: TxHandle, inboundEventId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<{
        case_id: string | null;
        received_seq: string | null;
        provider: string;
        connection_id: string;
        provider_event_id: string;
        occurred_at: Date;
        received_at: Date;
        from_provider: string;
        from_connection_id: string;
        from_endpoint_key: string;
        from_endpoint_version: number;
        body: string | null;
        channel_verified: boolean;
      }>(
        `select case_id, received_seq, provider, connection_id, provider_event_id,
                occurred_at, received_at, from_provider, from_connection_id,
                from_endpoint_key, from_endpoint_version, body, channel_verified
           from inbound_event where inbound_event_id = $1`,
        [inboundEventId],
      );
      const row = rows[0];
      if (!row || !row.case_id || !row.received_seq) return "NOT_FOUND";
      return {
        event: {
          provider: row.provider,
          connectionId: row.connection_id,
          eventId: row.provider_event_id,
          occurredAt: row.occurred_at.toISOString(),
          receivedAt: row.received_at.toISOString(),
          from: {
            provider: row.from_provider,
            connectionId: row.from_connection_id,
            endpointKey: row.from_endpoint_key,
            endpointVersion: row.from_endpoint_version,
          },
          body: row.body ?? undefined,
          channelVerified: row.channel_verified,
        },
        caseId: row.case_id,
        receivedSeq: Number(row.received_seq),
      };
    },

    async hasUnprocessed(handle: TxHandle, outreachId: string) {
      const tx = handle as Tx;
      // 適用済みの受信順より後の受信があるか（D04 / A05）。
      const { rows } = await tx.query<{ pending: boolean }>(
        `select exists (
           select 1 from inbound_event e
             join outreach o on o.outreach_id = e.outreach_id
            where e.outreach_id = $1 and e.received_seq > o.last_applied_seq
         ) as pending`,
        [outreachId],
      );
      return rows[0]?.pending ?? false;
    },
  };
}
