/**
 * 合成の根。実装の組み合わせをここだけで決める。
 *
 * **fake をここへ入れない。** 未実装の依存は「未実装」を返す実装を置き、
 * 動いているように見せない（`UnconfiguredModelGateway` と同じ方針）。
 */

import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDefaultMessagingGateway } from "../adapters/channel";
import { CsvScheduleGateway, FileCsvScheduleSource } from "../adapters/csv/schedule-gateway";
import { createPgAuthoritativeScheduleRefRepository } from "../adapters/db/authoritative-ref-repository";
import { createPgBudgetLedger } from "../adapters/db/budget-ledger";
import { createPgCommitmentRepository } from "../adapters/db/commitment-repository";
import { createPgAbsenceCaseRepository } from "../adapters/db/case-repository";
import { createPgOperationResultStore } from "../adapters/db/operation-result-store";
import { createPgInboundEventRepository } from "../adapters/db/inbound-repository";
import { createPgReplyInterpretationRepository } from "../adapters/db/interpretation-repository";
import { createPgModelCallStore } from "../adapters/db/model-call-store";
import { createPgOutboxRepository } from "../adapters/db/outbox-repository";
import { createPgOutreachRepository } from "../adapters/db/outreach-repository";
import { createPgScheduleReadRepository } from "../adapters/db/schedule-repository";
import { createPgScheduleUpdateRepository } from "../adapters/db/schedule-update-repository";
import { createPgSelectionResultRepository } from "../adapters/db/selection-repository";
import { createPgShiftAssignmentRepository } from "../adapters/db/shift-assignment-repository";
import { createPgStaffRepository, createPgStoreRepository } from "../adapters/db/store-repository";
import type { Clock, IdGenerator } from "../contracts/repository";
import { createModelGateway } from "../adapters/orca";
import { adoptPlan } from "./adopt-plan";
import { createAbsenceCase } from "./create-absence-case";
import { detectDeadline } from "./detect-deadline";
import { interpretPending } from "./interpret-pending";
import { interpretReply } from "./interpret-reply";
import { receiveInboundEvent } from "./receive-inbound-event";
import { reconcileOutbox } from "./reconcile-outbox";
import { recoverCase } from "./recover-case";
import { createRosterEligibility } from "./roster-eligibility";
import { createSelectionPlanner } from "../domain/selection";
import { createEligibilityRecheck } from "../domain/selection/eligibility";
import { sendOutbox } from "./send-outbox";
import { settleReporting } from "./settle-reporting";
import { startOutreach } from "./start-outreach";
import { stopCase } from "./stop-case";

const clock: Clock = { now: () => new Date().toISOString() };
const idGenerator: IdGenerator = { next: () => randomUUID() };

export function buildAppServices() {
  const cases = createPgAbsenceCaseRepository();
  const outreaches = createPgOutreachRepository();
  const outbox = createPgOutboxRepository();
  const inbound = createPgInboundEventRepository();
  const interpretations = createPgReplyInterpretationRepository();
  const commitments = createPgCommitmentRepository();
  // OrcaRouter の接続情報・金額予算が揃わなければ UnconfiguredModelGateway になり、
  // 実推論を行わない（模擬結果も返さない）。
  const model = createModelGateway({
    ledger: createPgBudgetLedger(),
    callStore: createPgModelCallStore(),
  });
  const operations = createPgOperationResultStore();
  const schedules = createPgScheduleReadRepository();
  const stores = createPgStoreRepository();
  const staff = createPgStaffRepository();
  const selections = createPgSelectionResultRepository();
  const scheduleUpdates = createPgScheduleUpdateRepository();
  const authoritative = createPgAuthoritativeScheduleRefRepository();
  const assignments = createPgShiftAssignmentRepository();
  const roster = createRosterEligibility();
  const messaging = createDefaultMessagingGateway({ operations });
  const fixtureDir = path.join(process.cwd(), "fixtures", "dev", "month-2026-09");
  const gateway = new CsvScheduleGateway({
    source: new FileCsvScheduleSource(
      path.join(fixtureDir, "schedule.csv"),
      path.join(fixtureDir, "manifest.json"),
    ),
    outputDir: path.join(process.cwd(), "var", "csv"),
  });
  const planner = createSelectionPlanner();
  const eligibility = createEligibilityRecheck();
  const stop = stopCase({
    cases,
    outreaches,
    commitments,
    outbox,
    scheduleUpdates,
    operations,
    stores,
    clock,
    ids: idGenerator,
  });
  const interpret = interpretReply({
    model,
    cases,
    outreaches,
    inbound,
    interpretations,
    commitments,
    stores,
    outbox,
    clock,
    ids: idGenerator,
  });

  return {
    cases,
    outreaches,
    outbox,
    inbound,
    interpretations,
    commitments,
    stores,
    staff,
    model,
    operations,
    schedules,
    selections,
    scheduleUpdates,
    authoritative,
    assignments,
    messaging,
    gateway,
    clock,
    createAbsenceCase: createAbsenceCase({
      cases,
      schedules,
      stores,
      operations,
      clock,
      ids: idGenerator,
    }),
    startOutreach: startOutreach({
      cases,
      outreaches,
      outbox,
      operations,
      roster,
      stores,
      clock,
      ids: idGenerator,
    }),
    sendOutbox: sendOutbox({ outbox, outreaches, messaging }),
    reconcileOutbox: reconcileOutbox({ outbox, outreaches, messaging }),
    stopCase: stop,
    detectDeadline: detectDeadline({ stopCase: stop, clock }),
    recoverCase: recoverCase({
      cases,
      scheduleUpdates,
      selections,
      schedules,
      authoritative,
      operations,
      gateway,
      clock,
    }),
    settleReporting: settleReporting({
      cases,
      outbox,
      scheduleUpdates,
      selections,
      schedules,
      gateway,
    }),
    adoptPlan: adoptPlan({
      cases,
      commitments,
      outreaches,
      inbound,
      stores,
      staff,
      selections,
      scheduleUpdates,
      authoritative,
      assignments,
      schedules,
      outbox,
      operations,
      gateway,
      planner,
      eligibility,
      clock,
      ids: idGenerator,
    }),
    receiveInboundEvent: receiveInboundEvent({ inbound, outreaches }),
    interpretReply: interpret,
    interpretPending: interpretPending({ model, inbound, interpret }),
  };
}

export type AppServices = ReturnType<typeof buildAppServices>;
