/**
 * 模擬メッセージ受信箱（RFC-011 §6）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、未送信（SendRefused）と配送失敗（FAILED）の区別、送信の冪等、
 * 結果不明を失敗として扱わないこと（A15、A11、AGENTS.md）。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeRequestHash } from "@/contracts/operation";
import type { ContactEndpointRef, SendResult } from "@/contracts/messaging-gateway";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、模擬受信箱を確認していません。\n\n",
  );
}

const CONNECTION = "mock:test";

describe.skipIf(!connectionString)("模擬メッセージ受信箱（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let gateway: import("@/contracts").MessagingGateway;

  const storeId = randomUUID();
  const staffId = randomUUID();
  const scheduleId = randomUUID();
  const shiftId = randomUUID();
  const caseId = randomUUID();
  const outreachId = randomUUID();
  const endpointKey = `staff-${randomUUID()}`;

  const to: ContactEndpointRef = {
    provider: "mock",
    connectionId: CONNECTION,
    endpointKey,
    endpointVersion: 1,
  };

  /** 通知待ちへ積んでから送る。送信は必ずこの経路を通る。 */
  async function enqueueAndSend(input: {
    body: string;
    endpointVersion?: number;
    operationId?: string;
  }) {
    const operationId = input.operationId ?? `send-${randomUUID()}`;
    const target = { ...to, endpointVersion: input.endpointVersion ?? 1 };
    const requestHash = computeRequestHash({
      to: target,
      kind: "INITIAL_OFFER",
      body: input.body,
    });
    await withTransaction((tx) =>
      tx.query(
        `insert into notification_outbox
           (outbox_id, case_id, outreach_id, kind, body, operation_id, request_hash, connection_id)
         values ($1, $2, $3, 'INITIAL_OFFER', $4, $5, $6, $7)
         on conflict (operation_id) do nothing`,
        [randomUUID(), caseId, outreachId, input.body, operationId, requestHash, CONNECTION],
      ),
    );
    const result = await gateway.send({
      operation: { operationId, requestHash },
      to: target,
      kind: "INITIAL_OFFER",
      body: input.body,
    });
    return { operationId, requestHash, result };
  }

  async function setFaultMode(mode: string): Promise<void> {
    await withTransaction((tx) =>
      tx.query(
        `update contact_endpoint set mock_fault_mode = $2
          where provider = 'mock' and connection_id = $3 and endpoint_key = $1`,
        [endpointKey, mode, CONNECTION],
      ),
    );
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    const { createPgOperationResultStore } = await import("@/adapters/db/operation-result-store");
    const { createDefaultMessagingGateway } = await import("@/adapters/channel");
    gateway = createDefaultMessagingGateway({ operations: createPgOperationResultStore() });

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '模擬店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      await tx.query(
        `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
         values ($1, $2, '模擬スタッフ', 'FLOOR', 9600)`,
        [staffId, storeId],
      );
      await tx.query(
        `insert into contact_endpoint (provider, connection_id, endpoint_key, staff_id)
         values ('mock', $2, $1, $3)`,
        [endpointKey, CONNECTION, staffId],
      );
      await tx.query(
        `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, '2026-09-23')`,
        [scheduleId, storeId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR',
                 '2026-09-23T18:00:00+09:00', '2026-09-23T22:00:00+09:00', 'SCHEDULED')`,
        [shiftId, scheduleId, storeId, staffId],
      );
      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, '2026-09-23', $5, $6, 'FLOOR',
                 '2026-09-23T18:00:00+09:00', '2026-09-23T22:00:00+09:00',
                 '2026-09-23T16:00:00+09:00', 'COORDINATING', 'run-inbox')`,
        [caseId, storeId, CONNECTION, scheduleId, shiftId, staffId],
      );
      await tx.query(
        `insert into outreach
           (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
            endpoint_key, endpoint_version, offered_start_at, offered_end_at,
            state, anonymous_staff_ref)
         values ($1, $2, $3, 'mock', $4, $5, 1,
                 '2026-09-23T18:00:00+09:00', '2026-09-23T22:00:00+09:00',
                 'PENDING_SEND', 'staff-1')`,
        [outreachId, caseId, staffId, CONNECTION, endpointKey],
      );
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      await tx.query("delete from mock_inbox_item where staff_id = $1", [staffId]);
      await tx.query("delete from message_delivery where connection_id = $1", [CONNECTION]);
      await tx.query("delete from notification_outbox where case_id = $1", [caseId]);
      await tx.query("delete from outreach_message where case_id = $1", [caseId]);
      await tx.query("delete from outreach where case_id = $1", [caseId]);
      await tx.query("delete from absence_case where case_id = $1", [caseId]);
      await tx.query("delete from operation_result where connection_id = $1", [CONNECTION]);
      await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from contact_endpoint where connection_id = $1", [CONNECTION]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  it("受け付けられた送信はスタッフ役の受信箱に現れる", async () => {
    await setFaultMode("NONE");
    const { result } = await enqueueAndSend({ body: "9/23 18-22 お願いできますか" });
    expect(result).toMatchObject({ state: "ACCEPTED", match: "NEW" });

    const inbox = await withTransaction((tx) =>
      tx.query("select body from mock_inbox_item where staff_id = $1", [staffId]),
    );
    expect(inbox.rowCount).toBe(1);
  });

  it("同じ操作IDで同じ内容なら再送しない（REPLAY）", async () => {
    await setFaultMode("NONE");
    const operationId = `send-${randomUUID()}`;
    const first = await enqueueAndSend({ body: "重複の確認", operationId });
    expect(first.result).toMatchObject({ match: "NEW" });

    const second = await enqueueAndSend({ body: "重複の確認", operationId });
    expect(second.result).toMatchObject({ match: "REPLAY", state: "ACCEPTED" });

    const messages = await withTransaction((tx) =>
      tx.query("select 1 from outreach_message where case_id = $1 and body = '重複の確認'", [
        caseId,
      ]),
    );
    expect(messages.rowCount).toBe(1);
  });

  it("D07：同じ操作IDで内容が違えば送信しない", async () => {
    await setFaultMode("NONE");
    const operationId = `send-${randomUUID()}`;
    await enqueueAndSend({ body: "元の本文", operationId });
    const changed = await enqueueAndSend({ body: "差し替えた本文", operationId });

    expect(changed.result).toEqual({
      refused: "CONFLICT",
      detail: "同じ操作IDで内容が異なります",
    });
    const messages = await withTransaction((tx) =>
      tx.query("select 1 from outreach_message where case_id = $1 and body = '差し替えた本文'", [
        caseId,
      ]),
    );
    expect(messages.rowCount).toBe(0);
  });

  it("A15：宛先の版が変わっていれば送らない（未送信であり配送失敗ではない）", async () => {
    await setFaultMode("NONE");
    const { operationId, result } = await enqueueAndSend({
      body: "旧宛先へは送らない",
      endpointVersion: 99,
    });
    expect(result).toMatchObject({ refused: "ENDPOINT_CHANGED" });

    // 未送信なので配送の記録を作らない。FAILED と同じ欄に畳まない。
    const delivery = await withTransaction((tx) =>
      tx.query("select 1 from message_delivery where operation_id = $1", [operationId]),
    );
    expect(delivery.rowCount).toBe(0);
  });

  it("連絡許可が無ければ送らない（送信直前に検査する）", async () => {
    await withTransaction((tx) =>
      tx.query(
        `update contact_endpoint set contact_allowed = false
          where provider = 'mock' and connection_id = $2 and endpoint_key = $1`,
        [endpointKey, CONNECTION],
      ),
    );
    const { result } = await enqueueAndSend({ body: "許可が無い" });
    expect(result).toMatchObject({ refused: "NOT_PERMITTED" });
    await withTransaction((tx) =>
      tx.query(
        `update contact_endpoint set contact_allowed = true
          where provider = 'mock' and connection_id = $2 and endpoint_key = $1`,
        [endpointKey, CONNECTION],
      ),
    );
  });

  it("配送失敗は送信を試みた記録を残す（未送信と区別する）", async () => {
    await setFaultMode("FAILED");
    const { operationId, result } = await enqueueAndSend({ body: "配送に失敗する" });
    expect(result).toMatchObject({ state: "FAILED", match: "NEW" });

    const delivery = await withTransaction((tx) =>
      tx.query<{ state: string }>("select state from message_delivery where operation_id = $1", [
        operationId,
      ]),
    );
    expect(delivery.rows[0]?.state).toBe("FAILED");

    // 届いていないので受信箱には現れない。
    const inbox = await withTransaction((tx) =>
      tx.query("select 1 from mock_inbox_item where body = '配送に失敗する'"),
    );
    expect(inbox.rowCount).toBe(0);
    await setFaultMode("NONE");
  });

  it("結果不明を確定失敗として記録しない。照会で同じ状態が返る", async () => {
    await setFaultMode("UNKNOWN");
    const { operationId, requestHash, result } = await enqueueAndSend({ body: "結果が分からない" });
    expect(result).toMatchObject({ state: "UNKNOWN" });

    await setFaultMode("NONE");
    const looked = await gateway.getSendResult({
      operationId,
      connectionId: CONNECTION,
      expectedRequestHash: requestHash,
    });
    expect(looked).toMatchObject({ state: "UNKNOWN", match: "REPLAY" });
  });

  it("照会は内容ハッシュを照合し、不一致なら CONFLICT を返す", async () => {
    await setFaultMode("NONE");
    const { operationId } = await enqueueAndSend({ body: "照合の確認" });
    const looked = await gateway.getSendResult({
      operationId,
      connectionId: CONNECTION,
      expectedRequestHash: "f".repeat(64),
    });
    expect(looked).toBe("CONFLICT");
  });

  it("記録の無い操作の照会は未送信として返す（照会不能と区別する）", async () => {
    await setFaultMode("NONE");
    const looked = (await gateway.getSendResult({
      operationId: `send-${randomUUID()}`,
      connectionId: CONNECTION,
    })) as SendResult;
    expect(looked).toMatchObject({ state: "QUEUED", match: "NEW" });
  });

  it("照会経路が使えないときは LOOKUP_UNAVAILABLE を返す", async () => {
    await setFaultMode("NONE");
    const { operationId, requestHash } = await enqueueAndSend({ body: "照会できない" });
    await setFaultMode("LOOKUP_UNAVAILABLE");
    const looked = await gateway.getSendResult({
      operationId,
      connectionId: CONNECTION,
      expectedRequestHash: requestHash,
    });
    expect(looked).toBe("LOOKUP_UNAVAILABLE");
    await setFaultMode("NONE");
  });

  it("宛先の照合は表示用で、送信の可否そのものではない", async () => {
    await setFaultMode("NONE");
    expect(await gateway.verifyEndpoint(to)).toBe("MATCHES");
    expect(await gateway.verifyEndpoint({ ...to, endpointVersion: 99 })).toBe("CHANGED");
    expect(await gateway.verifyEndpoint({ ...to, endpointKey: "missing" })).toBe("UNVERIFIABLE");
  });
});
