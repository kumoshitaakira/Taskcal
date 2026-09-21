/**
 * 受信イベントの永続化と受信順の採番（A12 / A15、RFC-011 §4）。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、接続範囲を含む重複排除、同時受信でも順序が欠番なく単調であること、
 * 本人と確認できない受信を捨てずに保存すること。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InboundEvent } from "@/contracts/messaging-gateway";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write("\n[integration] DATABASE_URL が未設定のため、受信を確認していません。\n\n");
}

const CONNECTION = "mock:inbound";
const OTHER_CONNECTION = "mock:inbound-2";

describe.skipIf(!connectionString)("受信イベントの取り込み（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let receive: ReturnType<typeof import("@/application/receive-inbound-event").receiveInboundEvent>;

  const storeId = randomUUID();
  const staffId = randomUUID();
  const otherStaffId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const endpointKey = `staff:${randomUUID()}`;
  let caseId: string;
  let outreachId: string;

  function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
    const now = new Date().toISOString();
    return {
      provider: "mock",
      connectionId: CONNECTION,
      eventId: `evt-${randomUUID()}`,
      occurredAt: now,
      receivedAt: now,
      from: {
        provider: "mock",
        connectionId: CONNECTION,
        endpointKey,
        endpointVersion: 1,
      },
      body: "大丈夫です",
      channelVerified: false,
      ...overrides,
    };
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    const { receiveInboundEvent } = await import("@/application/receive-inbound-event");
    const { createPgInboundEventRepository } = await import("@/adapters/db/inbound-repository");
    const { createPgOutreachRepository } = await import("@/adapters/db/outreach-repository");

    receive = receiveInboundEvent({
      inbound: createPgInboundEventRepository(),
      outreaches: createPgOutreachRepository(),
    });

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '受信テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const id of [staffId, otherStaffId]) {
        await tx.query(
          `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
           values ($1, $2, '架空', 'FLOOR', 9600)`,
          [id, storeId],
        );
      }
      await tx.query(
        `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, '2026-09-27')`,
        [scheduleId, storeId],
      );
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR',
                 '2026-09-27T18:00:00+09:00', '2026-09-27T22:00:00+09:00', 'SCHEDULED')`,
        [absentShift, scheduleId, storeId, otherStaffId],
      );
    });
  });

  beforeEach(async () => {
    caseId = randomUUID();
    outreachId = randomUUID();
    await withTransaction(async (tx) => {
      await tx.query(`delete from inbound_event where connection_id in ($1, $2)`, [
        CONNECTION,
        OTHER_CONNECTION,
      ]);
      await tx.query(
        `delete from outreach_message where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from outreach where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query("delete from absence_case where store_id = $1", [storeId]);
      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, '2026-09-27', $5, $6, 'FLOOR',
                 '2026-09-27T18:00:00+09:00', '2026-09-27T22:00:00+09:00',
                 '2026-09-27T16:00:00+09:00', 'COORDINATING', 'run-inbound')`,
        [caseId, storeId, CONNECTION, scheduleId, absentShift, otherStaffId],
      );
      await tx.query(
        `insert into outreach
           (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
            endpoint_key, endpoint_version, offered_start_at, offered_end_at,
            state, anonymous_staff_ref)
         values ($1, $2, $3, 'mock', $4, $5, 1,
                 '2026-09-27T18:00:00+09:00', '2026-09-27T22:00:00+09:00',
                 'AWAITING_REPLY', 'staff-1')`,
        [outreachId, caseId, staffId, CONNECTION, endpointKey],
      );
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      await tx.query(`delete from inbound_event where connection_id in ($1, $2)`, [
        CONNECTION,
        OTHER_CONNECTION,
      ]);
      await tx.query(
        `delete from outreach_message where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query(
        `delete from outreach where case_id in
           (select case_id from absence_case where store_id = $1)`,
        [storeId],
      );
      await tx.query("delete from absence_case where store_id = $1", [storeId]);
      await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  it("宛先が一致した受信は案件へ結び付き、受信順が振られる", async () => {
    const result = await receive(event());
    expect(result).toMatchObject({
      ok: true,
      match: "NEW",
      senderIdentity: "VERIFIED_OUTREACH_TARGET",
      caseId,
      receivedSeq: 1,
    });

    const state = await withTransaction((tx) =>
      tx.query<{ state: string }>("select state from outreach where outreach_id = $1", [
        outreachId,
      ]),
    );
    expect(state.rows[0]?.state).toBe("ANSWERED");
  });

  it("受信順は案件内で1から単調に増える", async () => {
    await receive(event());
    await receive(event());
    const third = await receive(event());
    expect(third).toMatchObject({ receivedSeq: 3 });
  });

  it("A12：同時に届いても受信順が欠番なく一意に振られる", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => receive(event())));
    const seqs = results
      .map((r) => (r.ok ? r.receivedSeq : undefined))
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("A15：同じ provider イベントを二度保存しない（採番も消費しない）", async () => {
    const duplicate = event();
    const first = await receive(duplicate);
    const second = await receive(duplicate);
    expect(first).toMatchObject({ match: "NEW", receivedSeq: 1 });
    expect(second).toMatchObject({ match: "DUPLICATE", receivedSeq: 1 });

    const next = await receive(event());
    // 重複が採番を消費していれば 3 になる。
    expect(next).toMatchObject({ receivedSeq: 2 });
  });

  it("A15：接続が違えば同じ eventId でも別のイベントとして入る", async () => {
    const eventId = `evt-${randomUUID()}`;
    const first = await receive(event({ eventId }));
    const second = await receive(
      event({
        eventId,
        connectionId: OTHER_CONNECTION,
        from: {
          provider: "mock",
          connectionId: OTHER_CONNECTION,
          endpointKey,
          endpointVersion: 1,
        },
      }),
    );
    expect(first).toMatchObject({ match: "NEW" });
    // 宛先の接続が違うので打診とは結び付かないが、イベントとしては新規。
    expect(second).toMatchObject({ match: "NEW", senderIdentity: "UNMATCHED" });
  });

  it("A15：宛先の版が変わっていれば本人と確認できない。受信は捨てずに残す", async () => {
    const result = await receive(
      event({
        from: { provider: "mock", connectionId: CONNECTION, endpointKey, endpointVersion: 2 },
      }),
    );
    expect(result).toMatchObject({ ok: true, senderIdentity: "UNMATCHED" });
    expect(result.ok && result.caseId).toBeUndefined();

    const stored = await withTransaction((tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from inbound_event where connection_id = $1",
        [CONNECTION],
      ),
    );
    expect(stored.rows[0]?.n).toBe(1);

    // 本人と確認できないので打診の状態は動かさない。
    const state = await withTransaction((tx) =>
      tx.query<{ state: string }>("select state from outreach where outreach_id = $1", [
        outreachId,
      ]),
    );
    expect(state.rows[0]?.state).toBe("AWAITING_REPLY");
  });

  it("本文の無いイベントは返信として扱わない（記録はする）", async () => {
    const result = await receive(event({ body: undefined }));
    expect(result).toMatchObject({ ok: true, senderIdentity: "VERIFIED_OUTREACH_TARGET" });

    const state = await withTransaction((tx) =>
      tx.query<{ state: string }>("select state from outreach where outreach_id = $1", [
        outreachId,
      ]),
    );
    expect(state.rows[0]?.state).toBe("AWAITING_REPLY");
  });

  it("案件へ結び付いた受信は不変のMessageとしても残る", async () => {
    await receive(event());
    const linked = await withTransaction((tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n
           from inbound_event e join outreach_message m on m.message_id = e.message_id
          where e.case_id = $1 and m.direction = 'INBOUND'`,
        [caseId],
      ),
    );
    expect(linked.rows[0]?.n).toBe(1);
  });

  it("D04：適用していない受信があることを検出できる", async () => {
    const { createPgInboundEventRepository } = await import("@/adapters/db/inbound-repository");
    const repo = createPgInboundEventRepository();

    expect(await withTransaction((tx) => repo.hasUnprocessed(tx, outreachId))).toBe(false);
    await receive(event());
    expect(await withTransaction((tx) => repo.hasUnprocessed(tx, outreachId))).toBe(true);

    await withTransaction((tx) =>
      tx.query("update outreach set last_applied_seq = 1 where outreach_id = $1", [outreachId]),
    );
    expect(await withTransaction((tx) => repo.hasUnprocessed(tx, outreachId))).toBe(false);
  });
});
