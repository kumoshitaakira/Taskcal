import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskcalError } from "../../contracts/errors";
import { computeRequestHash, type OperationRef, type RequestHash } from "../../contracts/operation";
import type {
  ApplyUpdateCommand,
  AuthoritativeScheduleRef,
  ConnectionId,
  LoadedAssignment,
  LoadedSchedule,
  ReadBackResult,
  ScheduleGateway,
  SourceCapabilities,
  UpdateResult,
} from "../../contracts/schedule-gateway";
import {
  CSV_COLUMNS,
  parseMonthlyCsv,
  type CsvAssignment,
  type CsvManifest,
  type MonthlyCsv,
} from "./monthly-csv";

const DEFAULT_CAPABILITIES: SourceCapabilities = {
  canReadRevision: true,
  canConditionalUpdate: true,
  supportsIdempotencyKey: true,
  supportsResultLookup: true,
  supportsAtomicBatch: true,
};

export interface CsvSourceDocument {
  readonly csv: string;
  readonly manifest: unknown;
}

/** 原CSVを読み取るport。書込み側からは参照専用にする。 */
export interface CsvScheduleSource {
  read(): Promise<CsvSourceDocument>;
}

/** 開発用の原CSVと範囲宣言をファイルから読むsource。 */
export class FileCsvScheduleSource implements CsvScheduleSource {
  constructor(
    private readonly csvPath: string,
    private readonly manifestPath: string,
  ) {}

  async read(): Promise<CsvSourceDocument> {
    const [csv, manifestText] = await Promise.all([
      readFile(this.csvPath, "utf8"),
      readFile(this.manifestPath, "utf8"),
    ]);
    return { csv, manifest: JSON.parse(manifestText) as unknown };
  }
}

export type CsvArtifactWriteResult = "WRITTEN" | "REUSED" | "CONFLICT";
export type CsvArtifactReadResult = CsvSourceDocument | "NOT_FOUND" | "CORRUPT";

/** 成果物の保管を操作結果の保管から分離するport。 */
export interface CsvArtifactStore {
  write(input: {
    readonly connectionId: ConnectionId;
    readonly artifactRef: string;
    readonly csv: string;
    readonly manifest: CsvManifest;
  }): Promise<CsvArtifactWriteResult>;
  read(input: {
    readonly connectionId: ConnectionId;
    readonly artifactRef: string;
  }): Promise<CsvArtifactReadResult>;
}

export interface CsvOperationStore {
  begin(input: {
    readonly connectionId: ConnectionId;
    readonly operation: OperationRef;
  }): Promise<
    | { readonly kind: "NEW" }
    | { readonly kind: "REPLAY"; readonly result: UpdateResult }
    | { readonly kind: "CONFLICT" }
    | { readonly kind: "IN_PROGRESS" }
  >;
  complete(input: {
    readonly connectionId: ConnectionId;
    readonly operation: OperationRef;
    readonly result: UpdateResult;
  }): Promise<void>;
  lookup(input: {
    readonly connectionId: ConnectionId;
    readonly operationId: string;
    readonly expectedRequestHash?: RequestHash;
  }): Promise<UpdateResult | "NOT_FOUND" | "IN_PROGRESS" | "UNAVAILABLE" | "CONFLICT">;
}

interface StoredOperationRecord {
  readonly version: 1;
  readonly connectionId: ConnectionId;
  readonly operationId: string;
  readonly requestHash: RequestHash;
  readonly state: "IN_PROGRESS" | "COMPLETE";
  readonly result?: UpdateResult;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneAssignment(assignment: LoadedAssignment): LoadedAssignment {
  return { ...assignment };
}

function cloneUpdateResult(result: UpdateResult): UpdateResult {
  return {
    ...result,
    operation: { ...result.operation },
    mappings: result.mappings.map((mapping) => ({ ...mapping })),
  };
}

function artifactKey(connectionId: string, artifactRef: string): string {
  return computeRequestHash({ connectionId, artifactRef });
}

function operationKey(connectionId: string, operationId: string): string {
  return computeRequestHash({ connectionId, operationId });
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** 1操作1ファイルの永続port。DBのoperation_result契約を変更せず、再起動後も照会できる。 */
export class FileCsvOperationStore implements CsvOperationStore {
  constructor(private readonly directory: string) {}

  private filePath(connectionId: string, operationId: string): string {
    return path.join(this.directory, `${operationKey(connectionId, operationId)}.json`);
  }

  private async readRecord(filePath: string): Promise<StoredOperationRecord | undefined> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      const record = JSON.parse(text) as StoredOperationRecord;
      if (
        record.version !== 1 ||
        typeof record.connectionId !== "string" ||
        typeof record.operationId !== "string" ||
        typeof record.requestHash !== "string" ||
        (record.state !== "IN_PROGRESS" && record.state !== "COMPLETE")
      ) {
        throw new Error("invalid operation record");
      }
      return record;
    } catch {
      throw new TaskcalError("RECONCILE_REQUIRED", "CSV操作結果の保存記録を照合できません。");
    }
  }

  async begin(input: {
    readonly connectionId: ConnectionId;
    readonly operation: OperationRef;
  }): Promise<
    | { readonly kind: "NEW" }
    | { readonly kind: "REPLAY"; readonly result: UpdateResult }
    | { readonly kind: "CONFLICT" }
    | { readonly kind: "IN_PROGRESS" }
  > {
    await mkdir(this.directory, { recursive: true });
    const filePath = this.filePath(input.connectionId, input.operation.operationId);
    const record: StoredOperationRecord = {
      version: 1,
      connectionId: input.connectionId,
      operationId: input.operation.operationId,
      requestHash: input.operation.requestHash,
      state: "IN_PROGRESS",
    };
    try {
      await writeFile(filePath, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
      return { kind: "NEW" };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    const existing = await this.readRecord(filePath);
    if (!existing) return this.begin(input);
    if (
      existing.connectionId !== input.connectionId ||
      existing.operationId !== input.operation.operationId ||
      existing.requestHash !== input.operation.requestHash
    ) {
      return { kind: "CONFLICT" };
    }
    if (existing.state === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
    if (!existing.result) {
      throw new TaskcalError("RECONCILE_REQUIRED", "CSV操作結果が欠落しています。");
    }
    return { kind: "REPLAY", result: cloneUpdateResult(existing.result) };
  }

  async complete(input: {
    readonly connectionId: ConnectionId;
    readonly operation: OperationRef;
    readonly result: UpdateResult;
  }): Promise<void> {
    const filePath = this.filePath(input.connectionId, input.operation.operationId);
    const existing = await this.readRecord(filePath);
    if (!existing || existing.requestHash !== input.operation.requestHash) {
      throw new TaskcalError("RECONCILE_REQUIRED", "CSV操作結果の完了記録を照合できません。");
    }
    if (existing.state === "COMPLETE") return;
    const complete: StoredOperationRecord = {
      ...existing,
      state: "COMPLETE",
      result: cloneUpdateResult(input.result),
    };
    await writeJsonAtomically(filePath, complete);
  }

  async lookup(input: {
    readonly connectionId: ConnectionId;
    readonly operationId: string;
    readonly expectedRequestHash?: RequestHash;
  }): Promise<UpdateResult | "NOT_FOUND" | "IN_PROGRESS" | "UNAVAILABLE" | "CONFLICT"> {
    const existing = await this.readRecord(this.filePath(input.connectionId, input.operationId));
    if (!existing) return "NOT_FOUND";
    if (input.expectedRequestHash && input.expectedRequestHash !== existing.requestHash) {
      return "CONFLICT";
    }
    if (existing.state === "IN_PROGRESS") return "IN_PROGRESS";
    if (!existing.result) {
      throw new TaskcalError("RECONCILE_REQUIRED", "CSV操作結果が欠落しています。");
    }
    return cloneUpdateResult(existing.result);
  }
}

/** 成果物は接続範囲とartifactRefごとに別ファイルへ保持する。 */
export class FileCsvArtifactStore implements CsvArtifactStore {
  constructor(private readonly directory: string) {}

  private paths(
    connectionId: string,
    artifactRef: string,
  ): {
    readonly csvPath: string;
    readonly manifestPath: string;
  } {
    const connectionDirectory = path.join(this.directory, artifactKey(connectionId, "connection"));
    const key = artifactKey(connectionId, artifactRef);
    return {
      csvPath: path.join(connectionDirectory, `${key}.csv`),
      manifestPath: path.join(connectionDirectory, `${key}.manifest.json`),
    };
  }

  private async readExisting(paths: {
    readonly csvPath: string;
    readonly manifestPath: string;
  }): Promise<{ readonly csv: string; readonly manifest: CsvManifest } | "NONE" | "CORRUPT"> {
    let csv: string;
    let manifestText: string;
    try {
      [csv, manifestText] = await Promise.all([
        readFile(paths.csvPath, "utf8"),
        readFile(paths.manifestPath, "utf8"),
      ]);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        let csvExists = true;
        let manifestExists = true;
        try {
          await readFile(paths.csvPath);
        } catch (inner) {
          if (isNodeError(inner, "ENOENT")) csvExists = false;
        }
        try {
          await readFile(paths.manifestPath);
        } catch (inner) {
          if (isNodeError(inner, "ENOENT")) manifestExists = false;
        }
        return !csvExists && !manifestExists ? "NONE" : "CORRUPT";
      }
      throw error;
    }
    try {
      return { csv, manifest: JSON.parse(manifestText) as CsvManifest };
    } catch {
      return "CORRUPT";
    }
  }

  async write(input: {
    readonly connectionId: ConnectionId;
    readonly artifactRef: string;
    readonly csv: string;
    readonly manifest: CsvManifest;
  }): Promise<CsvArtifactWriteResult> {
    const paths = this.paths(input.connectionId, input.artifactRef);
    const existing = await this.readExisting(paths);
    if (existing === "CORRUPT") return "CONFLICT";
    if (existing !== "NONE") {
      return existing.csv === input.csv &&
        JSON.stringify(existing.manifest) === JSON.stringify(input.manifest)
        ? "REUSED"
        : "CONFLICT";
    }

    await mkdir(path.dirname(paths.csvPath), { recursive: true });
    try {
      await writeFile(paths.csvPath, input.csv, { encoding: "utf8", flag: "wx" });
      await writeFile(paths.manifestPath, JSON.stringify(input.manifest), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        const raced = await this.readExisting(paths);
        if (
          raced !== "NONE" &&
          raced !== "CORRUPT" &&
          raced.csv === input.csv &&
          JSON.stringify(raced.manifest) === JSON.stringify(input.manifest)
        ) {
          return "REUSED";
        }
        return "CONFLICT";
      }
      throw error;
    }
    return "WRITTEN";
  }

  async read(input: {
    readonly connectionId: ConnectionId;
    readonly artifactRef: string;
  }): Promise<CsvArtifactReadResult> {
    const paths = this.paths(input.connectionId, input.artifactRef);
    const existing = await this.readExisting(paths);
    if (existing === "NONE") return "NOT_FOUND";
    if (existing === "CORRUPT") return "CORRUPT";
    return { csv: existing.csv, manifest: existing.manifest };
  }
}

export interface CsvScheduleGatewayOptions {
  readonly source: CsvScheduleSource;
  /** 未指定のときは、同じディレクトリ下へ成果物と操作結果を保存する。 */
  readonly outputDir?: string;
  readonly artifacts?: CsvArtifactStore;
  readonly operations?: CsvOperationStore;
  readonly capabilities?: Partial<SourceCapabilities>;
  /** テスト・将来の保管連携用。返す文字列自体はファイルパスとして解釈しない。 */
  readonly artifactRefFactory?: (input: {
    readonly connectionId: ConnectionId;
    readonly operation: OperationRef;
  }) => string;
}

function conflictResult(
  command: ApplyUpdateCommand,
  detail: string,
  revisionCheckEnforced: boolean,
): UpdateResult {
  return {
    operation: { ...command.operation },
    kind: "CONFLICT",
    revisionCheckEnforced,
    mappings: [],
    detail,
  };
}

function unknownResult(
  command: ApplyUpdateCommand,
  detail: string,
  artifactRef?: string,
  newSourceRevision?: string,
  revisionCheckEnforced = false,
): UpdateResult {
  return {
    operation: { ...command.operation },
    kind: "UNKNOWN",
    ...(artifactRef ? { artifactRef } : {}),
    ...(newSourceRevision ? { newSourceRevision } : {}),
    revisionCheckEnforced,
    mappings: [],
    detail,
  };
}

function notAppliedResult(
  command: ApplyUpdateCommand,
  detail: string,
  revisionCheckEnforced: boolean,
): UpdateResult {
  return {
    operation: { ...command.operation },
    kind: "NOT_APPLIED",
    revisionCheckEnforced,
    mappings: [],
    detail,
  };
}

function monthlyRange(month: string): { readonly fromDate: string; readonly toDate: string } {
  const [year, number] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, number, 1));
  return {
    fromDate: `${month}-01`,
    toDate: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`,
  };
}

function serializeAssignments(assignments: readonly CsvAssignment[]): string {
  const sorted = [...assignments].sort((a, b) =>
    a.shiftAssignmentId.localeCompare(b.shiftAssignmentId),
  );
  return (
    [
      CSV_COLUMNS.join(","),
      ...sorted.map((row) => CSV_COLUMNS.map((column) => row[column] ?? "").join(",")),
    ].join("\n") + "\n"
  );
}

function sameAssignment(actual: LoadedAssignment, expected: LoadedAssignment): boolean {
  return (
    actual.shiftAssignmentId === expected.shiftAssignmentId &&
    actual.staffId === expected.staffId &&
    actual.roleCode === expected.roleCode &&
    actual.startAt === expected.startAt &&
    actual.endAt === expected.endAt &&
    actual.status === expected.status &&
    (actual.sourceCaseId ?? undefined) === (expected.sourceCaseId ?? undefined)
  );
}

function sameAssignments(
  actual: readonly LoadedAssignment[],
  expected: readonly LoadedAssignment[],
): boolean {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort((a, b) =>
    a.shiftAssignmentId.localeCompare(b.shiftAssignmentId),
  );
  const expectedSorted = [...expected].sort((a, b) =>
    a.shiftAssignmentId.localeCompare(b.shiftAssignmentId),
  );
  return actualSorted.every((assignment, index) =>
    sameAssignment(assignment, expectedSorted[index]),
  );
}

function operationPayload(command: ApplyUpdateCommand): unknown {
  return {
    connectionId: command.connectionId,
    scheduleId: command.scheduleId,
    expectedSourceRevision: command.expectedSourceRevision,
    ...(command.baseArtifactRef ? { baseArtifactRef: command.baseArtifactRef } : {}),
    additions: command.additions,
    absences: command.absences,
  };
}

function validateOperationHash(command: ApplyUpdateCommand): void {
  if (computeRequestHash(operationPayload(command)) !== command.operation.requestHash) {
    throw new TaskcalError("INVALID_INPUT", "操作内容とrequestHashが一致しません。");
  }
}

export class CsvScheduleGateway implements ScheduleGateway {
  readonly capabilities: SourceCapabilities;
  private readonly artifacts: CsvArtifactStore;
  private readonly operations: CsvOperationStore;
  private readonly artifactRefFactory: NonNullable<CsvScheduleGatewayOptions["artifactRefFactory"]>;

  constructor(options: CsvScheduleGatewayOptions) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    if ((!options.artifacts || !options.operations) && !options.outputDir) {
      throw new TaskcalError("INVALID_INPUT", "CSV成果物の出力先またはartifact storeが必要です。");
    }
    this.artifacts =
      options.artifacts ?? new FileCsvArtifactStore(path.join(options.outputDir!, "artifacts"));
    this.operations =
      options.operations ?? new FileCsvOperationStore(path.join(options.outputDir!, "operations"));
    this.artifactRefFactory =
      options.artifactRefFactory ??
      ((input) =>
        `csv://prepared/${computeRequestHash({
          connectionId: input.connectionId,
          operation: input.operation,
        })}`);
    this.source = options.source;
  }

  private readonly source: CsvScheduleSource;

  private async readSource(): Promise<MonthlyCsv> {
    const document = await this.source.read();
    return parseMonthlyCsv(document.csv, cloneJson(document.manifest));
  }

  private async readArtifact(connectionId: ConnectionId, artifactRef: string): Promise<MonthlyCsv> {
    const document = await this.artifacts.read({ connectionId, artifactRef });
    if (document === "NOT_FOUND" || document === "CORRUPT") {
      throw new TaskcalError("RECONCILE_REQUIRED", "CSV成果物を完全には読戻せません。");
    }
    return parseMonthlyCsv(document.csv, cloneJson(document.manifest));
  }

  private toLoadedSchedule(monthly: MonthlyCsv, scheduleId: string): LoadedSchedule {
    const day = monthly.manifest.days?.find((candidate) => candidate.scheduleId === scheduleId);
    const assignments = monthly.assignments
      .filter((assignment) => assignment.scheduleId === scheduleId)
      .map((assignment) => cloneAssignment(assignment));
    if (!day && assignments.length === 0) {
      throw new TaskcalError("INVALID_INPUT", "指定された勤務表をCSVから特定できません。");
    }
    return {
      scheduleId,
      sourceRevision: monthly.sourceRevision,
      requestedRange: monthlyRange(monthly.manifest.month),
      completeness: monthly.completeness,
      missingDates: [...monthly.missingDates],
      assignments,
    };
  }

  async loadSchedule(ref: {
    readonly connectionId: ConnectionId;
    readonly scheduleId: string;
    readonly authoritative?: AuthoritativeScheduleRef;
  }): Promise<LoadedSchedule> {
    if (!this.capabilities.canReadRevision) {
      throw new TaskcalError("OUT_OF_SCOPE", "このCSV接続ではsourceRevisionを読めません。");
    }
    let monthly: MonthlyCsv;
    if (ref.authoritative) {
      if (
        ref.authoritative.scheduleId !== ref.scheduleId ||
        ref.authoritative.artifactRef.length === 0
      ) {
        throw new TaskcalError("INVALID_INPUT", "正式版参照と勤務表IDが一致しません。");
      }
      monthly = await this.readArtifact(ref.connectionId, ref.authoritative.artifactRef);
      if (monthly.sourceRevision !== ref.authoritative.sourceRevision) {
        throw new TaskcalError("RECONCILE_REQUIRED", "正式版参照とCSV成果物の版が一致しません。");
      }
    } else {
      monthly = await this.readSource();
    }
    return this.toLoadedSchedule(monthly, ref.scheduleId);
  }

  private materialize(
    monthly: MonthlyCsv,
    command: ApplyUpdateCommand,
  ): { readonly monthly: MonthlyCsv; readonly assignments: readonly LoadedAssignment[] } {
    if (monthly.completeness !== "COMPLETE" || monthly.missingDates.length > 0) {
      throw new TaskcalError("RECONCILE_REQUIRED", "更新対象CSVの完全性を確認できません。");
    }
    const targetDay = monthly.manifest.days?.find((day) => day.scheduleId === command.scheduleId);
    if (!targetDay) {
      throw new TaskcalError("INVALID_INPUT", "更新対象の勤務表がCSV範囲宣言にありません。");
    }

    const existingById = new Map(
      monthly.assignments.map((assignment) => [assignment.shiftAssignmentId, assignment]),
    );
    const absenceIds = new Set<string>();
    for (const absence of command.absences) {
      if (absenceIds.has(absence.shiftAssignmentId)) {
        throw new TaskcalError("INVALID_INPUT", "欠勤対象の勤務IDが重複しています。");
      }
      absenceIds.add(absence.shiftAssignmentId);
      const existing = existingById.get(absence.shiftAssignmentId);
      if (!existing || existing.scheduleId !== command.scheduleId) {
        throw new TaskcalError("INVALID_INPUT", "欠勤対象の勤務をCSVから特定できません。");
      }
      if (existing.status === "CANCELLED") {
        throw new TaskcalError("OUT_OF_SCOPE", "取消済み勤務を欠勤へ変更できません。");
      }
      if (existing.startAt !== absence.startAt || existing.endAt !== absence.endAt) {
        throw new TaskcalError("INVALID_INPUT", "欠勤区間が元勤務と一致しません。");
      }
    }

    const additionIds = new Set<string>();
    for (const addition of command.additions) {
      if (
        additionIds.has(addition.shiftAssignmentId) ||
        existingById.has(addition.shiftAssignmentId)
      ) {
        throw new TaskcalError("INVALID_INPUT", "追加勤務の勤務IDが既存勤務と重複しています。");
      }
      additionIds.add(addition.shiftAssignmentId);
      if (
        addition.startAt.slice(0, 10) !== targetDay.date ||
        addition.endAt.slice(0, 10) !== targetDay.date
      ) {
        throw new TaskcalError("OUT_OF_SCOPE", "追加勤務は対象勤務表と同じ営業日のみ対応します。");
      }
    }

    const absences = new Map(
      command.absences.map((absence) => [absence.shiftAssignmentId, absence]),
    );
    const assignments: CsvAssignment[] = monthly.assignments.map((assignment) => {
      const absence = absences.get(assignment.shiftAssignmentId);
      return absence
        ? { ...assignment, status: "ABSENT", startAt: absence.startAt, endAt: absence.endAt }
        : { ...assignment };
    });
    for (const addition of command.additions) {
      assignments.push({
        scheduleId: command.scheduleId,
        businessDate: targetDay.date,
        shiftAssignmentId: addition.shiftAssignmentId,
        staffId: addition.staffId,
        roleCode: addition.roleCode,
        startAt: addition.startAt,
        endAt: addition.endAt,
        status: "SCHEDULED",
        sourceCaseId: addition.sourceCaseId,
      });
    }

    const additionIdsForManifest = command.additions.map((addition) =>
      addition.shiftAssignmentId.toLowerCase(),
    );
    const manifest: CsvManifest = {
      ...cloneJson(monthly.manifest),
      staffIds: [...monthly.manifest.staffIds],
      days: monthly.manifest.days?.map((day) =>
        day.scheduleId === command.scheduleId
          ? { ...day, assignmentIds: [...day.assignmentIds, ...additionIdsForManifest].sort() }
          : { ...day, assignmentIds: [...day.assignmentIds] },
      ),
    };
    const normalizedCsv = serializeAssignments(assignments);
    const nextMonthly = parseMonthlyCsv(normalizedCsv, manifest);
    return {
      monthly: nextMonthly,
      assignments: nextMonthly.assignments,
    };
  }

  private async prepareUpdate(command: ApplyUpdateCommand): Promise<UpdateResult> {
    let monthly: MonthlyCsv;
    try {
      monthly = command.baseArtifactRef
        ? await this.readArtifact(command.connectionId, command.baseArtifactRef)
        : await this.readSource();
    } catch {
      return unknownResult(command, "更新前のCSV原本を完全には読み込めません。");
    }

    const revisionCheckEnforced = this.capabilities.canConditionalUpdate;
    if (revisionCheckEnforced && command.expectedSourceRevision !== monthly.sourceRevision) {
      return conflictResult(command, "期待したsourceRevisionと現在版が一致しません。", true);
    }
    if (
      !this.capabilities.supportsAtomicBatch &&
      command.additions.length + command.absences.length > 1
    ) {
      return notAppliedResult(
        command,
        "この接続では複数勤務の一括作成を保証できません。",
        revisionCheckEnforced,
      );
    }

    let staged: { readonly monthly: MonthlyCsv; readonly assignments: readonly LoadedAssignment[] };
    try {
      staged = this.materialize(monthly, command);
    } catch (error) {
      if (error instanceof TaskcalError && error.code === "RECONCILE_REQUIRED") {
        return unknownResult(
          command,
          "更新対象CSVの完全性を確認できません。",
          undefined,
          undefined,
          revisionCheckEnforced,
        );
      }
      if (error instanceof TaskcalError) {
        return notAppliedResult(
          command,
          "CSV更新内容を作業成果物へ変換できません。",
          revisionCheckEnforced,
        );
      }
      throw error;
    }

    let artifactRef: string;
    try {
      artifactRef = this.artifactRefFactory({
        connectionId: command.connectionId,
        operation: command.operation,
      });
      const writeResult = await this.artifacts.write({
        connectionId: command.connectionId,
        artifactRef,
        csv: staged.monthly.normalizedCsv,
        manifest: staged.monthly.manifest,
      });
      if (writeResult === "CONFLICT") {
        return conflictResult(
          command,
          "同じartifactRefに異なるCSV成果物があります。",
          revisionCheckEnforced,
        );
      }

      const readBack = await this.readBack({
        connectionId: command.connectionId,
        artifactRef,
      });
      if (
        readBack.sourceRevision !== staged.monthly.sourceRevision ||
        !sameAssignments(readBack.assignments, staged.assignments)
      ) {
        return unknownResult(
          command,
          "CSV成果物のreadBackが期待内容と一致しません。",
          artifactRef,
          staged.monthly.sourceRevision,
          revisionCheckEnforced,
        );
      }
    } catch {
      return unknownResult(
        command,
        "CSV成果物の保存またはreadBackを完了できません。",
        artifactRef!,
        staged.monthly.sourceRevision,
        revisionCheckEnforced,
      );
    }

    const result: UpdateResult = {
      operation: { ...command.operation },
      kind: "PREPARED",
      artifactRef,
      newSourceRevision: staged.monthly.sourceRevision,
      revisionCheckEnforced,
      mappings: command.additions.map((addition) => ({
        commitmentId: addition.commitmentId,
        shiftAssignmentId: addition.shiftAssignmentId,
      })),
    };
    return result;
  }

  async applyUpdate(command: ApplyUpdateCommand): Promise<UpdateResult> {
    validateOperationHash(command);

    if (this.capabilities.supportsIdempotencyKey) {
      const begun = await this.operations.begin({
        connectionId: command.connectionId,
        operation: command.operation,
      });
      if (begun.kind === "REPLAY") return cloneUpdateResult(begun.result);
      if (begun.kind === "CONFLICT") {
        return conflictResult(command, "同じoperationIdに異なるrequestHashを指定しました。", false);
      }
      if (begun.kind === "IN_PROGRESS") {
        return unknownResult(command, "同じCSV操作が処理中で、結果を確認できません。");
      }
    }

    const result = await this.prepareUpdate(command);
    if (this.capabilities.supportsIdempotencyKey) {
      await this.operations.complete({
        connectionId: command.connectionId,
        operation: command.operation,
        result,
      });
    }
    return cloneUpdateResult(result);
  }

  async getUpdateResult(ref: {
    readonly operationId: string;
    readonly connectionId: string;
    readonly expectedRequestHash?: RequestHash;
  }): Promise<UpdateResult | "LOOKUP_UNAVAILABLE" | "CONFLICT"> {
    if (!this.capabilities.supportsResultLookup) return "LOOKUP_UNAVAILABLE";
    const result = await this.operations.lookup(ref);
    if (result === "NOT_FOUND" || result === "IN_PROGRESS" || result === "UNAVAILABLE") {
      return "LOOKUP_UNAVAILABLE";
    }
    if (result === "CONFLICT") return "CONFLICT";
    return cloneUpdateResult(result);
  }

  async readBack(ref: {
    readonly connectionId: ConnectionId;
    readonly artifactRef: string;
  }): Promise<ReadBackResult> {
    const monthly = await this.readArtifact(ref.connectionId, ref.artifactRef);
    if (monthly.completeness !== "COMPLETE" || monthly.missingDates.length > 0) {
      throw new TaskcalError("RECONCILE_REQUIRED", "CSV成果物の完全性を確認できません。");
    }
    return {
      artifactRef: ref.artifactRef,
      sourceRevision: monthly.sourceRevision,
      assignments: monthly.assignments.map((assignment) => cloneAssignment(assignment)),
    };
  }
}
