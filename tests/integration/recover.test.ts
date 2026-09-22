/**
 * 通知と照合の復旧（RFC-012 §5 A13・A03、ADR-022 / Q11・Q12・Q13）を実PostgreSQLで確かめる。
 *   docker compose up -d db && npm run migrate
 *
 * 見るのは、**確定できた事実だけで状態が動く**こと。
 *   - 結果不明の通知は、照会で送られたと確認できたときだけ `SENT` へ（A13）
 *   - 照会できないあいだは動かさない。**未送信と読み替えない**（A03）
 *   - `ATTENTION` から戻すのは、採用済みかつ読戻し一致のときだけ（Q12）
 *   - 照合が継続不能な `RECONCILE_REQUIRED` は `ATTENTION` へ。未採用と断定しない（Q11）
 *   - 停止を保留した `PREPARING` は、採用の成否を確かめてから行き先を決める（Q13）
 *   - 復旧しなくても確定済みの勤務と採用事実は消えない（D09）
 */

import { randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  LoadedAssignment,
  ScheduleGateway,
  SourceCapabilities,
  UpdateResult,
} from "@/contracts/schedule-gateway";
import type { UpdateResultKind } from "@/contracts/schedule-update";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write("\n[integration] DATABASE_URL が未設定のため、復旧を確認していません。\n\n");
}

const CONNECTION = "mock:recover";
const REVISION = "seed:2026-09:recover";
const NOW = "2026-09-26T09:00:00+09:00";
const DEADLINE = "2026-09-26T16:00:00+09:00";
const SHIFT_START = "2026-09-26T18:00:00+09:00";
const SHIFT_END = "2026-09-26T22:00:00+09:00";
const BUSINESS_DATE = "2026-09-26";
const HASH = "c".repeat(64);

type RecoverGateway = Pick<ScheduleGateway, "capabilities" | "getUpdateResult" | "readBack">;

/**
 * 照会と読戻しだけを持つ台。**正式採用は行わない。**
 *
 * `tests/stubs/fake-gateways.ts` の `FakeScheduleGateway` は `applyUpdate` を先に
 * 呼んだ操作の結果しか返さない。落ちた**後**から再開する経路はその前提を満たせない
 * ので、ここは照会と読戻しの結果だけを固定する。
 */
function stubGateway(options: {
  lookup?: UpdateResultKind | "LOOKUP_UNAVAILABLE" | "CONFLICT";
  supportsResultLookup?: boolean;
  readBack?: readonly LoadedAssignment[];
  readBackThrows?: boolean;
}): RecoverGateway & { calls: { getUpdateResult: number; readBack: number } } {
  const calls = { getUpdateResult: 0, readBack: 0 };
  const capabilities: SourceCapabilities = {
    canReadRevision: true,
    canConditionalUpdate: true,
    supportsIdempotencyKey: true,
    supportsResultLookup: options.supportsResultLookup ?? true,
    supportsAtomicBatch: true,
  };
  return {
    calls,
    capabilities,
    getUpdateResult(ref) {
      calls.getUpdateResult += 1;
      const lookup = options.lookup ?? "LOOKUP_UNAVAILABLE";
      if (lookup === "LOOKUP_UNAVAILABLE" || lookup === "CONFLICT") {
        return Promise.resolve(lookup);
      }
      const result: UpdateResult = {
        operation: { operationId: ref.operationId, requestHash: HASH },
        kind: lookup,
        revisionCheckEnforced: true,
        mappings: [],
      };
      return Promise.resolve(result);
    },
    readBack() {
      calls.readBack += 1;
      if (options.readBackThrows) return Promise.reject(new Error("成果物を読めません"));
      return Promise.resolve({
        artifactRef: "var/test/adopted.csv",
        sourceRevision: `${REVISION}+1`,
        assignments: options.readBack ?? [],
      });
    },
  };
}

describe.skipIf(!connectionString)("通知と照合の復旧（DATABASE_URL 必須）", () => {
  let closePool: () => Promise<void>;
  let withTransaction: typeof import("@/adapters/db/transaction").withTransaction;
  let reconcileOutbox: typeof import("@/application/reconcile-outbox").reconcileOutbox;
  let recoverCase: typeof import("@/application/recover-case").recoverCase;
  let messaging: import("@/contracts/messaging-gateway").MessagingGateway;
  let repos: {
    cases: import("@/contracts/repository").AbsenceCaseRepository;
    outreaches: import("@/contracts/repository").OutreachRepository;
    outbox: import("@/contracts/repository").OutboxRepository;
    scheduleUpdates: import("@/contracts/repository").ScheduleUpdateRepository;
    selections: import("@/contracts/repository").SelectionResultRepository;
    authoritative: import("@/contracts/repository").AuthoritativeScheduleRefRepository;
    schedules: import("@/adapters/db/schedule-repository").ScheduleReadRepository;
  };

  const storeId = randomUUID();
  const scheduleId = randomUUID();
  const absentShift = randomUUID();
  const absentStaff = randomUUID();
  const targetStaff = randomUUID();

  let caseId: string;
  let outreachId: string;

  function reconcile() {
    return reconcileOutbox({
      outbox: repos.outbox,
      outreaches: repos.outreaches,
      messaging,
      leaseMs: 60_000,
    });
  }

  function recover(gateway: RecoverGateway) {
    return recoverCase({
      cases: repos.cases,
      scheduleUpdates: repos.scheduleUpdates,
      selections: repos.selections,
      schedules: repos.schedules,
      authoritative: repos.authoritative,
      gateway,
      clock: { now: () => NOW },
    });
  }

  /** 自分の案件が処理されるまで回す。取り出しは接続範囲を持たないため。 */
  async function runUntilMine<T extends { handled: boolean }>(
    step: () => Promise<T>,
    mine: (outcome: T) => boolean,
  ): Promise<T | undefined> {
    for (let i = 0; i < 30; i += 1) {
      const outcome = await step();
      if (!outcome.handled) return undefined;
      if (mine(outcome)) return outcome;
    }
    return undefined;
  }

  async function query<R extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const { rows } = await withTransaction((tx) => tx.query<R>(text, values));
    return rows;
  }

  async function caseRow() {
    const rows = await query<{
      state: string;
      adoption_fact: string;
      handoff_reason: string | null;
    }>("select state, adoption_fact, handoff_reason from absence_case where case_id = $1", [
      caseId,
    ]);
    return rows[0];
  }

  async function updateRow() {
    const rows = await query<{ state: string }>(
      "select state from schedule_update where case_id = $1",
      [caseId],
    );
    return rows[0];
  }

  /** 結果不明のまま残った通知を作る。`delivery` を渡すと配送記録も置く。 */
  async function unknownNotification(options: {
    operationId: string;
    requestHash?: string;
    delivery?: "ACCEPTED" | "FAILED" | "UNKNOWN";
    faultMode?: "NONE" | "LOOKUP_UNAVAILABLE";
  }): Promise<string> {
    const outboxId = randomUUID();
    await withTransaction(async (tx) => {
      await tx.query(
        `insert into notification_outbox
           (outbox_id, case_id, outreach_id, kind, body, operation_id, request_hash,
            connection_id, status)
         values ($1, $2, $3, 'INITIAL_OFFER', '打診', $4, $5, $6, 'UNKNOWN')`,
        [
          outboxId,
          caseId,
          outreachId,
          options.operationId,
          options.requestHash ?? HASH,
          CONNECTION,
        ],
      );
      if (!options.delivery) return;
      const messageId = randomUUID();
      await tx.query(
        `insert into operation_result
           (operation_id, request_hash, operation_kind, connection_id, case_id, status)
         values ($1, $2, 'SEND_MESSAGE', $3, $4, $5)`,
        [
          options.operationId,
          options.requestHash ?? HASH,
          CONNECTION,
          caseId,
          options.delivery === "UNKNOWN" ? "UNKNOWN" : "SUCCEEDED",
        ],
      );
      await tx.query(
        `insert into outreach_message (message_id, case_id, outreach_id, direction, kind, body)
         values ($1, $2, $3, 'OUTBOUND', 'INITIAL_OFFER', '打診')`,
        [messageId, caseId, outreachId],
      );
      await tx.query(
        `insert into message_delivery (operation_id, message_id, connection_id, state, provider_message_id)
         values ($1, $2, $3, $4, $5)`,
        [options.operationId, messageId, CONNECTION, options.delivery, `mock-${messageId}`],
      );
      // 照会不能は宛先の設定で再現する（`mock-inbox.ts`）。受信箱の行が要る。
      await tx.query(
        `insert into mock_inbox_item (inbox_item_id, message_id, staff_id, outreach_id, body)
         values ($1, $2, $3, $4, '打診')`,
        [randomUUID(), messageId, targetStaff, outreachId],
      );
      await tx.query("update contact_endpoint set mock_fault_mode = $2 where connection_id = $1", [
        CONNECTION,
        options.faultMode ?? "NONE",
      ]);
    });
    return outboxId;
  }

  async function outboxRow(outboxId: string) {
    const rows = await query<{ status: string; message_id: string | null }>(
      "select status, message_id from notification_outbox where outbox_id = $1",
      [outboxId],
    );
    return rows[0];
  }

  /**
   * 採用済みの案件を作る。正式版参照が採用元を指す（D11）。
   * 選定は0件なので、期待する成果物は「欠勤がABSENTで戻ること」だけ。
   */
  async function adoptedCase(state: "ATTENTION" | "RECONCILE_REQUIRED"): Promise<void> {
    const selectionId = randomUUID();
    const scheduleUpdateId = randomUUID();
    const operationId = `apply:${selectionId}`;
    await withTransaction(async (tx) => {
      await tx.query(
        `insert into selection_result
           (selection_id, case_id, case_version, rules_version, outcome, connection_id,
            schedule_id, source_revision, monthly_completeness, decided_at)
         values ($1, $2, 1, 'test/0.0.0', 'FEASIBLE', $3, $4, $5, 'COMPLETE', $6)`,
        [selectionId, caseId, CONNECTION, scheduleId, REVISION, NOW],
      );
      await tx.query(
        `insert into operation_result
           (operation_id, request_hash, operation_kind, connection_id, case_id, status)
         values ($1, $2, 'APPLY_UPDATE', $3, $4, 'SUCCEEDED')`,
        [operationId, HASH, CONNECTION, caseId],
      );
      await tx.query(
        `insert into schedule_update
           (schedule_update_id, case_id, selection_id, operation_id, connection_id,
            schedule_id, expected_source_revision, state, case_version,
            artifact_ref, adopted_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'ADOPTED', 2, 'var/test/adopted.csv', $8)`,
        [scheduleUpdateId, caseId, selectionId, operationId, CONNECTION, scheduleId, REVISION, NOW],
      );
      await tx.query(
        `update authoritative_schedule_ref
            set adopted_by_schedule_update_id = $2, artifact_ref = 'var/test/adopted.csv'
          where connection_id = $1`,
        [CONNECTION, scheduleUpdateId],
      );
      await tx.query(
        `update absence_case set state = $2, adoption_fact = 'ADOPTED', version = version + 1
          where case_id = $1`,
        [caseId, state],
      );
    });
  }

  /** 読戻しが一致する内容。欠勤だけが `ABSENT` で戻る。 */
  function matchingReadBack(): readonly LoadedAssignment[] {
    return [
      {
        shiftAssignmentId: absentShift,
        staffId: absentStaff,
        roleCode: "FLOOR",
        startAt: SHIFT_START,
        endAt: SHIFT_END,
        status: "ABSENT",
      },
    ];
  }

  async function cleanup(tx: import("@/adapters/db/transaction").Tx): Promise<void> {
    const cases = "(select case_id from absence_case where connection_id = $1)";
    await tx.query(
      `update authoritative_schedule_ref set adopted_by_schedule_update_id = null
        where connection_id = $1`,
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
    await tx.query("delete from authoritative_schedule_ref where connection_id = $1", [CONNECTION]);
    await tx.query("delete from absence_case where connection_id = $1", [CONNECTION]);
    await tx.query("delete from operation_result where connection_id = $1", [CONNECTION]);
    await tx.query("delete from shift_assignment where store_id = $1", [storeId]);
  }

  beforeAll(async () => {
    ({ withTransaction } = await import("@/adapters/db/transaction"));
    ({ closePool } = await import("@/adapters/db/pool"));
    ({ reconcileOutbox } = await import("@/application/reconcile-outbox"));
    ({ recoverCase } = await import("@/application/recover-case"));

    const operations = (
      await import("@/adapters/db/operation-result-store")
    ).createPgOperationResultStore();
    messaging = (await import("@/adapters/channel")).createDefaultMessagingGateway({ operations });

    repos = {
      cases: (await import("@/adapters/db/case-repository")).createPgAbsenceCaseRepository(),
      outreaches: (await import("@/adapters/db/outreach-repository")).createPgOutreachRepository(),
      outbox: (await import("@/adapters/db/outbox-repository")).createPgOutboxRepository(),
      scheduleUpdates: (
        await import("@/adapters/db/schedule-update-repository")
      ).createPgScheduleUpdateRepository(),
      selections: (
        await import("@/adapters/db/selection-repository")
      ).createPgSelectionResultRepository(),
      authoritative: (
        await import("@/adapters/db/authoritative-ref-repository")
      ).createPgAuthoritativeScheduleRefRepository(),
      schedules: (
        await import("@/adapters/db/schedule-repository")
      ).createPgScheduleReadRepository(),
    };

    await withTransaction(async (tx) => {
      await tx.query(
        `insert into store (store_id, name, timezone, role_code)
         values ($1, '復旧テスト店', 'Asia/Tokyo', 'FLOOR')`,
        [storeId],
      );
      for (const [i, id] of [absentStaff, targetStaff].entries()) {
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
    outreachId = randomUUID();

    await withTransaction(async (tx) => {
      await cleanup(tx);
      await tx.query(
        `insert into shift_assignment
           (shift_assignment_id, schedule_id, store_id, staff_id, role_code,
            start_at, end_at, status)
         values ($1, $2, $3, $4, 'FLOOR', $5, $6, 'ABSENT')`,
        [absentShift, scheduleId, storeId, absentStaff, SHIFT_START, SHIFT_END],
      );
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
         values ($1, $2, $3, $4, $5, $6, $7, 'FLOOR', $8, $9, $10, 'COORDINATING', 'run-recover')`,
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
      await tx.query(
        `insert into outreach
           (outreach_id, case_id, staff_id, endpoint_provider, endpoint_connection_id,
            endpoint_key, endpoint_version, offered_start_at, offered_end_at,
            state, last_applied_seq, anonymous_staff_ref)
         values ($1, $2, $3, 'mock', $4, $5, 1, $6, $7, 'PENDING_SEND', 0, 'staff-1')`,
        [
          outreachId,
          caseId,
          targetStaff,
          CONNECTION,
          `staff:${targetStaff}`,
          SHIFT_START,
          SHIFT_END,
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
  });

  it("A13：照会で受け付けられたと確認できたら、送信済みにして打診も進める", async () => {
    const operationId = `send:${outreachId}:INITIAL_OFFER`;
    const outboxId = await unknownNotification({ operationId, delivery: "ACCEPTED" });

    const outcome = await runUntilMine(
      reconcile(),
      (o) => "outboxId" in o && o.outboxId === outboxId,
    );
    expect(outcome).toMatchObject({ finding: "ACCEPTED", status: "SENT" });
    expect((await outboxRow(outboxId)).status).toBe("SENT");

    const outreach = await query<{ state: string }>(
      "select state from outreach where outreach_id = $1",
      [outreachId],
    );
    // 初回打診は返信を待つ種別。送信済みを飛ばさず、返信待ちまで進む。
    expect(outreach[0].state).toBe("AWAITING_REPLY");
  });

  it("A13：照会で送信の記録が無いと確認できたら、送信待ちへ戻す", async () => {
    const operationId = `send:${outreachId}:INITIAL_OFFER`;
    const outboxId = await unknownNotification({ operationId });

    const outcome = await runUntilMine(
      reconcile(),
      (o) => "outboxId" in o && o.outboxId === outboxId,
    );
    expect(outcome).toMatchObject({ finding: "NOT_SENT", status: "PENDING" });
    expect((await outboxRow(outboxId)).status).toBe("PENDING");
    // 打診は動かさない。送ってから進める。
    const outreach = await query<{ state: string }>(
      "select state from outreach where outreach_id = $1",
      [outreachId],
    );
    expect(outreach[0].state).toBe("PENDING_SEND");
  });

  it("A13：照会できないあいだは動かさない。未送信と読み替えない", async () => {
    const operationId = `send:${outreachId}:INITIAL_OFFER`;
    const outboxId = await unknownNotification({
      operationId,
      delivery: "UNKNOWN",
      faultMode: "LOOKUP_UNAVAILABLE",
    });

    const outcome = await runUntilMine(
      reconcile(),
      (o) => "outboxId" in o && o.outboxId === outboxId,
    );
    expect(outcome).toMatchObject({ finding: "UNRESOLVED", status: "UNKNOWN" });
    // **`PENDING` へ戻さない。** 戻すと、届いているかもしれない通知をもう一度送る。
    expect((await outboxRow(outboxId)).status).toBe("UNKNOWN");
  });

  it("A13／D07：内容ハッシュが食い違う照会結果を、送信の証拠にしない", async () => {
    const operationId = `send:${outreachId}:INITIAL_OFFER`;
    const outboxId = await unknownNotification({ operationId, delivery: "ACCEPTED" });
    // 通知側の内容だけを差し替える。保存済みの操作は書き換えられない（0003のtrigger）。
    // 別の内容で送った記録を、この通知が送られた証拠にしない。
    await withTransaction((tx) =>
      tx.query("update notification_outbox set request_hash = $2 where outbox_id = $1", [
        outboxId,
        "d".repeat(64),
      ]),
    );

    const outcome = await runUntilMine(
      reconcile(),
      (o) => "outboxId" in o && o.outboxId === outboxId,
    );
    expect(outcome).toMatchObject({ finding: "UNRESOLVED" });
    expect((await outboxRow(outboxId)).status).toBe("UNKNOWN");
  });

  it("Q12：要対応から戻すのは、採用済みかつ読戻しが一致したときだけ", async () => {
    await adoptedCase("ATTENTION");
    const gateway = stubGateway({ readBack: matchingReadBack() });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    expect(outcome).toMatchObject({ to: "REPORTING" });
    expect((await caseRow()).state).toBe("REPORTING");
    expect(gateway.calls.readBack).toBeGreaterThan(0);
  });

  it("Q12：読戻しが一致しなければ要対応のまま。自動で終端へ落とさない", async () => {
    await adoptedCase("ATTENTION");
    const gateway = stubGateway({ readBackThrows: true });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    expect(outcome).toMatchObject({ to: "WAITING" });
    const row = await caseRow();
    expect(row.state).toBe("ATTENTION");
    // D09：採用事実を消さない。「未確定」にしない。
    expect(row.adoption_fact).toBe("ADOPTED");
  });

  it("Q12：採用事実がADOPTEDでなければ、読戻しが一致しても戻さない", async () => {
    await adoptedCase("ATTENTION");
    await withTransaction((tx) =>
      tx.query("update absence_case set adoption_fact = 'UNKNOWN' where case_id = $1", [caseId]),
    );
    const gateway = stubGateway({ readBack: matchingReadBack() });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    expect(outcome).toMatchObject({ to: "WAITING" });
    expect((await caseRow()).state).toBe("ATTENTION");
  });

  it("Q11：照会経路が使えない照合待ちは要対応へ。未採用と断定しない", async () => {
    await preparedUpdate("RECONCILE_REQUIRED");
    const gateway = stubGateway({ supportsResultLookup: false });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    expect(outcome).toMatchObject({ to: "ATTENTION" });
    expect((await caseRow()).state).toBe("ATTENTION");
    // **`REJECTED` にしない。** 未採用と断定すると、実は反映済みの計画を二重に採用する。
    expect((await updateRow()).state).toBe("RECONCILE_REQUIRED");
    // 照会できない口を叩かない。
    expect(gateway.calls.getUpdateResult).toBe(0);
  });

  it("A03：未決の更新が無くても、正式版参照が採用を指していれば未採用と断定しない", async () => {
    // 採用取引は commit したが、案件の状態だけが照合待ちで残った場合。採用済みの
    // 更新は終端なので `findOpenByCase` では引けない。参照を見ずに「未決の更新が
    // 無い＝未採用」と読むと、確定済みの勤務があるまま調整中へ戻して二重採用する。
    await adoptedCase("RECONCILE_REQUIRED");
    const gateway = stubGateway({ supportsResultLookup: false });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    expect(outcome).toMatchObject({ to: "COMMITTED" });
    const row = await caseRow();
    expect(row.state).toBe("COMMITTED");
    expect(row.adoption_fact).toBe("ADOPTED");
  });

  it("A03：照会で反映されていないと確認できたら、調整中へ戻して再計画できる", async () => {
    await preparedUpdate("RECONCILE_REQUIRED");
    const gateway = stubGateway({ lookup: "NOT_APPLIED" });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    expect(outcome).toMatchObject({ to: "COORDINATING" });
    const row = await caseRow();
    expect(row.state).toBe("COORDINATING");
    expect(row.adoption_fact).toBe("NOT_ADOPTED");
    expect((await updateRow()).state).toBe("REJECTED");
  });

  it("Q13：停止を保留した準備中は、成否を確かめてから行き先を決める", async () => {
    await preparedUpdate("PREPARING");
    await withTransaction((tx) =>
      tx.query(
        `update absence_case set stop_cause = 'DEADLINE', stopped_at = $2, version = version + 1
          where case_id = $1`,
        [caseId, NOW],
      ),
    );
    const gateway = stubGateway({ lookup: "NOT_APPLIED" });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    // 未採用と確認できた。期限による停止なので人へ引き継ぐ。
    expect(outcome).toMatchObject({ to: "HANDED_OFF" });
    const row = await caseRow();
    expect(row.state).toBe("HANDED_OFF");
    expect(row.handoff_reason).toBe("DEADLINE_REACHED");
    expect(row.adoption_fact).toBe("NOT_ADOPTED");
  });

  it("Q13：停止を保留した準備中でも、成否が不明なら引き継がず照合へ回す", async () => {
    await preparedUpdate("PREPARING");
    await withTransaction((tx) =>
      tx.query(
        `update absence_case set stop_cause = 'DEADLINE', stopped_at = $2, version = version + 1
          where case_id = $1`,
        [caseId, NOW],
      ),
    );
    const gateway = stubGateway({ lookup: "LOOKUP_UNAVAILABLE" });

    const outcome = await runUntilMine(
      recover(gateway),
      (o) => "caseId" in o && o.caseId === caseId,
    );
    expect(outcome).toMatchObject({ to: "RECONCILE_REQUIRED" });
    const row = await caseRow();
    expect(row.state).toBe("RECONCILE_REQUIRED");
    // 未採用へ丸めない。
    expect(row.adoption_fact).toBe("UNKNOWN");
  });

  /** 未決（PREPARED）の勤務表更新を持つ案件を作る。 */
  async function preparedUpdate(state: "RECONCILE_REQUIRED" | "PREPARING"): Promise<void> {
    const selectionId = randomUUID();
    const operationId = `apply:${selectionId}`;
    await withTransaction(async (tx) => {
      await tx.query(
        `insert into selection_result
           (selection_id, case_id, case_version, rules_version, outcome, connection_id,
            schedule_id, source_revision, monthly_completeness, decided_at)
         values ($1, $2, 1, 'test/0.0.0', 'FEASIBLE', $3, $4, $5, 'COMPLETE', $6)`,
        [selectionId, caseId, CONNECTION, scheduleId, REVISION, NOW],
      );
      await tx.query(
        `insert into operation_result
           (operation_id, request_hash, operation_kind, connection_id, case_id, status)
         values ($1, $2, 'APPLY_UPDATE', $3, $4, 'UNKNOWN')`,
        [operationId, HASH, CONNECTION, caseId],
      );
      await tx.query(
        `insert into schedule_update
           (schedule_update_id, case_id, selection_id, operation_id, connection_id,
            schedule_id, expected_source_revision, state, case_version)
         values ($1, $2, $3, $4, $5, $6, $7, 'RECONCILE_REQUIRED', 2)`,
        [randomUUID(), caseId, selectionId, operationId, CONNECTION, scheduleId, REVISION],
      );
      await tx.query(
        `update absence_case set state = $2, adoption_fact = 'UNKNOWN', version = version + 1
          where case_id = $1`,
        [caseId, state],
      );
    });
  }
});
