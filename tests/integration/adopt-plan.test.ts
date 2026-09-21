/**
 * 正式採用の進行（RFC-010 §4、A02・A03・A04・A05・A07・A08・A13の一部）を
 * 実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、手順の結果が**DBの中でどう確定したか**。
 *   - 一部だけが正式勤務として残らないこと（A08）
 *   - 未採用の成果物を勤務として数えないこと（A02）
 *   - 結果不明を再実行せず、照会で照合すること（A03）
 *   - 同じ旧版からの二つの採用を、別キーでも通さないこと（A04）
 *   - 準備中に届いた訂正を採用直前に検知すること（A05）
 *   - 読戻しが一致しなければ完了にしないこと（A07）
 *   - 通知が止まっても確定済みの勤務と採用事実を消さないこと（A13）
 *
 * 選定そのもの（Q02の被覆・重複）は fake が担っており、**ここでは検査していない。**
 * A16・A17を確かめたことにしない。
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ScheduleGateway } from "@/contracts/schedule-gateway";
import type { ShiftAssignmentRepository } from "@/contracts/repository";
import { createFakeScheduleGateway } from "../fakes/schedule-gateway";
import { createFakeEligibilityRecheck, createFakeSelectionPlanner } from "../fakes/selection";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、正式採用を確認していません。\n\n",
  );
}

const CONNECTION = "mock:adopt";
const REVISION = "seed:2026-09:adopt";
const NOW = "2026-09-26T09:00:00+09:00";
const DEADLINE = "2026-09-26T16:00:00+09:00";
const SHIFT_START = "2026-09-26T18:00:00+09:00";
const SHIFT_END = "2026-09-26T22:00:00+09:00";
const BUSINESS_DATE = "2026-09-26";

describe.skipIf(!connectionString)("正式採用（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let adoptPlan: typeof import("@/application/adopt-plan").adoptPlan;
  let settleReporting: typeof import("@/application/settle-reporting").settleReporting;
  let repos: {
    cases: import("@/contracts/repository").AbsenceCaseRepository;
    commitments: import("@/contracts/repository").CommitmentRepository;
    outreaches: import("@/contracts/repository").OutreachRepository;
    inbound: import("@/contracts/repository").InboundEventRepository;
    stores: import("@/contracts/repository").StoreRepository;
    selections: import("@/contracts/repository").SelectionResultRepository;
    scheduleUpdates: import("@/contracts/repository").ScheduleUpdateRepository;
    authoritative: import("@/contracts/repository").AuthoritativeScheduleRefRepository;
    assignments: ShiftAssignmentRepository;
    schedules: import("@/adapters/db/schedule-repository").ScheduleReadRepository;
    outbox: import("@/contracts/repository").OutboxRepository;
    operations: import("@/contracts/repository").OperationResultStore;
  };

  const storeId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const absentStaff = randomUUID();
  const candidates = [randomUUID(), randomUUID()];
  /** 打診は届いたが返信が無い相手。募集終了通知（Q07）の宛先になる。 */
  const silentStaff = randomUUID();
  let caseId: string;
  /** 打診ID・承諾ID。案件ごとに作り直す。 */
  let outreachIds: string[];
  let commitmentIds: string[];

  function build(options: {
    gateway?: ScheduleGateway;
    assignments?: ShiftAssignmentRepository;
    planner?: ReturnType<typeof createFakeSelectionPlanner>;
    eligibility?: ReturnType<typeof createFakeEligibilityRecheck>;
  }) {
    return adoptPlan({
      ...repos,
      assignments: options.assignments ?? repos.assignments,
      gateway: options.gateway ?? createFakeScheduleGateway({ sourceRevision: REVISION }),
      planner: options.planner ?? createFakeSelectionPlanner(),
      eligibility: options.eligibility ?? createFakeEligibilityRecheck(),
      clock: { now: () => NOW },
      ids: { next: () => randomUUID() },
    });
  }

  /** worker の1ステップ（採用の後始末）。 */
  function settle() {
    return settleReporting({
      cases: repos.cases,
      outbox: repos.outbox,
      scheduleUpdates: repos.scheduleUpdates,
      selections: repos.selections,
      schedules: repos.schedules,
    });
  }

  async function query<R extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const { rows } = await withTransaction((tx) => tx.query<R>(text, values));
    return rows;
  }

  async function additionalShifts(): Promise<{ staff_id: string; status: string }[]> {
    return query(
      `select staff_id, status from shift_assignment
        where source_case_id = $1 order by staff_id`,
      [caseId],
    );
  }

  async function caseRow(): Promise<{ state: string; adoption_fact: string; version: number }> {
    const rows = await query<{ state: string; adoption_fact: string; version: number }>(
      "select state, adoption_fact, version from absence_case where case_id = $1",
      [caseId],
    );
    return rows[0];
  }

  async function updateRow(): Promise<{ state: string; result_kind: string | null } | undefined> {
    const rows = await query<{ state: string; result_kind: string | null }>(
      "select state, result_kind from schedule_update where case_id = $1 order by created_at desc",
      [caseId],
    );
    return rows[0];
  }

  async function refRow(): Promise<{ version: number; source_revision: string }> {
    const rows = await query<{ version: number; source_revision: string }>(
      `select version, source_revision from authoritative_schedule_ref
        where connection_id = $1 and schedule_id = $2`,
      [CONNECTION, scheduleId],
    );
    return rows[0];
  }

  /** 準備が終わった後に届いた変更を模す。読戻しの直後、採用取引の直前に起きる。 */
  function gatewayWithSideEffect(
    gateway: ScheduleGateway,
    effect: () => Promise<void>,
  ): ScheduleGateway {
    return {
      ...gateway,
      async readBack(ref) {
        const result = await gateway.readBack(ref);
        await effect();
        return result;
      },
    };
  }

  /**
   * 片付け。**接続範囲で消す。** 店舗IDは実行ごとに変わるので、それだけで絞ると
   * 前回の実行が残した行へ二度と手が届かず、次回のFK削除がそこで落ちる。
   * 順序はFKの向きに従う（正式版参照 → 勤務表更新 → 操作結果）。
   */
  async function cleanup(tx: import("@/adapters/db/transaction").Tx): Promise<void> {
    const cases = `(select case_id from absence_case where connection_id = $1)`;
    await tx.query("delete from authoritative_schedule_ref where connection_id = $1", [CONNECTION]);
    await tx.query(
      `delete from selection_item where selection_id in
         (select selection_id from selection_result where case_id in ${cases})`,
      [CONNECTION],
    );
    await tx.query(`delete from schedule_update where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from selection_result where case_id in ${cases}`, [CONNECTION]);
    // 代替勤務は承諾を参照する。承諾より先に消す。
    await tx.query(`delete from shift_assignment where source_case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from commitment where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from reply_interpretation where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from inbound_event where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from notification_outbox where case_id in ${cases}`, [CONNECTION]);
    await tx.query(
      `delete from message_delivery where message_id in
         (select message_id from outreach_message where case_id in ${cases})`,
      [CONNECTION],
    );
    await tx.query(
      `delete from mock_inbox_item where message_id in
         (select message_id from outreach_message where case_id in ${cases})`,
      [CONNECTION],
    );
    await tx.query(`delete from outreach_message where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from outreach where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from case_processing_event where case_id in ${cases}`, [CONNECTION]);
    await tx.query("delete from absence_case where connection_id = $1", [CONNECTION]);
    // 案件の操作（ADOPT_PLAN）は接続範囲を持たない。IDの形で拾う。
    await tx.query(
      "delete from operation_result where connection_id = $1 or operation_id like 'adopt:%'",
      [CONNECTION],
    );
    await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    ({ adoptPlan } = await import("@/application/adopt-plan"));
    ({ settleReporting } = await import("@/application/settle-reporting"));

    repos = {
      cases: (await import("@/adapters/db/case-repository")).createPgAbsenceCaseRepository(),
      commitments: (
        await import("@/adapters/db/commitment-repository")
      ).createPgCommitmentRepository(),
      outreaches: (await import("@/adapters/db/outreach-repository")).createPgOutreachRepository(),
      inbound: (await import("@/adapters/db/inbound-repository")).createPgInboundEventRepository(),
      stores: (await import("@/adapters/db/store-repository")).createPgStoreRepository(),
      selections: (
        await import("@/adapters/db/selection-repository")
      ).createPgSelectionResultRepository(),
      scheduleUpdates: (
        await import("@/adapters/db/schedule-update-repository")
      ).createPgScheduleUpdateRepository(),
      authoritative: (
        await import("@/adapters/db/authoritative-ref-repository")
      ).createPgAuthoritativeScheduleRefRepository(),
      assignments: (
        await import("@/adapters/db/shift-assignment-repository")
      ).createPgShiftAssignmentRepository(),
      schedules: (
        await import("@/adapters/db/schedule-repository")
      ).createPgScheduleReadRepository(),
      outbox: (await import("@/adapters/db/outbox-repository")).createPgOutboxRepository(),
      operations: (
        await import("@/adapters/db/operation-result-store")
      ).createPgOperationResultStore(),
    };

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '採用テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const [i, id] of [absentStaff, ...candidates, silentStaff].entries()) {
        await tx.query(
          `insert into staff (staff_id, store_id, display_name, role_code, monthly_cap_minutes)
           values ($1, $2, $3, 'FLOOR', 9600)`,
          [id, storeId, `架空 ${i + 1}`],
        );
        await tx.query(
          `insert into contact_endpoint (provider, connection_id, endpoint_key, staff_id)
           values ('mock', $2, $1, $3)`,
          [`staff:${id}`, CONNECTION, id],
        );
      }
      await tx.query(
        `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, $3)`,
        [scheduleId, storeId, BUSINESS_DATE],
      );
    });
  });

  beforeEach(async () => {
    caseId = randomUUID();
    outreachIds = [randomUUID(), randomUUID()];
    commitmentIds = [randomUUID(), randomUUID()];

    await withTransaction(async (tx) => {
      await cleanup(tx);

      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR', $5, $6, 'SCHEDULED')`,
        [absentShift, scheduleId, storeId, absentStaff, SHIFT_START, SHIFT_END],
      );
      // D11：正式版参照から始める。参照が無い勤務表は「取り込んでいない」。
      await tx.query(
        `insert into authoritative_schedule_ref
           (connection_id, schedule_id, source_revision, artifact_ref, adopted_at, version)
         values ($1, $2, $3, 'var/test/base.csv', $4, 1)`,
        [CONNECTION, scheduleId, REVISION, NOW],
      );
      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'FLOOR', $8, $9, $10, 'COORDINATING', 'run-adopt')`,
        [
          caseId,
          storeId,
          CONNECTION,
          scheduleId,
          BUSINESS_DATE,
          absentShift,
          absentStaff,
          SHIFT_START,
          SHIFT_END,
          DEADLINE,
        ],
      );

      // 返信の無い相手。打診は届いている（AWAITING_REPLY）ので、募集終了通知の対象。
      await tx.query(
        `insert into outreach
           (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
            endpoint_key, endpoint_version, offered_start_at, offered_end_at,
            state, last_applied_seq, anonymous_staff_ref)
         values ($1, $2, $3, 'mock', $4, $5, 1, $6, $7, 'AWAITING_REPLY', 0, 'staff-9')`,
        [
          randomUUID(),
          caseId,
          silentStaff,
          CONNECTION,
          `staff:${silentStaff}`,
          SHIFT_START,
          SHIFT_END,
        ],
      );

      for (const [i, staffId] of candidates.entries()) {
        const messageId = randomUUID();
        const inboundId = randomUUID();
        const interpretationId = randomUUID();
        const seq = i + 1;
        await tx.query(
          `insert into outreach
             (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
              endpoint_key, endpoint_version, offered_start_at, offered_end_at,
              state, last_applied_seq, anonymous_staff_ref)
           values ($1, $2, $3, 'mock', $4, $5, 1, $6, $7, 'ANSWERED', $8, $9)`,
          [
            outreachIds[i],
            caseId,
            staffId,
            CONNECTION,
            `staff:${staffId}`,
            SHIFT_START,
            SHIFT_END,
            seq,
            `staff-${seq}`,
          ],
        );
        await tx.query(
          `insert into outreach_message (message_id, case_id, outreach_id, direction, kind, body)
           values ($1, $2, $3, 'OUTBOUND', 'INITIAL_OFFER', '打診')`,
          [messageId, caseId, outreachIds[i]],
        );
        await tx.query(
          `insert into inbound_event
             (inbound_event_id, case_id, outreach_id, received_seq, provider, connection_id,
              provider_event_id, occurred_at, received_at, from_provider, from_connection_id,
              from_endpoint_key, from_endpoint_version, body, channel_verified,
              sender_identity, message_id)
           values ($1, $2, $3, $4, 'mock', $5, $6, $7, $7, 'mock', $5, $8, 1, '大丈夫です',
                   true, 'VERIFIED_OUTREACH_TARGET', $9)`,
          [
            inboundId,
            caseId,
            outreachIds[i],
            seq,
            CONNECTION,
            `evt-${caseId}-${seq}`,
            NOW,
            `staff:${staffId}`,
            messageId,
          ],
        );
        await tx.query(
          `insert into reply_interpretation
             (interpretation_id, case_id, message_id, inbound_event_id, received_seq,
              case_version, request_id, output, masked_reply_text, applied)
           values ($1, $2, $3, $4, $5, 1, $6, '{}'::jsonb, '大丈夫です', 'APPLIED')`,
          [interpretationId, caseId, messageId, inboundId, seq, `req-${inboundId}`],
        );
        await tx.query(
          `insert into commitment
             (commitment_id, case_id, staff_id, outreach_id, version,
              accepted_interpretation_id, role_code, start_at, end_at, status,
              source_received_seq)
           values ($1, $2, $3, $4, 1, $5, 'FLOOR', $6, $7, 'ACTIVE', $8)`,
          [
            commitmentIds[i],
            caseId,
            staffId,
            outreachIds[i],
            interpretationId,
            SHIFT_START,
            SHIFT_END,
            seq,
          ],
        );
      }
    });
  });

  afterAll(async () => {
    await withTransaction(async (tx) => {
      await cleanup(tx);
      await tx.query("delete from schedule where store_id = $1", [storeId]);
      await tx.query("delete from contact_endpoint where connection_id = $1", [CONNECTION]);
      await tx.query("delete from staff where store_id = $1", [storeId]);
      await tx.query("delete from store where store_id = $1", [storeId]);
    });
    await closePool();
  });

  it("D06：正式採用は勤務・欠勤・正式版参照・採用事実・通知を同じ取引で確定させる", async () => {
    const gateway = createFakeScheduleGateway({ sourceRevision: REVISION });
    const result = await build({ gateway })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: true, outcome: "ADOPTED", adopted: 2 });
    expect(result.ok && result.outcome === "ADOPTED" && result.readBackMatches).toBe(true);

    const shifts = await additionalShifts();
    expect(shifts).toHaveLength(2);
    expect(shifts.every((row) => row.status === "SCHEDULED")).toBe(true);

    // 元勤務は欠勤。取消（CANCELLED）にしない。
    const absent = await query<{ status: string }>(
      "select status from shift_assignment where shift_assignment_id = $1",
      [absentShift],
    );
    expect(absent[0].status).toBe("ABSENT");

    // A04：正式版参照は期待版付きで1つだけ進む。
    const ref = await refRow();
    expect(ref.version).toBe(2);
    expect(ref.source_revision).not.toBe(REVISION);

    expect(await updateRow()).toMatchObject({ state: "ADOPTED" });
    // ADR-022：採用事実は案件状態と別に持つ。読戻しが一致したので通知処理中。
    expect(await caseRow()).toMatchObject({ state: "REPORTING", adoption_fact: "ADOPTED" });

    // Q07：確定通知だけでなく、非選定・募集終了も完了境界に含める。
    const outbox = await query<{ kind: string; n: number }>(
      "select kind, count(*)::int as n from notification_outbox where case_id = $1 group by kind",
      [caseId],
    );
    expect(Object.fromEntries(outbox.map((row) => [row.kind, row.n]))).toEqual({
      CONFIRMATION: 2,
      // 返信が無かった相手も待たせない（Q07）。
      CASE_CLOSED: 1,
    });
  });

  it("A02：準備が終わった後に停止した案件を正式採用しない（未採用の成果物を勤務として数えない）", async () => {
    const gateway = gatewayWithSideEffect(
      createFakeScheduleGateway({ sourceRevision: REVISION }),
      async () => {
        await withTransaction((tx) =>
          tx.query(
            `update absence_case set stop_cause = 'MANAGER_STOP', stopped_at = $2
              where case_id = $1`,
            [caseId, NOW],
          ),
        );
      },
    );

    const result = await build({ gateway })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: false, code: "CASE_STOPPED", outcome: "REJECTED" });
    // 未採用のCSVができていても、勤務は1件も作らない。
    expect(await additionalShifts()).toHaveLength(0);
    expect(await refRow()).toMatchObject({ version: 1, source_revision: REVISION });
    expect(await updateRow()).toMatchObject({ state: "REJECTED" });
    // Q13／ADR-022：店長停止は引き継ぎではなくキャンセル。
    expect(await caseRow()).toMatchObject({ state: "CANCELLED", adoption_fact: "NOT_ADOPTED" });
  });

  it("A03：更新の成否が不明なら再実行せず、照会で照合できるまで未採用と断定しない", async () => {
    const gateway = createFakeScheduleGateway({
      sourceRevision: REVISION,
      applyThrows: new Error("timeout"),
    });
    const run = build({ gateway });

    const first = await run({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    expect(first).toMatchObject({ ok: false, outcome: "RECONCILE_REQUIRED" });
    expect(gateway.calls.applyUpdate).toBe(1);
    expect(await updateRow()).toMatchObject({ state: "RECONCILE_REQUIRED" });
    // 未採用へ丸めない。確認できるまで成否不明のまま持つ。
    expect(await caseRow()).toMatchObject({
      state: "RECONCILE_REQUIRED",
      adoption_fact: "UNKNOWN",
    });

    const second = await run({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    expect(second).toMatchObject({ ok: false, outcome: "RECONCILE_REQUIRED" });
    // **再実行していない。** 照会だけを行う。
    expect(gateway.calls.applyUpdate).toBe(1);
    expect(gateway.calls.getUpdateResult).toBe(1);
    expect(await additionalShifts()).toHaveLength(0);
  });

  it("A04の一部：同じ旧版からの二つ目の採用を、DBの制約が別の操作キーでも拒む", async () => {
    // **`adoptPlan` を2本走らせてはいない。** ここで確かめているのは、二重採用を
    // 止める最後の砦（部分一意索引と期待版付きCAS）であって、アプリ経路の競合ではない。
    await build({})({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    const adoptedRef = await refRow();
    expect(adoptedRef.version).toBe(2);

    await withTransaction(async (tx) => {
      // 別の操作キーで作った、同じ案件の二つ目の更新。
      const second = randomUUID();
      const selection = (
        await tx.query<{ selection_id: string }>(
          "select selection_id from selection_result where case_id = $1",
          [caseId],
        )
      ).rows[0].selection_id;
      await tx.query(
        `insert into operation_result (operation_id, request_hash, operation_kind, status)
         values ($1, repeat('a', 64), 'APPLY_UPDATE', 'IN_PROGRESS')`,
        [`apply:other:${second}`],
      );
      await repos.scheduleUpdates.create(tx, {
        scheduleUpdateId: second,
        caseId,
        caseVersion: 99,
        selectionId: selection,
        operationId: `apply:other:${second}`,
        connectionId: CONNECTION,
        scheduleId,
        expectedSourceRevision: REVISION,
      });
      await repos.scheduleUpdates.advance(tx, { scheduleUpdateId: second, to: "PREPARED" });

      // D05：1案件で採用する計画は一つ。部分一意索引が二つ目を拒否する。
      const advanced = await repos.scheduleUpdates.advance(tx, {
        scheduleUpdateId: second,
        to: "ADOPTED",
        adoptedAt: NOW,
      });
      expect(advanced).toBe("ALREADY_ADOPTED");

      // 旧版を期待して差し替えようとしても1行も更新されない。
      const swapped = await repos.authoritative.swap(tx, {
        connectionId: CONNECTION,
        scheduleId,
        expectedVersion: 1,
        sourceRevision: "別の版",
        artifactRef: "var/test/other.csv",
        adoptedAt: NOW,
        adoptedByScheduleUpdateId: second,
      });
      expect(swapped).toBe("REVISION_CONFLICT");
    });

    expect(await refRow()).toMatchObject({ version: 2 });
    expect(await additionalShifts()).toHaveLength(2);
  });

  it("A05：準備中に届いた未処理の返信を、正式採用の直前に検知する", async () => {
    const gateway = gatewayWithSideEffect(
      createFakeScheduleGateway({ sourceRevision: REVISION }),
      async () => {
        // 訂正が届いたが、まだ解釈を適用していない（received_seq > last_applied_seq）。
        await withTransaction((tx) =>
          tx.query(
            `insert into inbound_event
               (inbound_event_id, case_id, outreach_id, received_seq, provider, connection_id,
                provider_event_id, occurred_at, received_at, from_provider, from_connection_id,
                from_endpoint_key, from_endpoint_version, body, channel_verified,
                sender_identity, message_id)
             select $1, $2, m.outreach_id, 99, 'mock', $3, $4, $5, $5, 'mock', $3,
                    'staff:x', 1, 'やっぱり20時から', true, 'VERIFIED_OUTREACH_TARGET', m.message_id
               from outreach_message m
              where m.outreach_id = $6 and m.direction = 'OUTBOUND'`,
            [randomUUID(), caseId, CONNECTION, `evt-late-${caseId}`, NOW, outreachIds[0]],
          ),
        );
      },
    );

    const result = await build({ gateway })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: false, code: "REVISION_CONFLICT", outcome: "REJECTED" });
    expect(await additionalShifts()).toHaveLength(0);
    expect(await updateRow()).toMatchObject({ state: "REJECTED" });
    // A16：不成立だけで案件を終了しない。調整中へ戻す。
    expect(await caseRow()).toMatchObject({ state: "COORDINATING", adoption_fact: "NOT_ADOPTED" });
  });

  it("A07の一部：読戻しが一致しない成果物を採用せず、完了にもしない", async () => {
    const gateway = createFakeScheduleGateway({
      sourceRevision: REVISION,
      // 1件だけ落として返す。件数の検査が拾う。
      readBackOverride: (expected) => expected.slice(1),
    });

    const result = await build({ gateway })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: false, outcome: "REJECTED" });
    expect(await additionalShifts()).toHaveLength(0);
    expect(await refRow()).toMatchObject({ version: 1 });
    expect(await updateRow()).toMatchObject({ state: "REJECTED" });
    expect((await caseRow()).state).not.toBe("COMPLETED");
  });

  it("A08：採用取引の途中で失敗したら、一部だけを正式勤務にしない", async () => {
    let inserted = 0;
    const failing: ShiftAssignmentRepository = {
      ...repos.assignments,
      async addAdditional(tx, input) {
        inserted += 1;
        // 2件目で落とす。1件目はすでに insert 済み。
        if (inserted === 2) throw new Error("保存に失敗しました");
        return repos.assignments.addAdditional(tx, input);
      },
    };

    await expect(
      build({ assignments: failing })({
        operationId: `adopt:${caseId}:${randomUUID()}`,
        caseId,
      }),
    ).rejects.toThrow();

    // 1件目の insert も残っていないこと。取引ごと巻き戻る。
    expect(await additionalShifts()).toHaveLength(0);
    expect(await refRow()).toMatchObject({ version: 1 });
    const update = await updateRow();
    expect(update?.state).toBe("PREPARED");
    expect(await caseRow()).toMatchObject({ state: "PREPARING", adoption_fact: "NOT_ADOPTED" });
  });

  it("A13の一部：通知が止まっても確定済みの勤務と採用事実を消さない", async () => {
    await build({})({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    await withTransaction((tx) =>
      tx.query(
        `update notification_outbox set status = 'FAILED' where case_id = $1
          and outbox_id = (select outbox_id from notification_outbox
                            where case_id = $1 order by created_at limit 1)`,
        [caseId],
      ),
    );

    const outcome = await settle()();
    expect(outcome).toMatchObject({ handled: true, to: "ATTENTION" });

    // D09：勤務を取り消さない。採用事実も保持する。「未確定」と表示しない。
    expect(await additionalShifts()).toHaveLength(2);
    expect(await caseRow()).toMatchObject({ state: "ATTENTION", adoption_fact: "ADOPTED" });
    expect(await updateRow()).toMatchObject({ state: "ADOPTED" });
  });

  it("Q07：必要な通知をすべて送れたら完了させる", async () => {
    await build({})({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    await withTransaction((tx) =>
      tx.query("update notification_outbox set status = 'SENT' where case_id = $1", [caseId]),
    );

    const outcome = await settle()();
    expect(outcome).toMatchObject({ handled: true, to: "COMPLETED" });
    expect(await caseRow()).toMatchObject({ state: "COMPLETED", adoption_fact: "ADOPTED" });
  });

  it("A16の入口：実行可能な計画が無くても、選定結果を残して調整中のまま据え置く", async () => {
    const planner = createFakeSelectionPlanner({ notFeasible: "NOT_COVERED" });
    const result = await build({ planner })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: true, outcome: "NOT_FEASIBLE", reason: "NOT_COVERED" });
    // 承諾0件の評価でも残す。なぜ選べなかったかを後から説明できるように。
    const saved = await query<{ outcome: string; not_feasible_reason: string }>(
      "select outcome, not_feasible_reason from selection_result where case_id = $1",
      [caseId],
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ outcome: "NOT_FEASIBLE", not_feasible_reason: "NOT_COVERED" });
    expect(await caseRow()).toMatchObject({ state: "COORDINATING" });
    expect(await additionalShifts()).toHaveLength(0);
  });

  it("未実装のGatewayは未採用と確定させる。成否不明として照合待ちにしない", async () => {
    const { createUnimplementedScheduleGateway } =
      await import("@/adapters/csv/unimplemented-schedule-gateway");
    const result = await build({ gateway: createUnimplementedScheduleGateway() })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: false, code: "NOT_IMPLEMENTED" });
    // 何も作っていない。案件は調整中のままで、照合待ちにしない。
    expect(await caseRow()).toMatchObject({ state: "COORDINATING", adoption_fact: "NOT_ADOPTED" });
    expect(await updateRow()).toBeUndefined();
    expect(await additionalShifts()).toHaveLength(0);
  });

  it("A03の続き：照会で確定できたら、そこから採用まで進む（未採用と断定しない）", async () => {
    // 1回目は成否不明。2回目の再開で照会が確定結果を返す。
    const gateway = createFakeScheduleGateway({
      sourceRevision: REVISION,
      applyThrows: new Error("timeout"),
      lookup: "PREPARED",
    });
    const run = build({ gateway });

    await run({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    expect(await caseRow()).toMatchObject({ state: "RECONCILE_REQUIRED" });

    const second = await run({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    expect(second).toMatchObject({ ok: true, outcome: "ADOPTED", adopted: 2 });
    // **再実行していない。** 照会で確定してから採用している。
    expect(gateway.calls.applyUpdate).toBe(1);
    expect(await additionalShifts()).toHaveLength(2);
    expect(await updateRow()).toMatchObject({ state: "ADOPTED" });
    expect(await caseRow()).toMatchObject({ state: "REPORTING", adoption_fact: "ADOPTED" });
  });

  it("A03：作成済みの更新を再開しても applyUpdate をやり直さない", async () => {
    const gateway = createFakeScheduleGateway({
      sourceRevision: REVISION,
      applyThrows: new Error("timeout"),
    });
    const run = build({ gateway });
    await run({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });

    // applyUpdate の直後にプロセスが落ちた状態を作る。更新は PREPARING のまま、
    // 外部作用が起きたかどうかは分からない。
    await withTransaction((tx) =>
      tx.query(
        `update schedule_update set state = 'PREPARING', result_kind = null where case_id = $1`,
        [caseId],
      ),
    );

    const resumed = await run({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    expect(resumed).toMatchObject({ ok: false, outcome: "RECONCILE_REQUIRED" });
    // 未実行を確認できないので送り直さない。照会だけを行う。
    expect(gateway.calls.applyUpdate).toBe(1);
    expect(gateway.calls.getUpdateResult).toBeGreaterThan(0);
    expect(await additionalShifts()).toHaveLength(0);
  });

  it("A08：決定的な失敗で巻き戻したら、未採用として確定させる（同じ場所で止め続けない）", async () => {
    // 候補の一人に、必要枠と重なる別の勤務を先に入れておく。排他制約が採用取引を
    // 中断させる（ADR-006）。
    await withTransaction((tx) =>
      tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR', $5, $6, 'SCHEDULED')`,
        [randomUUID(), scheduleId, storeId, candidates[0], SHIFT_START, SHIFT_END],
      ),
    );

    const result = await build({})({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: false, outcome: "REJECTED" });
    // 一部だけ正式勤務にしない。もう一方の候補の勤務も残っていない。
    expect(await additionalShifts()).toHaveLength(0);
    expect(await refRow()).toMatchObject({ version: 1 });
    // **PREPARED のまま残さない。** 残すと決定的な失敗を毎回やり直して止まり続ける。
    expect(await updateRow()).toMatchObject({ state: "REJECTED" });
    expect(await caseRow()).toMatchObject({ state: "COORDINATING", adoption_fact: "NOT_ADOPTED" });
  });

  it("手順7の前に落ちた案件を、workerが読み直して進める（RFC-010 §4 手順7）", async () => {
    await build({})({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    // 採用取引は commit したが、手順7の前に落ちた状態を作る。
    await withTransaction((tx) =>
      tx.query("update absence_case set state = 'COMMITTED' where case_id = $1", [caseId]),
    );

    const outcome = await settle()();
    expect(outcome).toMatchObject({ handled: true, to: "VERIFIED" });
    expect(await caseRow()).toMatchObject({ state: "REPORTING", adoption_fact: "ADOPTED" });
    // 確定済みの勤務は触らない。
    expect(await additionalShifts()).toHaveLength(2);
  });

  it("Q07：非選定の相手と、返信の無かった相手にも通知を積む", async () => {
    // 2件の承諾のうち1件だけを選ぶ。残り1件は非選定、承諾の無い打診は募集終了。
    const thirdStaff = candidates[0];
    const result = await build({ planner: createFakeSelectionPlanner({ take: 1 }) })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });
    expect(result).toMatchObject({ ok: true, outcome: "ADOPTED", adopted: 1 });
    expect(thirdStaff).toBeTruthy();

    const outbox = await query<{ kind: string; n: number }>(
      "select kind, count(*)::int as n from notification_outbox where case_id = $1 group by kind",
      [caseId],
    );
    expect(Object.fromEntries(outbox.map((row) => [row.kind, row.n]))).toEqual({
      CONFIRMATION: 1,
      NOT_SELECTED: 1,
      CASE_CLOSED: 1,
    });

    // 辞退理由を尋ねない。非選定を次回の不利として伝えない（AGENTS.md）。
    const bodies = await query<{ kind: string; body: string }>(
      "select kind, body from notification_outbox where case_id = $1",
      [caseId],
    );
    const notSelected = bodies.find((row) => row.kind === "NOT_SELECTED");
    expect(notSelected?.body).toContain("次回の打診に影響しません");
    expect(notSelected?.body).not.toContain("理由");
  });

  it("月内入力が完全でなければ、採用の直前で止める（Q06 / A09）", async () => {
    const gateway = createFakeScheduleGateway({
      sourceRevision: REVISION,
      completeness: "INCOMPLETE",
      missingDates: ["2026-09-10"],
    });
    const result = await build({ gateway })({
      operationId: `adopt:${caseId}:${randomUUID()}`,
      caseId,
    });

    expect(result).toMatchObject({ ok: false, outcome: "REJECTED" });
    expect(await additionalShifts()).toHaveLength(0);
    // 欠けた日を0と推定しない。記録は残す。
    const saved = await query<{ monthly_completeness: string; missing_dates: string[] }>(
      "select monthly_completeness, missing_dates from selection_result where case_id = $1",
      [caseId],
    );
    expect(saved[0].monthly_completeness).toBe("INCOMPLETE");
  });
});
