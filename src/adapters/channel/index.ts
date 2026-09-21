/**
 * 模擬メッセージ受信箱の組み立て。
 *
 * 送信先の案件・打診は通知待ち（`notification_outbox`）から引く。宛先から逆引き
 * すると、同じ宛先が複数の案件に現れたときにどの案件か推測することになる。
 */

import "server-only";
import type { OperationId } from "../../contracts/operation";
import type { MessagingGateway, OperationResultStore } from "../../contracts";
import type { Tx } from "../db/transaction";
import { createMockMessagingGateway, type SendTarget } from "./mock-inbox";

export { createMockMessagingGateway } from "./mock-inbox";
export type { MockInboxDeps, SendTarget } from "./mock-inbox";

async function resolveTargetFromOutbox(
  tx: Tx,
  operationId: OperationId,
): Promise<SendTarget | undefined> {
  const { rows } = await tx.query<{ case_id: string; outreach_id: string | null }>(
    "select case_id, outreach_id from notification_outbox where operation_id = $1",
    [operationId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { caseId: row.case_id, outreachId: row.outreach_id ?? undefined };
}

export function createDefaultMessagingGateway(deps: {
  operations: OperationResultStore;
}): MessagingGateway {
  return createMockMessagingGateway({
    operations: deps.operations,
    resolveTarget: resolveTargetFromOutbox,
  });
}
