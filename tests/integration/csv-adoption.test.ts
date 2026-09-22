/**
 * 正式採用の**本番経路**（RFC-010 §4、A01・A02・A16の一部、ADR-026）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * `adopt-plan.test.ts` は担当Bの口を台に差し替えて手順だけを確かめている。ここでは
 * **本物の CSV 管理版ストア**（一時ディレクトリ）と**本物の選定規則**（Q02）を通す。
 *
 * 見るのは：
 *   - 承諾3件（18〜20、20〜22、18〜22）から人数の少ない1人を選び、正式採用まで通ること
 *   - 正式版参照が新しい版へ進み、同月の他営業日の参照も一緒に進むこと（ADR-026 / A01）
 *   - 次の案件が新しい版を読み、今回の代替勤務と欠勤を見ること（A01）
 *   - 作業用成果物ができただけの版は、正式版参照から読んでも勤務に混ざらないこと（A02）
 *   - 重なる承諾しか無ければ採用せず、案件を終了させないこと（A16）
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCsvFixture, type CsvFixture } from "../stubs/csv-fixture";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、CSV経路の正式採用を確認していません。\n\n",
  );
}

const CONNECTION = "mock:csv-adopt";
const NOW = "2026-09-26T09:00:00+09:00";
const DEADLINE = "2026-09-26T16:00:00+09:00";
const BUSINESS_DATE = "2026-09-26";
const SHIFT_START = "2026-09-26T18:00:00+09:00";
const SHIFT_END = "2026-09-26T22:00:00+09:00";

describe.skipIf(!connectionString)("CSV経路の正式採用（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let adopt: ReturnType<typeof import("@/application/adopt-plan").adoptPlan>;
  let fixture: CsvFixture;

  const storeId = randomUUID();
  const absentStaff = randomUUID();
  const absentShift = randomUUID();
  /** 候補。a: 18〜20、b: 20〜22、c: 18〜22。 */
  const staffA = randomUUID();
  const staffB = randomUUID();
  const staffC = randomUUID();
  let caseId: string;
  let scheduleId: string;

  async function query<R extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const { rows } = await withTransaction((tx) => tx.query<R>(text, values));
    return rows;
  }

  async function insertCommitment(
    staffId: string,
    startAt: string,
    endAt: string,
    seq: number,
  ): Promise<string> {
    const outreachId = randomUUID();
    const messageId = randomUUID();
    const inboundId = randomUUID();
    const interpretationId = randomUUID();
    const commitmentId = randomUUID();
    await withTransaction(async (tx) => {
      await tx.query(
        `insert into outreach
           (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
            endpoint_key, endpoint_version, offered_start_at, offered_end_at,
            state, last_applied_seq, anonymous_staff_ref)
         values ($1, $2, $3, 'mock', $4, $5, 1, $6, $7, 'ANSWERED', $8, $9)`,
        [
          outreachId,
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
        [messageId, caseId, outreachId],
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
          outreachId,
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
            accepted_interpretation_id, role_code, start_at, end_at, status, source_received_seq)
         values ($1, $2, $3, $4, 1, $5, 'FLOOR', $6, $7, 'ACTIVE', $8)`,
        [commitmentId, caseId, staffId, outreachId, interpretationId, startAt, endAt, seq],
      );
    });
    return commitmentId;
  }

  async function cleanup(tx: import("@/adapters/db/transaction").Tx): Promise<void> {
    const cases = `(select case_id from absence_case where connection_id = $1)`;
    // 正式版参照は採用元の勤務表更新を参照する。先に消す（FKの向き）。
    await tx.query("delete from authoritative_schedule_ref where connection_id = $1", [CONNECTION]);
    await tx.query(
      `delete from selection_item where selection_id in
         (select selection_id from selection_result where case_id in ${cases})`,
      [CONNECTION],
    );
    await tx.query(`delete from schedule_update where case_id in ${cases}`, [CONNECTION]);
    await tx.query(`delete from selection_result where case_id in ${cases}`, [CONNECTION]);
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
    await tx.query(
      "delete from operation_result where connection_id = $1 or operation_id like 'adopt:%'",
      [CONNECTION],
    );
    await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    const { adoptPlan } = await import("@/application/adopt-plan");
    const { createEligibilityRecheck } = await import("@/application/eligibility-recheck");
    const { createSelectionPlanner } = await import("@/domain/selection");

    fixture = await createCsvFixture({
      connectionId: CONNECTION,
      storeId,
      month: "2026-09",
      roleCode: "FLOOR",
      staffIds: [absentStaff, staffA, staffB, staffC],
      shifts: [
        {
          shiftAssignmentId: absentShift,
          staffId: absentStaff,
          startAt: SHIFT_START,
          endAt: SHIFT_END,
        },
      ],
    });
    scheduleId = fixture.scheduleIdOf(BUSINESS_DATE);

    adopt = adoptPlan({
      cases: (await import("@/adapters/db/case-repository")).createPgAbsenceCaseRepository(),
      commitments: (
        await import("@/adapters/db/commitment-repository")
      ).createPgCommitmentRepository(),
      outreaches: (await import("@/adapters/db/outreach-repository")).createPgOutreachRepository(),
      inbound: (await import("@/adapters/db/inbound-repository")).createPgInboundEventRepository(),
      stores: (await import("@/adapters/db/store-repository")).createPgStoreRepository(),
      staff: (await import("@/adapters/db/store-repository")).createPgStaffRepository(),
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
      // **本物**の管理版ストア・選定規則・再検査。
      gateway: fixture.gateway,
      planner: createSelectionPlanner(),
      eligibility: createEligibilityRecheck(),
      clock: { now: () => NOW },
      ids: { next: () => randomUUID() },
    });

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, 'CSV採用テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const [i, id] of [absentStaff, staffA, staffB, staffC].entries()) {
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
      // 管理版と同じ勤務表IDで、対象月の全営業日を作る（ADR-026：参照は営業日単位）。
      for (const day of fixture.parsed.manifest.days ?? []) {
        await tx.query(
          `insert into schedule (schedule_id, store_id, business_date) values ($1, $2, $3)`,
          [day.scheduleId, storeId, day.date],
        );
      }
    });
  });

  beforeEach(async () => {
    caseId = randomUUID();
    await withTransaction(async (tx) => {
      await cleanup(tx);
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR', $5, $6, 'SCHEDULED')`,
        [absentShift, scheduleId, storeId, absentStaff, SHIFT_START, SHIFT_END],
      );
      for (const day of fixture.parsed.manifest.days ?? []) {
        await tx.query(
          `insert into authoritative_schedule_ref
             (connection_id, schedule_id, source_revision, artifact_ref, adopted_at, version)
           values ($1, $2, $3, $4, $5, 1)`,
          [CONNECTION, day.scheduleId, fixture.sourceRevision, fixture.artifactRef, NOW],
        );
      }
      await tx.query(
        `insert into absence_case
           (case_id, store_id, connection_id, schedule_id, business_date,
            absent_shift_assignment_id, absent_staff_id, role_code,
            required_start_at, required_end_at, deadline_at, state, run_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'FLOOR', $8, $9, $10, 'COORDINATING', 'run-csv')`,
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
    await fixture.cleanup();
  });

  it("A01：本物のCSV経路で正式採用し、同月の全営業日の参照が新しい版へ進み、次の案件がその版を読む", async () => {
    const a = await insertCommitment(
      staffA,
      "2026-09-26T18:00:00+09:00",
      "2026-09-26T20:00:00+09:00",
      1,
    );
    const b = await insertCommitment(
      staffB,
      "2026-09-26T20:00:00+09:00",
      "2026-09-26T22:00:00+09:00",
      2,
    );
    const c = await insertCommitment(staffC, SHIFT_START, SHIFT_END, 3);

    const result = await adopt({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    expect(result).toMatchObject({
      ok: true,
      outcome: "ADOPTED",
      adopted: 1,
      readBackMatches: true,
    });

    // Q02：人数の少ない計画（cの1人）を選び、a・bは非選定。
    const items = await query<{ commitment_id: string; selected: boolean }>(
      `select i.commitment_id, i.selected from selection_item i
         join selection_result r on r.selection_id = i.selection_id
        where r.case_id = $1 order by i.commitment_id`,
      [caseId],
    );
    expect(Object.fromEntries(items.map((row) => [row.commitment_id, row.selected]))).toEqual({
      [a]: false,
      [b]: false,
      [c]: true,
    });
    const selection = await query<{ rules_version: string; outcome: string }>(
      "select rules_version, outcome from selection_result where case_id = $1",
      [caseId],
    );
    expect(selection[0]).toMatchObject({ outcome: "FEASIBLE", rules_version: "exactly_one/1.0.0" });

    // 内部勤務表：代替勤務1件、元勤務は欠勤。
    const shifts = await query<{ staff_id: string; status: string }>(
      "select staff_id, status from shift_assignment where source_case_id = $1",
      [caseId],
    );
    expect(shifts).toEqual([{ staff_id: staffC, status: "SCHEDULED" }]);
    const absent = await query<{ status: string }>(
      "select status from shift_assignment where shift_assignment_id = $1",
      [absentShift],
    );
    expect(absent[0].status).toBe("ABSENT");

    // ADR-026：正式版参照は対象日だけでなく、同月の全営業日が同じ新版を指す。
    const refs = await query<{ source_revision: string; version: number; artifact_ref: string }>(
      "select source_revision, version, artifact_ref from authoritative_schedule_ref where connection_id = $1",
      [CONNECTION],
    );
    expect(refs).toHaveLength(30);
    const revisions = new Set(refs.map((r) => r.source_revision));
    expect(revisions.size).toBe(1);
    const [newRevision] = [...revisions];
    expect(newRevision).not.toBe(fixture.sourceRevision);
    expect(refs.every((r) => r.version === 2)).toBe(true);
    expect(refs.every((r) => r.artifact_ref === `revisions/${newRevision}`)).toBe(true);

    const update = await query<{ state: string; result_kind: string; artifact_ref: string }>(
      "select state, result_kind, artifact_ref from schedule_update where case_id = $1",
      [caseId],
    );
    expect(update[0]).toMatchObject({
      state: "ADOPTED",
      result_kind: "PREPARED",
      artifact_ref: `revisions/${newRevision}`,
    });
    expect(
      await query<{ state: string; adoption_fact: string }>(
        "select state, adoption_fact from absence_case where case_id = $1",
        [caseId],
      ),
    ).toEqual([{ state: "REPORTING", adoption_fact: "ADOPTED" }]);

    // A01：**別の営業日**の参照から次の案件が読む勤務表に、今回の代替勤務と欠勤が入っている。
    const nextDay = fixture.scheduleIdOf("2026-09-27");
    const nextRef = refs.find(() => true)!;
    const loaded = await fixture.gateway.loadSchedule({
      connectionId: CONNECTION,
      scheduleId: nextDay,
      authoritative: {
        scheduleId: nextDay,
        sourceRevision: nextRef.source_revision,
        artifactRef: nextRef.artifact_ref,
        adoptedAt: NOW,
      },
    });
    expect(loaded.assignments.map((row) => [row.staffId, row.status, row.sourceCaseId])).toEqual(
      expect.arrayContaining([
        [absentStaff, "ABSENT", undefined],
        [staffC, "SCHEDULED", caseId],
      ]),
    );
    // 管理版ストアの操作記録は照会で再生できる（A03の照会経路）。
    const lookedUp = await fixture.gateway.getUpdateResult({
      operationId:
        update[0] &&
        (
          await query<{ operation_id: string }>(
            "select operation_id from schedule_update where case_id = $1",
            [caseId],
          )
        )[0].operation_id,
      connectionId: CONNECTION,
    });
    expect(lookedUp).toMatchObject({ kind: "PREPARED", newSourceRevision: newRevision });
  });

  it("A16：重なる承諾しか無ければ採用せず、選定結果を残して調整中のまま据え置く", async () => {
    await insertCommitment(staffA, "2026-09-26T18:00:00+09:00", "2026-09-26T20:00:00+09:00", 1);
    await insertCommitment(staffC, "2026-09-26T19:00:00+09:00", SHIFT_END, 2);

    const result = await adopt({ operationId: `adopt:${caseId}:${randomUUID()}`, caseId });
    expect(result).toMatchObject({ ok: true, outcome: "NOT_FEASIBLE", reason: "OVERLAP" });
    expect(
      await query<{ state: string }>("select state from absence_case where case_id = $1", [caseId]),
    ).toEqual([{ state: "COORDINATING" }]);
    // 作業用成果物は作らない（選定が成立していないので applyUpdate に至らない）。
    expect(await query("select 1 from schedule_update where case_id = $1", [caseId])).toEqual([]);
    const refs = await query<{ source_revision: string }>(
      "select distinct source_revision from authoritative_schedule_ref where connection_id = $1",
      [CONNECTION],
    );
    expect(refs).toEqual([{ source_revision: fixture.sourceRevision }]);
  });

  it("A02：作業用成果物ができただけの版は、正式版参照から読む勤務表にも内部勤務表にも混ざらない", async () => {
    const { computeRequestHash } = await import("@/contracts/operation");
    const additions = [
      {
        shiftAssignmentId: randomUUID(),
        commitmentId: randomUUID(),
        staffId: staffA,
        roleCode: "FLOOR",
        startAt: SHIFT_START,
        endAt: SHIFT_END,
        sourceCaseId: caseId,
      },
    ];
    const absences = [{ shiftAssignmentId: absentShift, startAt: SHIFT_START, endAt: SHIFT_END }];
    const payload = {
      connectionId: CONNECTION,
      scheduleId,
      expectedSourceRevision: fixture.sourceRevision,
      additions,
      absences,
    };
    // 正式採用の手順3だけを行い、手順5〜6（採用取引）へ進まない状況。
    const prepared = await fixture.gateway.applyUpdate({
      operation: { operationId: `apply:${randomUUID()}`, requestHash: computeRequestHash(payload) },
      ...payload,
    });
    expect(prepared.kind).toBe("PREPARED");

    const ref = (
      await query<{ source_revision: string; artifact_ref: string }>(
        "select source_revision, artifact_ref from authoritative_schedule_ref where connection_id = $1 and schedule_id = $2",
        [CONNECTION, scheduleId],
      )
    )[0];
    expect(ref.source_revision).toBe(fixture.sourceRevision);
    const loaded = await fixture.gateway.loadSchedule({
      connectionId: CONNECTION,
      scheduleId,
      authoritative: {
        scheduleId,
        adoptedAt: NOW,
        ...ref,
        sourceRevision: ref.source_revision,
        artifactRef: ref.artifact_ref,
      },
    });
    expect(loaded.assignments.map((row) => row.shiftAssignmentId)).toEqual([absentShift]);
    expect(loaded.assignments[0].status).toBe("SCHEDULED");
    expect(
      await query("select 1 from shift_assignment where source_case_id = $1", [caseId]),
    ).toEqual([]);
  });
});
