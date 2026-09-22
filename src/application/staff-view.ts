/**
 * スタッフ役の画面の読み取りモデル。
 *
 * 模擬受信箱に届いたメッセージと、返信の投入先を返す。
 * **役の切替は本人認証ではない**（RFC-011 §6）。架空スタッフのローカルな切替であり、
 * 本番の本人確認とは別。
 */

import "server-only";
import { withTransaction } from "../adapters/db/transaction";

export interface InboxItemView {
  readonly inboxItemId: string;
  /** 返信対象の不変参照（RFC-011 §3）。どの打診への返信かをこれで決める。 */
  readonly messageId: string;
  readonly body: string;
  readonly receivedAt: string;
  readonly outreachId?: string;
  /** 返信の宛先。打診時に固定した版をそのまま使う（A15）。 */
  readonly endpoint?: {
    readonly provider: string;
    readonly connectionId: string;
    readonly endpointKey: string;
    readonly endpointVersion: number;
  };
}

export interface StaffView {
  readonly staffId: string;
  readonly name: string;
  readonly inbox: readonly InboxItemView[];
  readonly replies: readonly { body: string; receivedAt: string }[];
}

export async function getStaffViews(): Promise<readonly StaffView[]> {
  return withTransaction(async (tx) => {
    const staff = await tx.query<{ staff_id: string; display_name: string }>(
      `select s.staff_id, s.display_name from staff s
        where s.store_id = (select store_id from store order by created_at limit 1)
        order by s.display_name, s.staff_id`,
    );

    const views: StaffView[] = [];
    for (const row of staff.rows) {
      const inbox = await tx.query<{
        inbox_item_id: string;
        message_id: string;
        body: string;
        created_at: Date;
        outreach_id: string | null;
        endpoint_provider: string | null;
        endpoint_connection_id: string | null;
        endpoint_key: string | null;
        endpoint_version: number | null;
      }>(
        `select i.inbox_item_id, i.message_id, i.body, i.created_at, i.outreach_id,
                o.endpoint_provider, o.endpoint_connection_id,
                o.endpoint_key, o.endpoint_version
           from mock_inbox_item i
           left join outreach o on o.outreach_id = i.outreach_id
          where i.staff_id = $1
          order by i.created_at desc
          limit 10`,
        [row.staff_id],
      );

      const replies = await tx.query<{ body: string; received_at: Date }>(
        `select e.body, e.received_at from inbound_event e
           join outreach o on o.outreach_id = e.outreach_id
          where o.staff_id = $1 and e.body is not null
          order by e.received_at desc
          limit 10`,
        [row.staff_id],
      );

      views.push({
        staffId: row.staff_id,
        name: row.display_name,
        inbox: inbox.rows.map((item) => ({
          inboxItemId: item.inbox_item_id,
          messageId: item.message_id,
          body: item.body,
          receivedAt: item.created_at.toISOString(),
          outreachId: item.outreach_id ?? undefined,
          endpoint:
            item.endpoint_provider &&
            item.endpoint_connection_id &&
            item.endpoint_key &&
            item.endpoint_version !== null
              ? {
                  provider: item.endpoint_provider,
                  connectionId: item.endpoint_connection_id,
                  endpointKey: item.endpoint_key,
                  endpointVersion: item.endpoint_version,
                }
              : undefined,
        })),
        replies: replies.rows.map((reply) => ({
          body: reply.body,
          receivedAt: reply.received_at.toISOString(),
        })),
      });
    }
    return views;
  });
}
