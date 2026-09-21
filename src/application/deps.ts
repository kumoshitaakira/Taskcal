/**
 * 合成の根。実装の組み合わせをここだけで決める。
 *
 * **fake をここへ入れない。** 未実装の依存は「未実装」を返す実装を置き、
 * 動いているように見せない（`UnconfiguredModelGateway` と同じ方針）。
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { createDefaultMessagingGateway } from "../adapters/channel";
import { createPgAbsenceCaseRepository } from "../adapters/db/case-repository";
import { createPgOperationResultStore } from "../adapters/db/operation-result-store";
import { createPgOutboxRepository } from "../adapters/db/outbox-repository";
import { createPgOutreachRepository } from "../adapters/db/outreach-repository";
import { createPgScheduleReadRepository } from "../adapters/db/schedule-repository";
import type { Clock, IdGenerator } from "../contracts/repository";
import { createAbsenceCase } from "./create-absence-case";
import { createRosterEligibility } from "./roster-eligibility";
import { sendOutbox } from "./send-outbox";
import { startOutreach } from "./start-outreach";

const clock: Clock = { now: () => new Date().toISOString() };
const idGenerator: IdGenerator = { next: () => randomUUID() };

export function buildAppServices() {
  const cases = createPgAbsenceCaseRepository();
  const outreaches = createPgOutreachRepository();
  const outbox = createPgOutboxRepository();
  const operations = createPgOperationResultStore();
  const schedules = createPgScheduleReadRepository();
  const roster = createRosterEligibility();
  const messaging = createDefaultMessagingGateway({ operations });

  return {
    cases,
    outreaches,
    outbox,
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
  };
}

export type AppServices = ReturnType<typeof buildAppServices>;
