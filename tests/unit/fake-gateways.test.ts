import { describe, expect, it } from "vitest";
import { computeRequestHash } from "@/contracts/operation";
import type {
  ApplyUpdatePayloadForHash,
  ApplyUpdateCommand,
  ContactEndpointRef,
  LoadedSchedule,
  SendCommand,
} from "@/contracts";
import { FakeMessagingGateway, FakeScheduleGateway } from "../stubs/fake-gateways";

const schedule: LoadedSchedule = {
  scheduleId: "schedule-2026-09-01",
  sourceRevision: "source-revision-1",
  requestedRange: { fromDate: "2026-09-01", toDate: "2026-10-01" },
  completeness: "COMPLETE",
  missingDates: [],
  assignments: [
    {
      shiftAssignmentId: "shift-absent",
      staffId: "staff-original",
      roleCode: "FLOOR",
      startAt: "2026-09-01T18:00:00+09:00",
      endAt: "2026-09-01T22:00:00+09:00",
      status: "SCHEDULED",
    },
  ],
};

const addition = {
  shiftAssignmentId: "shift-replacement",
  commitmentId: "commitment-1",
  staffId: "staff-replacement",
  roleCode: "FLOOR",
  startAt: "2026-09-01T18:00:00+09:00",
  endAt: "2026-09-01T22:00:00+09:00",
  sourceCaseId: "case-1",
} as const;

const absence = {
  shiftAssignmentId: "shift-absent",
  startAt: "2026-09-01T18:00:00+09:00",
  endAt: "2026-09-01T22:00:00+09:00",
} as const;

function scheduleCommand(
  operationId: string,
  overrides: Partial<
    Pick<
      ApplyUpdateCommand,
      "connectionId" | "scheduleId" | "expectedSourceRevision" | "additions" | "absences"
    >
  > = {},
): ApplyUpdateCommand {
  const commandWithoutHash = {
    connectionId: "csv-local",
    scheduleId: schedule.scheduleId,
    expectedSourceRevision: schedule.sourceRevision,
    additions: [addition],
    absences: [absence],
    ...overrides,
  };
  const payload: ApplyUpdatePayloadForHash = commandWithoutHash;
  return {
    ...commandWithoutHash,
    operation: { operationId, requestHash: computeRequestHash(payload) },
  };
}

const endpoint: ContactEndpointRef = {
  provider: "fake-mailbox",
  connectionId: "mailbox-1",
  endpointKey: "staff-replacement",
  endpointVersion: 1,
};

function sendCommand(
  operationId: string,
  body = "18時から参加できます",
  kind: SendCommand["kind"] = "INITIAL_OFFER",
  to = endpoint,
): SendCommand {
  return {
    operation: { operationId, requestHash: computeRequestHash({ to, kind, body }) },
    to,
    kind,
    body,
  };
}

describe("FakeScheduleGateway", () => {
  it("PREPAREDの読戻しで欠勤と代替勤務を区別し、正式版を変更しない", async () => {
    const gateway = new FakeScheduleGateway({ initialSchedule: schedule });
    const result = await gateway.applyUpdate(scheduleCommand("operation-prepared"));

    expect(result.kind).toBe("PREPARED");
    expect(result.artifactRef).toBeDefined();
    const readBack = await gateway.readBack({
      connectionId: "csv-local",
      artifactRef: result.artifactRef!,
    });
    expect(readBack.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ shiftAssignmentId: "shift-absent", status: "ABSENT" }),
        expect.objectContaining({ shiftAssignmentId: "shift-replacement", status: "SCHEDULED" }),
      ]),
    );
    await expect(
      gateway.readBack({ connectionId: "another-connection", artifactRef: result.artifactRef! }),
    ).rejects.toThrow("artifactRef");
    await expect(
      gateway.loadSchedule({ connectionId: "csv-local", scheduleId: schedule.scheduleId }),
    ).resolves.toEqual(schedule);
  });

  it("同じoperationIdの再実行は保存結果を返し、異なるrequestHashは拒否する（D07）", async () => {
    const gateway = new FakeScheduleGateway({ initialSchedule: schedule });
    const first = scheduleCommand("operation-idempotent");
    const replay = await gateway.applyUpdate(first);
    const same = await gateway.applyUpdate(first);
    const conflict = await gateway.applyUpdate(
      scheduleCommand("operation-idempotent", {
        additions: [{ ...addition, staffId: "staff-other" }],
      }),
    );

    expect(same).toEqual(replay);
    expect(conflict.kind).toBe("CONFLICT");
    expect(conflict.revisionCheckEnforced).toBe(false);
    expect(gateway.applyCalls).toHaveLength(3);
  });

  it("結果不明を照会可能な結果へ変換せず、その後の結果照会を別に扱う（A03）", async () => {
    const gateway = new FakeScheduleGateway({ initialSchedule: schedule });
    const command = scheduleCommand("operation-unknown");
    gateway.setNextApplyOutcome({
      kind: "UNKNOWN",
      lookupResult: {
        operation: command.operation,
        kind: "APPLIED",
        revisionCheckEnforced: true,
        mappings: [],
        detail: "fake lookup confirmed the external result",
      },
    });

    const initial = await gateway.applyUpdate(command);
    const lookedUp = await gateway.getUpdateResult({
      operationId: command.operation.operationId,
      connectionId: command.connectionId,
      expectedRequestHash: command.operation.requestHash,
    });

    expect(initial.kind).toBe("UNKNOWN");
    expect(lookedUp).toMatchObject({ kind: "APPLIED" });
  });

  it("結果照会不能を未採用へ読み替えない（A03）", async () => {
    const gateway = new FakeScheduleGateway({ initialSchedule: schedule });
    const command = scheduleCommand("operation-lookup-unavailable");
    gateway.setNextApplyOutcome({ kind: "UNKNOWN", lookup: "UNAVAILABLE" });
    await gateway.applyUpdate(command);

    await expect(
      gateway.getUpdateResult({
        operationId: command.operation.operationId,
        connectionId: command.connectionId,
        expectedRequestHash: command.operation.requestHash,
      }),
    ).resolves.toBe("LOOKUP_UNAVAILABLE");
  });

  it("期待版が古い場合はCONFLICTとして保存し、更新を作らない（A04）", async () => {
    const gateway = new FakeScheduleGateway({ initialSchedule: schedule });
    const command = scheduleCommand("operation-old-revision", {
      expectedSourceRevision: "source-revision-old",
    });

    const result = await gateway.applyUpdate(command);

    expect(result.kind).toBe("CONFLICT");
    expect(result.artifactRef).toBeUndefined();
    expect(gateway.readBackCalls).toHaveLength(0);
  });

  it("能力フラグに応じて版読込不能・冪等性なし・照会不能・非一括を再現する", async () => {
    const gateway = new FakeScheduleGateway({
      initialSchedule: schedule,
      capabilities: {
        canReadRevision: true,
        canConditionalUpdate: false,
        supportsIdempotencyKey: false,
        supportsResultLookup: false,
        supportsAtomicBatch: false,
      },
    });
    const command = scheduleCommand("operation-capabilities", { absences: [] });

    const first = await gateway.applyUpdate(command);
    const second = await gateway.applyUpdate(command);

    expect(first.revisionCheckEnforced).toBe(false);
    expect(second.artifactRef).not.toBe(first.artifactRef);
    await expect(
      gateway.getUpdateResult({
        operationId: command.operation.operationId,
        connectionId: command.connectionId,
        expectedRequestHash: command.operation.requestHash,
      }),
    ).resolves.toBe("LOOKUP_UNAVAILABLE");
    await expect(gateway.applyUpdate(scheduleCommand("operation-batch"))).rejects.toThrow(
      "atomic batch",
    );
  });

  it("版を読めない接続は勤務表の読込を拒否する", async () => {
    const gateway = new FakeScheduleGateway({
      initialSchedule: schedule,
      capabilities: {
        canReadRevision: false,
        canConditionalUpdate: false,
        supportsIdempotencyKey: true,
        supportsResultLookup: true,
        supportsAtomicBatch: true,
      },
    });

    await expect(
      gateway.loadSchedule({ connectionId: "csv-local", scheduleId: schedule.scheduleId }),
    ).rejects.toThrow("sourceRevision");
  });

  it("設定した読戻し結果をそのまま返し、検査を上位層へ委ねる", async () => {
    const gateway = new FakeScheduleGateway({ initialSchedule: schedule });
    gateway.setNextApplyOutcome({
      kind: "PREPARED",
      artifactRef: "fake://configured-read-back",
      readBack: {
        artifactRef: "fake://configured-read-back",
        sourceRevision: "unexpected-revision",
        assignments: [],
      },
    });

    const result = await gateway.applyUpdate(scheduleCommand("operation-read-back"));

    await expect(
      gateway.readBack({ connectionId: "csv-local", artifactRef: result.artifactRef! }),
    ).resolves.toEqual({
      artifactRef: "fake://configured-read-back",
      sourceRevision: "unexpected-revision",
      assignments: [],
    });
  });
});

describe("FakeMessagingGateway", () => {
  it("宛先版が変わった打診を送信せず、旧宛先へ流用しない（A15）", async () => {
    const gateway = new FakeMessagingGateway();
    gateway.setEndpoint(endpoint);
    const command = sendCommand("send-endpoint-changed");
    gateway.setEndpoint({ ...endpoint, endpointVersion: 2 });

    await expect(gateway.verifyEndpoint(endpoint)).resolves.toBe("CHANGED");
    await expect(gateway.send(command)).resolves.toMatchObject({ refused: "ENDPOINT_CHANGED" });
    expect(gateway.sendCalls).toHaveLength(1);
  });

  it("同じ送信操作は再生し、異なるrequestHashは外部作用前に拒否する（D07）", async () => {
    const gateway = new FakeMessagingGateway();
    gateway.setEndpoint(endpoint);
    const first = sendCommand("send-idempotent");
    const sent = await gateway.send(first);
    const replay = await gateway.send(first);
    const conflict = await gateway.send(sendCommand("send-idempotent", "別の内容"));

    expect(sent).toMatchObject({ state: "ACCEPTED", match: "NEW" });
    expect(replay).toMatchObject({ state: "ACCEPTED", match: "REPLAY" });
    expect(conflict).toMatchObject({ refused: "CONFLICT" });
  });

  it("provider・接続・operationIdの範囲で送信結果を分離する", async () => {
    const gateway = new FakeMessagingGateway();
    const alternateEndpoint = { ...endpoint, provider: "fake-chat" };
    gateway.setEndpoint(endpoint);
    gateway.setEndpoint(alternateEndpoint);

    const first = await gateway.send(sendCommand("send-provider-scope"));
    const second = await gateway.send(
      sendCommand(
        "send-provider-scope",
        "同じ操作IDだが別provider",
        "INITIAL_OFFER",
        alternateEndpoint,
      ),
    );

    expect(first).toMatchObject({ state: "ACCEPTED", match: "NEW" });
    expect(second).toMatchObject({ state: "ACCEPTED", match: "NEW" });
    await expect(
      gateway.getSendResult({
        operationId: "send-provider-scope",
        provider: alternateEndpoint.provider,
        connectionId: alternateEndpoint.connectionId,
      }),
    ).resolves.toMatchObject({ match: "NEW" });
  });

  it("接続範囲をまたいだ結果照会を許可しない（A15）", async () => {
    const gateway = new FakeMessagingGateway();
    gateway.setEndpoint(endpoint);
    const command = sendCommand("send-connection-scope");
    await gateway.send(command);

    await expect(
      gateway.getSendResult({
        operationId: command.operation.operationId,
        provider: endpoint.provider,
        connectionId: "another-connection",
        expectedRequestHash: command.operation.requestHash,
      }),
    ).resolves.toBe("LOOKUP_UNAVAILABLE");
  });

  it("UNKNOWN配送結果をFAILEDへ畳まない（A03）", async () => {
    const gateway = new FakeMessagingGateway();
    gateway.setEndpoint(endpoint);
    const command = sendCommand("send-unknown");
    gateway.setNextDeliveryState(command.to, command.operation.operationId, "UNKNOWN");

    const result = await gateway.send(command);

    expect(result).toMatchObject({ state: "UNKNOWN", match: "NEW" });
  });

  it("送信結果のrequestHash不一致を照会時にCONFLICTへする", async () => {
    const gateway = new FakeMessagingGateway();
    gateway.setEndpoint(endpoint);
    const command = sendCommand("send-lookup-conflict");
    await gateway.send(command);

    await expect(
      gateway.getSendResult({
        operationId: command.operation.operationId,
        provider: endpoint.provider,
        connectionId: endpoint.connectionId,
        expectedRequestHash: computeRequestHash({ changed: true }),
      }),
    ).resolves.toBe("CONFLICT");
  });

  it("現在の宛先が無い場合はUNVERIFIABLEを返す", async () => {
    const gateway = new FakeMessagingGateway();

    await expect(gateway.verifyEndpoint(endpoint)).resolves.toBe("UNVERIFIABLE");
  });

  it("連絡不許可は送信前の拒否として扱う", async () => {
    const gateway = new FakeMessagingGateway();
    gateway.setEndpoint(endpoint, false);

    await expect(gateway.send(sendCommand("send-not-permitted"))).resolves.toMatchObject({
      refused: "NOT_PERMITTED",
    });
  });
});
