/**
 * 合成の根。実装の組み合わせをここだけで決める。
 *
 * **fake をここへ入れない。** 未実装の依存は「未実装」を返す実装を置き、
 * 動いているように見せない（`UnconfiguredModelGateway` と同じ方針）。
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { createDefaultMessagingGateway } from "../adapters/channel";
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
import type { Clock, IdGenerator } from "../contracts/repository";
import { createModelGateway } from "../adapters/orca";
import { createAbsenceCase } from "./create-absence-case";
import { interpretPending } from "./interpret-pending";
import { interpretReply } from "./interpret-reply";
import { receiveInboundEvent } from "./receive-inbound-event";
import { createRosterEligibility } from "./roster-eligibility";
import { sendOutbox } from "./send-outbox";
import { startOutreach } from "./start-outreach";

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
  const roster = createRosterEligibility();
  const messaging = createDefaultMessagingGateway({ operations });
  const interpret = interpretReply({
    model,
    cases,
    outreaches,
    inbound,
    interpretations,
    commitments,
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
    model,
    operations,
    schedules,
    messaging,
    clock,
    createAbsenceCase: createAbsenceCase({ cases, schedules, operations, clock, ids: idGenerator }),
    startOutreach: startOutreach({
      cases,
      outreaches,
      outbox,
      operations,
      roster,
      clock,
      ids: idGenerator,
    }),
    sendOutbox: sendOutbox({ outbox, outreaches, messaging }),
    receiveInboundEvent: receiveInboundEvent({ inbound, outreaches }),
    interpretReply: interpret,
    interpretPending: interpretPending({ model, interpret }),
  };
}

export type AppServices = ReturnType<typeof buildAppServices>;
