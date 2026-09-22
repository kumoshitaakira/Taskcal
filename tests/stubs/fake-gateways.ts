import type {
  ApplyUpdateCommand,
  AuthoritativeScheduleRef,
  LoadedAssignment,
  LoadedSchedule,
  PlannedAssignment,
  ReadBackResult,
  ScheduleGateway,
  SourceCapabilities,
  UpdateResult,
} from "@/contracts/schedule-gateway";
import type {
  ContactEndpointRef,
  EndpointCheck,
  MessagingGateway,
  SendCommand,
  SendResult,
  SendRefused,
} from "@/contracts/messaging-gateway";
import type { DeliveryState } from "@/contracts/outreach-state";
import type { OperationId, RequestHash } from "@/contracts/operation";
import type { UpdateResultKind } from "@/contracts/schedule-update";

const DEFAULT_SCHEDULE_CAPABILITIES: SourceCapabilities = {
  canReadRevision: true,
  canConditionalUpdate: true,
  supportsIdempotencyKey: true,
  supportsResultLookup: true,
  supportsAtomicBatch: true,
};

export interface FakeScheduleApplyOutcome {
  readonly kind: UpdateResultKind;
  /** 結果照会を使えるか。既定は true。 */
  readonly lookup?: "AVAILABLE" | "UNAVAILABLE";
  /** UNKNOWNの後に照会できる結果など、照会時だけ返す結果。 */
  readonly lookupResult?: UpdateResult;
  /** 既定の作業成果物とは異なる読戻し結果を使う。A07向け。 */
  readonly readBack?: ReadBackResult;
  readonly mappings?: readonly UpdateResult["mappings"][number][];
  readonly artifactRef?: string;
  readonly newSourceRevision?: string;
  readonly detail?: string;
}

interface StoredScheduleUpdate {
  readonly connectionId: string;
  readonly requestHash: RequestHash;
  readonly result: UpdateResult;
  readonly lookupResult: UpdateResult;
  readonly lookupAvailable: boolean;
  readonly readBack?: ReadBackResult;
}

function updateKey(connectionId: string, operationId: OperationId): string {
  return `${connectionId}\u0000${operationId}`;
}

function cloneAssignments(assignments: readonly LoadedAssignment[]): LoadedAssignment[] {
  return assignments.map((assignment) => ({ ...assignment }));
}

function cloneSchedule(schedule: LoadedSchedule): LoadedSchedule {
  return {
    ...schedule,
    requestedRange: { ...schedule.requestedRange },
    missingDates: [...schedule.missingDates],
    assignments: cloneAssignments(schedule.assignments),
  };
}

function cloneUpdateResult(result: UpdateResult): UpdateResult {
  return {
    ...result,
    operation: { ...result.operation },
    mappings: result.mappings.map((mapping) => ({ ...mapping })),
  };
}

function cloneReadBack(result: ReadBackResult): ReadBackResult {
  return {
    ...result,
    assignments: cloneAssignments(result.assignments),
  };
}

function conflictResult(
  command: ApplyUpdateCommand,
  detail: string,
  revisionCheckEnforced = false,
): UpdateResult {
  return {
    operation: { ...command.operation },
    kind: "CONFLICT",
    revisionCheckEnforced,
    mappings: [],
    detail,
  };
}

/**
 * 正式採用を行わない、決定的なScheduleGateway fake。
 *
 * `applyUpdate`は作業成果物と照会結果を記録するだけで、正式版参照を切り替えない。
 * その境界を越えるテストでは`setCurrentSchedule`を明示的に呼び、A側の正式採用処理
 * と混同しないようにする。同じoperationId・異なるrequestHash、版競合、結果不明、
 * readBack不一致をテストから再現できる。能力フラグが false の接続は、対応する
 * 保証を持たない状態として明示的に再現する。入力内容そのものの妥当性検査は、
 * このfakeでは行わず、呼出し元のアプリケーション層に委ねる。
 */
export class FakeScheduleGateway implements ScheduleGateway {
  readonly capabilities: SourceCapabilities;
  readonly loadCalls: Array<{
    readonly connectionId: string;
    readonly scheduleId: string;
    readonly authoritative?: AuthoritativeScheduleRef;
  }> = [];
  readonly applyCalls: ApplyUpdateCommand[] = [];
  readonly resultLookupCalls: Array<{
    readonly operationId: OperationId;
    readonly connectionId: string;
    readonly expectedRequestHash?: RequestHash;
  }> = [];
  readonly readBackCalls: Array<{ readonly connectionId: string; readonly artifactRef: string }> =
    [];

  private currentSchedule: LoadedSchedule;
  private nextOutcome: FakeScheduleApplyOutcome = { kind: "PREPARED" };
  private readonly outcomes = new Map<OperationId, FakeScheduleApplyOutcome>();
  private readonly updates = new Map<string, StoredScheduleUpdate>();
  private artifactSequence = 0;

  constructor(input: {
    readonly initialSchedule: LoadedSchedule;
    readonly capabilities?: SourceCapabilities;
  }) {
    this.currentSchedule = cloneSchedule(input.initialSchedule);
    this.capabilities = input.capabilities ?? DEFAULT_SCHEDULE_CAPABILITIES;
  }

  /** 正式版参照を明示的に進めるテスト用操作。正式採用サービスの代替ではない。 */
  setCurrentSchedule(schedule: LoadedSchedule): void {
    this.currentSchedule = cloneSchedule(schedule);
  }

  setNextApplyOutcome(outcome: FakeScheduleApplyOutcome): void {
    this.nextOutcome = outcome;
  }

  setApplyOutcome(operationId: OperationId, outcome: FakeScheduleApplyOutcome): void {
    this.outcomes.set(operationId, outcome);
  }

  async loadSchedule(ref: {
    readonly connectionId: string;
    readonly scheduleId: string;
    readonly authoritative?: AuthoritativeScheduleRef;
  }): Promise<LoadedSchedule> {
    this.loadCalls.push({ ...ref });
    if (!this.capabilities.canReadRevision) {
      throw new Error("fake sourceRevision is unavailable");
    }
    if (ref.scheduleId !== this.currentSchedule.scheduleId) {
      throw new Error("fake scheduleId mismatch");
    }
    if (
      ref.authoritative &&
      ref.authoritative.sourceRevision !== this.currentSchedule.sourceRevision
    ) {
      throw new Error("fake authoritative sourceRevision mismatch");
    }
    return cloneSchedule(this.currentSchedule);
  }

  async applyUpdate(command: ApplyUpdateCommand): Promise<UpdateResult> {
    this.applyCalls.push(command);
    const key = updateKey(command.connectionId, command.operation.operationId);
    if (this.capabilities.supportsIdempotencyKey) {
      const previous = this.updates.get(key);
      if (previous) {
        if (previous.requestHash !== command.operation.requestHash) {
          return conflictResult(command, "同じoperationIdに異なるrequestHashを指定しました。");
        }
        return cloneUpdateResult(previous.result);
      }
    }

    if (
      !this.capabilities.supportsAtomicBatch &&
      command.additions.length + command.absences.length > 1
    ) {
      throw new Error("fake atomic batch is unavailable");
    }

    if (
      this.capabilities.canConditionalUpdate &&
      command.expectedSourceRevision !== this.currentSchedule.sourceRevision
    ) {
      const result = conflictResult(
        command,
        "期待したsourceRevisionと現在版が一致しません。",
        true,
      );
      this.updates.set(key, {
        connectionId: command.connectionId,
        requestHash: command.operation.requestHash,
        result,
        lookupResult: result,
        lookupAvailable: this.capabilities.supportsResultLookup,
      });
      return cloneUpdateResult(result);
    }

    const configured = this.outcomes.get(command.operation.operationId) ?? this.nextOutcome;
    this.nextOutcome = { kind: "PREPARED" };
    const artifactRef =
      configured.artifactRef ?? `fake://schedule-update/${++this.artifactSequence}`;
    const stagedRevision = configured.newSourceRevision ?? `fake-revision-${this.artifactSequence}`;
    const defaultMappings = command.additions
      .slice(0, configured.kind === "PARTIAL" ? 1 : undefined)
      .map((addition) => ({
        commitmentId: addition.commitmentId,
        shiftAssignmentId: addition.shiftAssignmentId,
      }));
    const result: UpdateResult = {
      operation: { ...command.operation },
      kind: configured.kind,
      ...(configured.kind === "UNKNOWN" || configured.kind === "NOT_APPLIED"
        ? {}
        : { artifactRef, newSourceRevision: stagedRevision }),
      revisionCheckEnforced: this.capabilities.canConditionalUpdate,
      mappings: [...(configured.mappings ?? defaultMappings)],
      ...(configured.detail ? { detail: configured.detail } : {}),
    };
    const readBack =
      configured.readBack ??
      (result.artifactRef
        ? {
            artifactRef: result.artifactRef,
            sourceRevision: result.newSourceRevision ?? this.currentSchedule.sourceRevision,
            assignments: this.materializeAssignments(command),
          }
        : undefined);
    const lookupResult = configured.lookupResult
      ? { ...cloneUpdateResult(configured.lookupResult), operation: { ...command.operation } }
      : result;
    this.updates.set(key, {
      connectionId: command.connectionId,
      requestHash: command.operation.requestHash,
      result,
      lookupResult,
      lookupAvailable:
        this.capabilities.supportsResultLookup && configured.lookup !== "UNAVAILABLE",
      ...(readBack ? { readBack: cloneReadBack(readBack) } : {}),
    });
    return cloneUpdateResult(result);
  }

  async getUpdateResult(ref: {
    readonly operationId: OperationId;
    readonly connectionId: string;
    readonly expectedRequestHash?: RequestHash;
  }): Promise<UpdateResult | "LOOKUP_UNAVAILABLE" | "CONFLICT"> {
    this.resultLookupCalls.push({ ...ref });
    const stored = this.updates.get(updateKey(ref.connectionId, ref.operationId));
    if (!stored || !stored.lookupAvailable) return "LOOKUP_UNAVAILABLE";
    if (ref.expectedRequestHash && ref.expectedRequestHash !== stored.requestHash) {
      return "CONFLICT";
    }
    return cloneUpdateResult(stored.lookupResult);
  }

  async readBack(ref: {
    readonly connectionId: string;
    readonly artifactRef: string;
  }): Promise<ReadBackResult> {
    this.readBackCalls.push({ ...ref });
    for (const stored of this.updates.values()) {
      if (
        stored.connectionId === ref.connectionId &&
        stored.readBack?.artifactRef === ref.artifactRef
      ) {
        return cloneReadBack(stored.readBack);
      }
    }
    throw new Error("fake artifactRef is not available");
  }

  private materializeAssignments(command: ApplyUpdateCommand): LoadedAssignment[] {
    const absences = new Map(
      command.absences.map((absence) => [absence.shiftAssignmentId, absence]),
    );
    const assignments = this.currentSchedule.assignments.map((assignment) => {
      const absence = absences.get(assignment.shiftAssignmentId);
      return absence
        ? {
            ...assignment,
            startAt: absence.startAt,
            endAt: absence.endAt,
            status: "ABSENT" as const,
          }
        : { ...assignment };
    });
    const additions: LoadedAssignment[] = command.additions.map((addition: PlannedAssignment) => ({
      shiftAssignmentId: addition.shiftAssignmentId,
      staffId: addition.staffId,
      roleCode: addition.roleCode,
      startAt: addition.startAt,
      endAt: addition.endAt,
      status: "SCHEDULED",
      sourceCaseId: addition.sourceCaseId,
    }));
    return [...assignments, ...additions].sort((a, b) =>
      a.shiftAssignmentId.localeCompare(b.shiftAssignmentId),
    );
  }
}

interface FakeEndpointState {
  readonly endpoint: ContactEndpointRef;
  readonly permitted: boolean;
}

function endpointKey(endpoint: ContactEndpointRef): string {
  return `${endpoint.provider}\u0000${endpoint.connectionId}\u0000${endpoint.endpointKey}`;
}

function sendKey(provider: string, connectionId: string, operationId: OperationId): string {
  return `${provider}\u0000${connectionId}\u0000${operationId}`;
}

function sendScopeKey(provider: string, connectionId: string): string {
  return `${provider}\u0000${connectionId}`;
}

function cloneSendResult(result: SendResult): SendResult {
  return { ...result, operation: { ...result.operation } };
}

function cloneCommand(command: SendCommand): SendCommand {
  return { ...command, operation: { ...command.operation }, to: { ...command.to } };
}

/**
 * 外部メッセージングを発生させない、決定的なMessagingGateway fake。
 * 宛先変更・連絡不許可・同一操作の再生・requestHash衝突・結果不明を再現する。
 */
export class FakeMessagingGateway implements MessagingGateway {
  readonly sendCalls: SendCommand[] = [];
  readonly resultLookupCalls: Array<{
    readonly operationId: OperationId;
    readonly provider: string;
    readonly connectionId: string;
    readonly expectedRequestHash?: RequestHash;
  }> = [];
  readonly verifyCalls: ContactEndpointRef[] = [];

  private readonly endpoints = new Map<string, FakeEndpointState>();
  private readonly sent = new Map<string, SendResult>();
  private readonly nextStates = new Map<string, DeliveryState>();
  private readonly lookupAvailable = new Map<string, boolean>();
  private messageSequence = 0;

  setEndpoint(endpoint: ContactEndpointRef, permitted = true): void {
    this.endpoints.set(endpointKey(endpoint), { endpoint: { ...endpoint }, permitted });
  }

  removeEndpoint(endpoint: ContactEndpointRef): void {
    this.endpoints.delete(endpointKey(endpoint));
  }

  setNextDeliveryState(
    ref: Pick<ContactEndpointRef, "provider" | "connectionId">,
    operationId: OperationId,
    state: DeliveryState,
  ): void {
    this.nextStates.set(sendKey(ref.provider, ref.connectionId, operationId), state);
  }

  setLookupAvailable(
    ref: Pick<ContactEndpointRef, "provider" | "connectionId">,
    available: boolean,
  ): void {
    this.lookupAvailable.set(sendScopeKey(ref.provider, ref.connectionId), available);
  }

  async send(command: SendCommand): Promise<SendResult | SendRefused> {
    this.sendCalls.push(cloneCommand(command));
    const key = sendKey(
      command.to.provider,
      command.to.connectionId,
      command.operation.operationId,
    );
    const previous = this.sent.get(key);
    if (previous) {
      if (previous.operation.requestHash !== command.operation.requestHash) {
        return {
          refused: "CONFLICT",
          detail: "同じoperationIdに異なるrequestHashを指定しました。",
        };
      }
      return { ...cloneSendResult(previous), match: "REPLAY" };
    }

    const state = this.endpoints.get(endpointKey(command.to));
    if (!state || state.endpoint.endpointVersion !== command.to.endpointVersion) {
      return { refused: "ENDPOINT_CHANGED", detail: "送信先の版を確認できません。" };
    }
    if (!state.permitted) {
      return { refused: "NOT_PERMITTED", detail: "現在の連絡許可を確認できません。" };
    }

    const deliveryKey = sendKey(
      command.to.provider,
      command.to.connectionId,
      command.operation.operationId,
    );
    const deliveryState = this.nextStates.get(deliveryKey) ?? "ACCEPTED";
    this.nextStates.delete(deliveryKey);
    const result: SendResult = {
      operation: { ...command.operation },
      state: deliveryState,
      match: "NEW",
      ...(deliveryState === "ACCEPTED"
        ? { providerMessageId: `fake-message-${++this.messageSequence}` }
        : {}),
      ...(deliveryState === "UNKNOWN" ? { detail: "fake configured an unknown outcome" } : {}),
    };
    this.sent.set(key, result);
    return cloneSendResult(result);
  }

  async getSendResult(ref: {
    readonly operationId: OperationId;
    readonly provider: string;
    readonly connectionId: string;
    readonly expectedRequestHash?: RequestHash;
  }): Promise<SendResult | "LOOKUP_UNAVAILABLE" | "CONFLICT"> {
    this.resultLookupCalls.push({ ...ref });
    if (this.lookupAvailable.get(sendScopeKey(ref.provider, ref.connectionId)) === false) {
      return "LOOKUP_UNAVAILABLE";
    }
    const result = this.sent.get(sendKey(ref.provider, ref.connectionId, ref.operationId));
    if (!result) return "LOOKUP_UNAVAILABLE";
    if (ref.expectedRequestHash && ref.expectedRequestHash !== result.operation.requestHash) {
      return "CONFLICT";
    }
    return cloneSendResult(result);
  }

  async verifyEndpoint(ref: ContactEndpointRef): Promise<EndpointCheck> {
    this.verifyCalls.push({ ...ref });
    const state = this.endpoints.get(endpointKey(ref));
    if (!state) return "UNVERIFIABLE";
    return state.endpoint.endpointVersion === ref.endpointVersion ? "MATCHES" : "CHANGED";
  }
}
