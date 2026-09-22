/**
 * 模擬メッセージ受信箱（RFC-011 §6、作業U07）。
 *
 * `MessagingGateway` の実装。実在の連絡手段ではなく、架空スタッフ役の画面へ
 * メッセージを置くだけ。本番の本人認証・配送とは区別する（RFC-009 §2）。
 *
 * 守る規則：
 *   - 宛先の検査は `send` の内部で、外部作用の直前に行う。`verifyEndpoint` の
 *     結果に依存しない（検査と送信を分けると、その間が競合窓になる：A15）。
 *   - 宛先不一致・連絡不許可・内容不一致は `SendRefused`（**未送信**）。
 *     配送の失敗（`DeliveryState.FAILED`）と同じ欄に畳まない。
 *   - 同じ operationId・同じ内容は再送せず保存済み結果を `REPLAY` で返す。
 *   - 結果不明（`UNKNOWN`）を失敗として扱わない。照合するまで再送しない。
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import {
  ENDPOINT_CHECK,
  SEND_REFUSAL,
  type ContactEndpointRef,
  type EndpointCheck,
  type MessagingGateway,
  type SendCommand,
  type SendRefusal,
  type SendRefused,
  type SendResult,
} from "../../contracts/messaging-gateway";
import type { OperationId, RequestHash } from "../../contracts/operation";
import type { DeliveryState } from "../../contracts/outreach-state";
import type { OperationResultStore } from "../../contracts/repository";
import { withTransaction, type Tx } from "../db/transaction";

/**
 * 障害注入の設定。**デモと受入試験のためのものであり、本番の経路ではない。**
 * 実装が持つ状態ではなく、宛先ごとに `contact_endpoint.mock_fault_mode` で指定する。
 */
type MockFaultMode = "NONE" | "FAILED" | "UNKNOWN" | "LOOKUP_UNAVAILABLE";

interface EndpointRow {
  readonly staff_id: string;
  readonly endpoint_version: number;
  readonly contact_allowed: boolean;
  readonly mock_fault_mode: MockFaultMode;
}

/** 送信操作が属する案件と打診。宛先から推測せず、送信を積んだ側が持つ情報で解決する。 */
export interface SendTarget {
  readonly caseId: string;
  readonly outreachId?: string;
}

export interface MockInboxDeps {
  readonly operations: OperationResultStore;
  /**
   * 操作IDから送信先の案件・打診を引く。
   *
   * 宛先（provider/connectionId/endpointKey）から逆引きしない。同じ宛先が複数の
   * 案件に現れ得るため、どの案件のメッセージか推測することになる。送信を積んだ
   * 側（通知待ち）が持っている対応を使う。
   */
  readonly resolveTarget: (tx: Tx, operationId: OperationId) => Promise<SendTarget | undefined>;
}

/** 障害注入の設定から、送信後の配送状態と操作状態を決める。 */
function outcomeOf(mode: MockFaultMode): {
  delivery: DeliveryState;
  status: "SUCCEEDED" | "UNKNOWN";
} {
  switch (mode) {
    case "FAILED":
      // 送信を試みて失敗した。未送信（SendRefused）とは別。
      return { delivery: "FAILED", status: "SUCCEEDED" };
    case "UNKNOWN":
      // 結果不明。確定失敗として記録しない（AGENTS.md）。
      return { delivery: "UNKNOWN", status: "UNKNOWN" };
    case "NONE":
    case "LOOKUP_UNAVAILABLE":
      return { delivery: "ACCEPTED", status: "SUCCEEDED" };
  }
}

async function loadEndpoint(tx: Tx, to: ContactEndpointRef): Promise<EndpointRow | undefined> {
  // 送信の直前に現在の宛先を排他で読む。読んでから送るまでの間に版が変わらないよう、
  // 同じ取引でロックする。
  const { rows } = await tx.query<EndpointRow>(
    `select staff_id, endpoint_version, contact_allowed, mock_fault_mode
       from contact_endpoint
      where provider = $1 and connection_id = $2 and endpoint_key = $3
      for update`,
    [to.provider, to.connectionId, to.endpointKey],
  );
  return rows[0];
}

export function createMockMessagingGateway(deps: MockInboxDeps): MessagingGateway {
  return {
    async send(command: SendCommand): Promise<SendResult | SendRefused> {
      return withTransaction(async (tx: Tx) => {
        const begun = await deps.operations.begin(tx, {
          operation: command.operation,
          kind: "SEND_MESSAGE",
          connectionId: command.to.connectionId,
        });

        if (begun.match === "CONFLICT") {
          // 同じキーで内容が違う。**送信しない**（D07）。
          return { refused: SEND_REFUSAL.CONFLICT, detail: "同じ操作IDで内容が異なります" };
        }
        if (begun.match === "REPLAY") {
          const stored = begun.stored?.result as
            { state?: DeliveryState; messageId?: string; refused?: SendRefusal } | undefined;
          // 前回が拒否（未送信）なら、同じ拒否をそのまま返す。ここで UNKNOWN へ
          // すり替えると、未送信の項目が「結果不明」として恒久的に止まる。
          if (stored?.refused) {
            return { refused: stored.refused, detail: "同じ操作は前回送信していません" };
          }
          return {
            operation: command.operation,
            state: stored?.state ?? "UNKNOWN",
            match: "REPLAY",
            providerMessageId: stored?.messageId,
          };
        }

        const endpoint = await loadEndpoint(tx, command.to);
        if (!endpoint) {
          await deps.operations.complete(tx, {
            operationId: command.operation.operationId,
            status: "REFUSED",
            result: { refused: SEND_REFUSAL.ENDPOINT_CHANGED },
          });
          return { refused: SEND_REFUSAL.ENDPOINT_CHANGED, detail: "宛先が見つかりません" };
        }
        if (endpoint.endpoint_version !== command.to.endpointVersion) {
          // A15：打診時に固定した版と違う。旧打診を別人へ送らない。
          await deps.operations.complete(tx, {
            operationId: command.operation.operationId,
            status: "REFUSED",
            result: { refused: SEND_REFUSAL.ENDPOINT_CHANGED },
          });
          return { refused: SEND_REFUSAL.ENDPOINT_CHANGED, detail: "宛先の版が変わっています" };
        }
        if (!endpoint.contact_allowed) {
          await deps.operations.complete(tx, {
            operationId: command.operation.operationId,
            status: "REFUSED",
            result: { refused: SEND_REFUSAL.NOT_PERMITTED },
          });
          return { refused: SEND_REFUSAL.NOT_PERMITTED, detail: "連絡許可がありません" };
        }

        const target = await deps.resolveTarget(tx, command.operation.operationId);
        if (!target) {
          // 通知待ちに積まずに送ろうとしている。実装の不具合として止める。
          throw new TaskcalError(
            ERROR_CODES.INVALID_INPUT,
            "この操作IDに対応する送信予定がありません。",
          );
        }

        const messageId = randomUUID();
        const { delivery, status } = outcomeOf(endpoint.mock_fault_mode);
        const outreachId = target.outreachId ?? null;

        await tx.query(
          `insert into outreach_message (message_id, case_id, outreach_id, direction, kind, body)
           values ($1, $2, $3, 'OUTBOUND', $4, $5)`,
          [messageId, target.caseId, outreachId, command.kind, command.body],
        );
        await tx.query(
          `insert into message_delivery (operation_id, message_id, connection_id, state)
           values ($1, $2, $3, $4)`,
          [command.operation.operationId, messageId, command.to.connectionId, delivery],
        );

        if (delivery === "ACCEPTED") {
          // 受け付けたものだけがスタッフ役の受信箱に現れる。
          await tx.query(
            `insert into mock_inbox_item (inbox_item_id, message_id, staff_id, outreach_id, body)
             values ($1, $2, $3, $4, $5)`,
            [randomUUID(), messageId, endpoint.staff_id, outreachId, command.body],
          );
        }

        await deps.operations.complete(tx, {
          operationId: command.operation.operationId,
          status,
          result: { state: delivery, messageId },
        });

        return {
          operation: command.operation,
          state: delivery,
          match: "NEW",
          providerMessageId: messageId,
        };
      });
    },

    async getSendResult(ref: {
      operationId: OperationId;
      connectionId: string;
      expectedRequestHash?: RequestHash;
    }): Promise<SendResult | "LOOKUP_UNAVAILABLE" | "CONFLICT"> {
      return withTransaction(async (tx: Tx) => {
        const { rows } = await tx.query<{
          request_hash: string;
          op_status: string;
          state: DeliveryState | null;
          message_id: string | null;
          fault: MockFaultMode | null;
        }>(
          `select o.request_hash,
                  o.status as op_status,
                  d.state,
                  d.message_id,
                  -- 照会不能は**この操作の宛先**で判定する。接続に1件でもあれば
                  -- 返す形にすると、無関係な操作まで照会不能になる。
                  (select ce.mock_fault_mode
                     from contact_endpoint ce
                     join mock_inbox_item mi on mi.staff_id = ce.staff_id
                    where mi.message_id = d.message_id
                      and ce.connection_id = o.connection_id
                    limit 1) as fault
             from operation_result o
             left join message_delivery d on d.operation_id = o.operation_id
            where o.operation_id = $1 and o.connection_id = $2`,
          [ref.operationId, ref.connectionId],
        );

        const row = rows[0];
        if (!row) {
          // 模擬受信箱は自分の受信箱の権威なので、「記録が無い＝未送信」は
          // 確定した所見。照会不能ではない。
          return {
            operation: { operationId: ref.operationId, requestHash: ref.expectedRequestHash ?? "" },
            state: "QUEUED",
            match: "NEW",
          };
        }
        if (row.fault === "LOOKUP_UNAVAILABLE") {
          // 照会経路が使えない状況の再現。未採用・失敗と読み替えない。
          return "LOOKUP_UNAVAILABLE";
        }
        if (ref.expectedRequestHash && ref.expectedRequestHash !== row.request_hash) {
          return "CONFLICT";
        }
        return {
          operation: { operationId: ref.operationId, requestHash: row.request_hash },
          state: row.state ?? (row.op_status === "REFUSED" ? "QUEUED" : "UNKNOWN"),
          match: "REPLAY",
          providerMessageId: row.message_id ?? undefined,
        };
      });
    },

    async verifyEndpoint(ref: ContactEndpointRef): Promise<EndpointCheck> {
      // 画面表示・診断のための照会。**送信の前提条件にしない**（RFC-011 §6）。
      return withTransaction(async (tx: Tx) => {
        const endpoint = await loadEndpointForRead(tx, ref);
        if (!endpoint) return ENDPOINT_CHECK.UNVERIFIABLE;
        return endpoint.endpoint_version === ref.endpointVersion
          ? ENDPOINT_CHECK.MATCHES
          : ENDPOINT_CHECK.CHANGED;
      });
    },
  };
}

async function loadEndpointForRead(
  tx: Tx,
  to: ContactEndpointRef,
): Promise<EndpointRow | undefined> {
  const { rows } = await tx.query<EndpointRow>(
    `select staff_id, endpoint_version, contact_allowed, mock_fault_mode
       from contact_endpoint
      where provider = $1 and connection_id = $2 and endpoint_key = $3`,
    [to.provider, to.connectionId, to.endpointKey],
  );
  return rows[0];
}
