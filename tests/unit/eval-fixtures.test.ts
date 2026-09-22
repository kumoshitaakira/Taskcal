import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADOPTION_FACT,
  caseStateSchema,
  HANDOFF_REASON,
  isAllowedCaseTransition,
  STOP_CAUSE,
} from "@/contracts/case-state";
import { ENDPOINT_CHECK, SEND_REFUSAL } from "@/contracts/messaging-gateway";
import { computeRequestHash, operationRefSchema, requestHashSchema } from "@/contracts/operation";
import { scheduleUpdateStateSchema, updateResultKindSchema } from "@/contracts/schedule-update";

type JsonObject = Record<string, unknown>;

interface FixtureOperation {
  readonly kind: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly requestPayload: unknown;
  readonly connectionId?: string;
  readonly provider?: string;
  readonly endpointVersion?: number;
}

interface AcceptanceScenario {
  readonly scenarioId: string;
  readonly boundary: string;
  readonly input: JsonObject;
  readonly operations: readonly FixtureOperation[];
  readonly observedUpdateResult?: JsonObject;
  readonly expected: JsonObject;
  readonly forbiddenExternalEffects: readonly string[];
  readonly applicationAcceptance: {
    readonly status: string;
    readonly reason: string;
    readonly requires: readonly string[];
  };
}

interface AcceptanceFixture {
  readonly fixtureVersion: number;
  readonly caseId: string;
  readonly title: string;
  readonly scenarios: readonly AcceptanceScenario[];
}

const EVAL_DIR = new URL("../../fixtures/eval/", import.meta.url);
const EXPECTED_CASE_IDS = ["A02", "A03", "A04", "A07", "A08", "A14", "A15", "A18"];
const OPERATION_KINDS = ["MESSAGE_SEND", "SCHEDULE_UPDATE"];

function readFixtures(): readonly AcceptanceFixture[] {
  return readdirSync(EVAL_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(name, EVAL_DIR), "utf8")) as AcceptanceFixture);
}

function getArray(object: JsonObject, key: string): readonly unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

describe("決定的な受入fixtureの構造", () => {
  const fixtures = readFixtures();
  const scenarios = fixtures.flatMap((fixture) => fixture.scenarios);

  it("対象ケースが揃い、application全体の合格を主張しない", () => {
    expect(fixtures.map((fixture) => fixture.caseId)).toEqual(EXPECTED_CASE_IDS);
    expect(fixtures.every((fixture) => fixture.fixtureVersion === 1)).toBe(true);
    expect(scenarios.length).toBeGreaterThan(EXPECTED_CASE_IDS.length);
    for (const scenario of scenarios) {
      expect(scenario.applicationAcceptance.status).toBe("UNEXECUTED");
      expect(scenario.applicationAcceptance.reason.length).toBeGreaterThan(0);
      expect(scenario.applicationAcceptance.requires.length).toBeGreaterThan(0);
      expect(scenario.forbiddenExternalEffects.length).toBeGreaterThan(0);
    }
  });

  it("既存契約の状態値と操作ID・requestHashを検査する", () => {
    const operationIds = new Set<string>();
    for (const scenario of scenarios) {
      expect(scenario.scenarioId.length).toBeGreaterThan(0);
      expect(scenario.boundary.length).toBeGreaterThan(0);
      expect(scenario.input).toBeTypeOf("object");
      expect(Array.isArray(scenario.operations)).toBe(true);
      expect(Object.keys(scenario.expected).length).toBeGreaterThan(0);
      expect(scenario.applicationAcceptance.status).toBe("UNEXECUTED");
      expect(scenario.applicationAcceptance.reason.length).toBeGreaterThan(0);
      expect(scenario.applicationAcceptance.requires.length).toBeGreaterThan(0);
      expect(scenario.forbiddenExternalEffects.length).toBeGreaterThan(0);

      const expected = scenario.expected;
      for (const key of ["caseState", "winnerCaseState", "loserCaseState"]) {
        const value = expected[key];
        if (typeof value === "string") expect(() => caseStateSchema.parse(value)).not.toThrow();
      }
      for (const key of [
        "scheduleUpdateState",
        "winnerScheduleUpdateState",
        "loserScheduleUpdateState",
      ]) {
        const value = expected[key];
        if (typeof value === "string") {
          expect(() => scheduleUpdateStateSchema.parse(value)).not.toThrow();
        }
      }
      const adoptionFact = expected.adoptionFact;
      if (typeof adoptionFact === "string") {
        expect(Object.values(ADOPTION_FACT)).toContain(adoptionFact);
      }
      const resultKindsValue = expected.resultKinds;
      const resultKinds = resultKindsValue === undefined ? [] : getArray(expected, "resultKinds");
      for (const resultKind of resultKinds) {
        expect(() => updateResultKindSchema.parse(resultKind)).not.toThrow();
      }
      const handoffReason = expected.handoffReason;
      if (typeof handoffReason === "string")
        expect(Object.values(HANDOFF_REASON)).toContain(handoffReason);
      if (expected.caseState === "HANDED_OFF") {
        expect(typeof handoffReason).toBe("string");
      }

      const recoveryTrace = expected.recoveryTrace;
      if (recoveryTrace !== undefined) {
        expect(Array.isArray(recoveryTrace)).toBe(true);
        const states = getArray(expected, "recoveryTrace").map((state) =>
          caseStateSchema.parse(state),
        );
        expect(states.length).toBeGreaterThan(1);
        for (let index = 1; index < states.length; index += 1) {
          expect(isAllowedCaseTransition(states[index - 1], states[index])).toBe(true);
        }
      }

      for (const operation of scenario.operations) {
        expect(operationIds.has(operation.operationId)).toBe(false);
        operationIds.add(operation.operationId);
        expect(OPERATION_KINDS).toContain(operation.kind);
        expect(() => operationRefSchema.parse(operation)).not.toThrow();
        expect(requestHashSchema.safeParse(operation.requestHash).success).toBe(true);
        expect(computeRequestHash(operation.requestPayload)).toBe(operation.requestHash);
        const payload = operation.requestPayload as JsonObject;
        if (operation.kind === "MESSAGE_SEND") {
          const to = payload.to as JsonObject;
          expect(to).toBeTypeOf("object");
          expect(typeof payload.kind).toBe("string");
          expect(typeof payload.body).toBe("string");
          expect(operation.provider).toBe(to.provider);
          expect(operation.connectionId).toBe(to.connectionId);
          expect(operation.endpointVersion).toBe(to.endpointVersion);
        } else {
          expect(payload.connectionId).toBe(operation.connectionId);
          expect(typeof payload.connectionId).toBe("string");
          expect(typeof payload.scheduleId).toBe("string");
          expect(typeof payload.expectedSourceRevision).toBe("string");
          expect(Array.isArray(payload.additions)).toBe(true);
          expect(Array.isArray(payload.absences)).toBe(true);
        }
      }

      const observedUpdateResult = scenario.observedUpdateResult;
      if (observedUpdateResult !== undefined) {
        expect(typeof observedUpdateResult.operationId).toBe("string");
        expect(typeof observedUpdateResult.connectionId).toBe("string");
        expect(() => updateResultKindSchema.parse(observedUpdateResult.kind)).not.toThrow();
        expect(
          scenario.operations.some(
            (operation) => operation.operationId === observedUpdateResult.operationId,
          ),
        ).toBe(true);
        expect(
          scenario.operations.some(
            (operation) => operation.connectionId === observedUpdateResult.connectionId,
          ),
        ).toBe(true);
      }
    }
  });

  it("正式採用前の既存勤務集合と追加予定を重ねない", () => {
    for (const scenario of scenarios) {
      if (scenario.boundary === "AFTER_FORMAL_ADOPTION") continue;
      const scheduleValue = scenario.input.schedule;
      if (typeof scheduleValue !== "object" || scheduleValue === null) continue;

      const existingAssignmentIds = new Set(getArray(scheduleValue as JsonObject, "assignmentIds"));
      for (const operation of scenario.operations) {
        if (operation.kind !== "SCHEDULE_UPDATE") continue;
        const payload = operation.requestPayload as JsonObject;
        for (const addition of getArray(payload, "additions")) {
          const plannedAssignment = addition as JsonObject;
          expect(typeof plannedAssignment.shiftAssignmentId).toBe("string");
          expect(existingAssignmentIds.has(plannedAssignment.shiftAssignmentId)).toBe(false);
        }
      }
    }
  });

  it("A02: PREPARED成果物を停止後の正式勤務にしない", () => {
    const scenario = fixtures.find((fixture) => fixture.caseId === "A02")!.scenarios[0];
    expect(scenario.expected.caseState).toBe("CANCELLED");
    expect(scenario.expected.scheduleUpdateState).toBe("REJECTED");
    expect(scenario.expected.adoptionFact).toBe(ADOPTION_FACT.NOT_ADOPTED);
    expect(scenario.expected.resultKinds).toEqual(["PREPARED"]);
    expect(scenario.input.stopCause).toBe(STOP_CAUSE.MANAGER_STOP);
  });

  it("A03: UNKNOWNを未採用へ丸めず、同じ勤務を再作成しない", () => {
    const scenario = fixtures.find((fixture) => fixture.caseId === "A03")!.scenarios[0];
    expect(scenario.expected.caseState).toBe("HANDED_OFF");
    expect(scenario.expected.scheduleUpdateState).toBe("RECONCILE_REQUIRED");
    expect(scenario.expected.adoptionFact).toBe(ADOPTION_FACT.UNKNOWN);
    expect(scenario.expected.handoffReason).toBe(HANDOFF_REASON.RECONCILE_STALLED);
    expect(scenario.expected.duplicateAssignmentCreated).toBe(false);
    expect(scenario.expected.resultKinds).toEqual(["UNKNOWN"]);
    expect(scenario.expected.formalAdoptionOccurred).toBe("UNKNOWN");
  });

  it("A04: 同じ旧版の競合は一方だけを採用する", () => {
    const scenario = fixtures.find((fixture) => fixture.caseId === "A04")!.scenarios[0];
    expect(scenario.operations).toHaveLength(2);
    const race = scenario.input.race as JsonObject;
    expect(race.mode).toBe("SAME_OLD_REVISION_COMPARE_AND_SET");
    expect(race.executionOrders).toEqual([
      ["op-a04-winner", "op-a04-loser"],
      ["op-a04-loser", "op-a04-winner"],
    ]);
    expect(race.winnerSelection).toBe("FIRST_SUCCESSFUL_COMPARE_AND_SET");
    expect(race.adoptedOperationIdDependsOnExecutionOrder).toBe(true);
    expect(scenario.expected.adoptedOperationIdChoices).toEqual(["op-a04-winner", "op-a04-loser"]);
    expect(scenario.expected.formalAdoptionCount).toBe(1);
    expect(scenario.expected.conflictOperationCount).toBe(1);
    expect(scenario.expected.formalRevisionUpdateCount).toBe(1);
    expect(scenario.expected.resultKinds).toEqual(["PREPARED", "CONFLICT"]);
    expect(scenario.expected.winnerScheduleUpdateState).toBe("ADOPTED");
    expect(scenario.expected.loserScheduleUpdateState).toBe("REJECTED");
  });

  it("A07/A08: 読戻し不一致と一部作用を成功へ畳まない", () => {
    const readBack = fixtures.find((fixture) => fixture.caseId === "A07")!.scenarios[0];
    expect(readBack.expected.readBackMatches).toBe(false);
    expect(readBack.expected.caseState).toBe("COORDINATING");
    expect(readBack.expected.scheduleUpdateState).toBe("REJECTED");
    expect(readBack.expected.adoptionFact).toBe(ADOPTION_FACT.NOT_ADOPTED);
    expect(readBack.expected.resultKinds).toEqual(["PREPARED"]);
    expect(readBack.expected.formalAdoptionOccurred).toBe(false);
    expect(readBack.expected.completed).toBe(false);

    const partial = fixtures.find((fixture) => fixture.caseId === "A08")!.scenarios[0];
    expect(partial.expected.resultKinds).toEqual(["PARTIAL"]);
    expect(partial.expected.allAssignmentsFormallyAdopted).toBe(false);
    expect(partial.expected.internalFormalAdoptionCount).toBe(0);
    expect(partial.expected.externalPartialMayHaveOccurred).toBe(true);
    expect(partial.expected.adoptionFact).toBe(ADOPTION_FACT.UNKNOWN);
    expect(partial.expected.handoffReason).toBe(HANDOFF_REASON.RECONCILE_STALLED);
    expect(partial.expected.formalAdoptionOccurred).toBe("UNKNOWN");
  });

  it("A14: 読取専用接続はEXPORTED_ONLYとして正式採用と分ける", () => {
    const scenario = fixtures.find((fixture) => fixture.caseId === "A14")!.scenarios[0];
    const schedule = scenario.input.schedule as JsonObject;
    expect(scenario.expected.resultKinds).toEqual(["EXPORTED_ONLY"]);
    expect(scenario.expected.exportedArtifactOnly).toBe(true);
    expect(scenario.expected.formalAdoptionOccurred).toBe(false);
    expect(schedule.formalSourceRevision).toBe(scenario.expected.authoritativeSourceRevision);
    expect(scenario.input.sourceCapabilities).toMatchObject({
      canReadRevision: true,
      canConditionalUpdate: false,
      supportsAtomicBatch: false,
    });
  });

  it("A15: provider・connectionId・endpointVersionと本人同一性を分ける", () => {
    const fixture = fixtures.find((item) => item.caseId === "A15")!;
    const changed = fixture.scenarios.find(
      (item) => item.scenarioId === "A15-endpoint-version-changed",
    )!;
    const send = changed.operations[0];
    expect(changed.expected.endpointCheck).toBe(ENDPOINT_CHECK.CHANGED);
    expect(changed.expected.messageOutcomes).toEqual([SEND_REFUSAL.ENDPOINT_CHANGED]);
    expect(send.provider).toBe("mock-inbox");
    expect(send.connectionId).toBe("mock-connection-a");
    expect(send.endpointVersion).toBe(1);

    const duplicate = fixture.scenarios.find(
      (item) => item.scenarioId === "A15-event-id-is-scoped-by-connection",
    )!;
    const events = getArray(duplicate.input, "events") as JsonObject[];
    expect(duplicate.expected.persistedEventCount).toBe(2);
    expect(new Set(events.map((event) => event.connectionId)).size).toBe(2);
    expect(events[0].eventId).toBe(events[1].eventId);
    for (const event of events) {
      expect(event.provider).toBe("mock-inbox");
      expect(typeof event.connectionId).toBe("string");
      expect(typeof event.eventId).toBe("string");
      expect(typeof event.receivedAt).toBe("string");
      expect(event.from).toMatchObject({ provider: "mock-inbox" });
      expect(typeof event.body).toBe("string");
      expect(event.channelVerified).toBe(true);
    }
    expect(duplicate.expected.deduplicationKey).toEqual(["provider", "connectionId", "eventId"]);
    expect(duplicate.expected.receivedOrderSource).toBe("receivedSeq");
    expect(duplicate.expected.receivedSeqByEvent).toEqual([
      { connectionId: "mock-connection-a", eventId: "event-a15-same-id", receivedSeq: 1 },
      { connectionId: "mock-connection-b", eventId: "event-a15-same-id", receivedSeq: 2 },
    ]);

    const identity = fixture.scenarios.find(
      (item) => item.scenarioId === "A15-reply-from-another-person",
    )!;
    expect(identity.expected.replyAcceptance).toBe("NOT_ACCEPTED");
    expect(identity.expected.authenticatedRespondentMatchesOutreach).toBe(false);
    expect(identity.expected.channelVerifiedIsNotIdentityProof).toBe(true);
    expect(identity.expected.eventPersistedBeforeRejection).toBe(true);
  });

  it("A18: 停止・回数・予算・期限とPREPARING中の結果不明を分ける", () => {
    const scenarios = fixtures.find((fixture) => fixture.caseId === "A18")!.scenarios;
    expect(scenarios).toHaveLength(6);
    expect(scenarios.slice(0, 4).every((scenario) => scenario.operations.length === 0)).toBe(true);
    for (const scenario of scenarios.slice(0, 4)) {
      expect(scenario.expected.newOutreachCount).toBe(0);
      expect(scenario.expected.formalAdoptionOccurred).toBe(false);
    }

    const unknown = scenarios.find(
      (item) => item.scenarioId === "A18-preparing-limit-with-unknown-adoption",
    )!;
    expect(unknown.expected.caseState).toBe("RECONCILE_REQUIRED");
    expect(unknown.expected.adoptionFact).toBe(ADOPTION_FACT.UNKNOWN);
    expect(unknown.expected.mustResolveAdoptionBeforeHandoff).toBe(true);
    expect(unknown.expected.resultKinds).toEqual(["UNKNOWN"]);
    expect(unknown.operations).toHaveLength(1);
    expect(unknown.observedUpdateResult).toMatchObject({
      operationId: "op-a18-unknown-schedule-update",
      connectionId: "csv-demo-write",
      kind: "UNKNOWN",
      lookup: "LOOKUP_UNAVAILABLE",
    });

    const adopted = scenarios.find(
      (item) => item.scenarioId === "A18-preparing-limit-after-adopted",
    )!;
    expect(adopted.expected.caseState).toBe("COMMITTED");
    expect(adopted.expected.adoptionFact).toBe(ADOPTION_FACT.ADOPTED);
    expect(adopted.expected.formalAdoptionOccurred).toBe(true);
    expect(adopted.operations).toHaveLength(1);
    expect(adopted.observedUpdateResult).toMatchObject({
      operationId: "op-a18-adopted-schedule-update",
      connectionId: "csv-demo-write",
      kind: "APPLIED",
      lookup: "CONFIRMED",
    });
  });
});
