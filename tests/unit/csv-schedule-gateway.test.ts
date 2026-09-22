import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CsvScheduleGateway,
  FileCsvArtifactStore,
  FileCsvScheduleSource,
  type CsvArtifactStore,
} from "@/adapters/csv/schedule-gateway";
import { computeRequestHash } from "@/contracts/operation";
import type { ApplyUpdateCommand, AuthoritativeScheduleRef, LoadedSchedule } from "@/contracts";
import type { CsvManifest } from "@/adapters/csv/monthly-csv";

const fixtureDirectory = path.resolve("fixtures/dev/month-2026-09");
const connectionId = "csv-local";
const scheduleId = "00000002-0000-4000-8000-000000000001";
const firstAssignmentId = "00000003-0000-4000-8000-000000000001";
const cancelledAssignmentId = "00000003-0000-4000-8000-000000000003";
const replacementId = "00000003-0000-4000-8000-000000000008";
const replacementCaseId = "00000005-0000-4000-8000-000000000002";

async function fixtureSource(): Promise<FileCsvScheduleSource> {
  return new FileCsvScheduleSource(
    path.join(fixtureDirectory, "schedule.csv"),
    path.join(fixtureDirectory, "manifest.json"),
  );
}

async function sourceText(): Promise<{ readonly csv: string; readonly manifest: CsvManifest }> {
  return {
    csv: await readFile(path.join(fixtureDirectory, "schedule.csv"), "utf8"),
    manifest: JSON.parse(
      await readFile(path.join(fixtureDirectory, "manifest.json"), "utf8"),
    ) as CsvManifest,
  };
}

async function temporaryOutput(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "taskcal-csv-gateway-"));
}

function command(
  operationId: string,
  loaded: LoadedSchedule,
  overrides: Partial<
    Pick<
      ApplyUpdateCommand,
      "connectionId" | "expectedSourceRevision" | "baseArtifactRef" | "additions" | "absences"
    >
  > = {},
): ApplyUpdateCommand {
  const payload = {
    connectionId,
    scheduleId: loaded.scheduleId,
    expectedSourceRevision: loaded.sourceRevision,
    additions: [
      {
        shiftAssignmentId: replacementId,
        commitmentId: "commitment-1",
        staffId: "00000004-0000-4000-8000-000000000003",
        roleCode: "FLOOR",
        startAt: "2026-09-01T18:00:00+09:00",
        endAt: "2026-09-01T22:00:00+09:00",
        sourceCaseId: replacementCaseId,
      },
    ],
    absences: [
      {
        shiftAssignmentId: firstAssignmentId,
        startAt: "2026-09-01T10:00:00+09:00",
        endAt: "2026-09-01T18:00:00+09:00",
      },
    ],
    ...overrides,
  } satisfies Omit<ApplyUpdateCommand, "operation">;
  return {
    ...payload,
    operation: {
      operationId,
      requestHash: computeRequestHash(payload),
    },
  };
}

async function loadInitial(gateway: CsvScheduleGateway): Promise<LoadedSchedule> {
  return gateway.loadSchedule({ connectionId, scheduleId });
}

async function withOutput<T>(callback: (outputDir: string) => Promise<T>): Promise<T> {
  const outputDir = await temporaryOutput();
  try {
    return await callback(outputDir);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

class CorruptingArtifactStore implements CsvArtifactStore {
  constructor(private readonly delegate: CsvArtifactStore) {}

  write(input: Parameters<CsvArtifactStore["write"]>[0]): ReturnType<CsvArtifactStore["write"]> {
    return this.delegate.write(input);
  }

  async read(
    input: Parameters<CsvArtifactStore["read"]>[0],
  ): Promise<Awaited<ReturnType<CsvArtifactStore["read"]>>> {
    const result = await this.delegate.read(input);
    if (typeof result === "string") return result;
    return {
      csv: result.csv.replace(",SCHEDULED,", ",CANCELLED,"),
      manifest: result.manifest,
    };
  }
}

describe("CsvScheduleGateway", () => {
  it("A01: 次案件は現行正式版成果物を更新元にする", async () => {
    await withOutput(async (outputDir) => {
      const gateway = new CsvScheduleGateway({ source: await fixtureSource(), outputDir });
      const first = await gateway.applyUpdate(command("first", await loadInitial(gateway)));
      expect(first.kind).toBe("PREPARED");
      const secondScheduleId = "00000002-0000-4000-8000-000000000025";
      const loaded = await gateway.loadSchedule({
        connectionId,
        scheduleId: secondScheduleId,
        authoritative: {
          scheduleId: secondScheduleId,
          sourceRevision: first.newSourceRevision!,
          artifactRef: first.artifactRef!,
          adoptedAt: "2026-09-01T00:00:00Z",
        },
      });
      const second = await gateway.applyUpdate(
        command("second", loaded, {
          baseArtifactRef: first.artifactRef,
          additions: [
            {
              shiftAssignmentId: "00000003-0000-4000-8000-000000000009",
              commitmentId: "commitment-2",
              staffId: "00000004-0000-4000-8000-000000000003",
              roleCode: "FLOOR",
              startAt: "2026-09-25T18:00:00+09:00",
              endAt: "2026-09-25T20:00:00+09:00",
              sourceCaseId: replacementCaseId,
            },
          ],
          absences: [
            {
              shiftAssignmentId: "00000003-0000-4000-8000-000000000007",
              startAt: "2026-09-25T18:00:00+09:00",
              endAt: "2026-09-25T20:00:00+09:00",
            },
          ],
        }),
      );
      expect(second.kind).toBe("PREPARED");
    });
  });
  it("A01/A02: 初回読込の範囲と作業成果物を分け、readBack後も正式採用を表さない", async () => {
    await withOutput(async (outputDir) => {
      const source = await fixtureSource();
      const gateway = new CsvScheduleGateway({ source, outputDir });
      const original = await readFile(path.join(fixtureDirectory, "schedule.csv"), "utf8");
      const loaded = await loadInitial(gateway);
      const result = await gateway.applyUpdate(command("op-prepared", loaded));

      expect(loaded.completeness).toBe("COMPLETE");
      expect(loaded.requestedRange).toEqual({ fromDate: "2026-09-01", toDate: "2026-10-01" });
      expect(result.kind).toBe("PREPARED");
      expect(result.kind).not.toBe("ADOPTED");
      expect(result.artifactRef).toBeDefined();
      expect(result.newSourceRevision).toBeDefined();
      expect(await readFile(path.join(fixtureDirectory, "schedule.csv"), "utf8")).toBe(original);

      const readBack = await gateway.readBack({
        connectionId,
        artifactRef: result.artifactRef!,
      });
      expect(readBack.sourceRevision).toBe(result.newSourceRevision);
      expect(readBack.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ shiftAssignmentId: firstAssignmentId, status: "ABSENT" }),
          expect.objectContaining({ shiftAssignmentId: replacementId, status: "SCHEDULED" }),
          expect.objectContaining({
            shiftAssignmentId: cancelledAssignmentId,
            status: "CANCELLED",
          }),
        ]),
      );
    });
  });

  it("A01: 成果物を正式版参照として明示したloadScheduleは原本へ戻らない", async () => {
    await withOutput(async (outputDir) => {
      const source = await fixtureSource();
      const firstGateway = new CsvScheduleGateway({ source, outputDir });
      const loaded = await loadInitial(firstGateway);
      const prepared = await firstGateway.applyUpdate(command("op-authoritative", loaded));
      const authoritative: AuthoritativeScheduleRef = {
        scheduleId,
        sourceRevision: prepared.newSourceRevision!,
        artifactRef: prepared.artifactRef!,
        adoptedAt: "2026-09-22T10:00:00+09:00",
      };

      const restarted = new CsvScheduleGateway({ source, outputDir });
      const fromAuthoritative = await restarted.loadSchedule({
        connectionId,
        scheduleId,
        authoritative,
      });
      expect(fromAuthoritative.sourceRevision).toBe(prepared.newSourceRevision);
      expect(fromAuthoritative.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ shiftAssignmentId: firstAssignmentId, status: "ABSENT" }),
          expect.objectContaining({ shiftAssignmentId: replacementId, status: "SCHEDULED" }),
        ]),
      );
    });
  });

  it("A06: 成果物の行順をstable assignment ID順にし、IDを保持する", async () => {
    await withOutput(async (outputDir) => {
      const input = await sourceText();
      const [header, ...rows] = input.csv.trimEnd().split("\n");
      const sourceDirectory = await mkdtemp(path.join(tmpdir(), "taskcal-csv-source-"));
      try {
        const csvPath = path.join(sourceDirectory, "schedule.csv");
        const manifestPath = path.join(sourceDirectory, "manifest.json");
        await writeFile(csvPath, [header, ...rows.reverse()].join("\n") + "\n");
        await writeFile(manifestPath, JSON.stringify(input.manifest));
        const gateway = new CsvScheduleGateway({
          source: new FileCsvScheduleSource(csvPath, manifestPath),
          outputDir,
        });
        const loaded = await gateway.loadSchedule({ connectionId, scheduleId });
        const result = await gateway.applyUpdate(command("op-stable-order", loaded));
        const readBack = await gateway.readBack({ connectionId, artifactRef: result.artifactRef! });
        expect(readBack.assignments.map((assignment) => assignment.shiftAssignmentId)).toEqual(
          [...readBack.assignments]
            .sort((a, b) => a.shiftAssignmentId.localeCompare(b.shiftAssignmentId))
            .map((assignment) => assignment.shiftAssignmentId),
        );
        expect(readBack.assignments.map((assignment) => assignment.shiftAssignmentId)).toContain(
          replacementId,
        );
      } finally {
        await rm(sourceDirectory, { recursive: true, force: true });
      }
    });
  });

  it("A07: readBack不一致をPREPAREDにも確定失敗にも丸めない", async () => {
    await withOutput(async (outputDir) => {
      const source = await fixtureSource();
      const artifacts = new CorruptingArtifactStore(
        new FileCsvArtifactStore(path.join(outputDir, "artifacts")),
      );
      const gateway = new CsvScheduleGateway({ source, outputDir, artifacts });
      const loaded = await loadInitial(gateway);
      const result = await gateway.applyUpdate(command("op-readback-mismatch", loaded));

      expect(result.kind).toBe("UNKNOWN");
      expect(result.kind).not.toBe("PREPARED");
      expect(result.kind).not.toBe("NOT_APPLIED");
      expect(result.artifactRef).toBeDefined();
      await expect(
        gateway.getUpdateResult({
          connectionId,
          operationId: "op-readback-mismatch",
          expectedRequestHash: result.operation.requestHash,
        }),
      ).resolves.toMatchObject({ kind: "UNKNOWN" });
    });
  });

  it("A08/A14: 結果と成果物を別々に保存し、再起動後も同じ操作結果を照会できる", async () => {
    await withOutput(async (outputDir) => {
      const source = await fixtureSource();
      const first = new CsvScheduleGateway({ source, outputDir });
      const loaded = await loadInitial(first);
      const request = command("op-replay", loaded);
      const prepared = await first.applyUpdate(request);
      const replay = await first.applyUpdate(request);
      expect(replay).toEqual(prepared);

      const restarted = new CsvScheduleGateway({ source, outputDir });
      await expect(restarted.applyUpdate(request)).resolves.toEqual(prepared);
      await expect(
        restarted.getUpdateResult({
          connectionId,
          operationId: request.operation.operationId,
          expectedRequestHash: request.operation.requestHash,
        }),
      ).resolves.toEqual(prepared);
      await expect(
        restarted.readBack({ connectionId, artifactRef: prepared.artifactRef! }),
      ).resolves.toMatchObject({ artifactRef: prepared.artifactRef });

      const changed = command("op-replay", loaded, {
        additions: [
          {
            ...request.additions[0],
            staffId: "00000004-0000-4000-8000-000000000004",
          },
        ],
      });
      await expect(restarted.applyUpdate(changed)).resolves.toMatchObject({ kind: "CONFLICT" });

      const otherConnection = command("op-replay", loaded, { connectionId: "csv-other" });
      const otherResult = await restarted.applyUpdate(otherConnection);
      expect(otherResult.kind).toBe("PREPARED");
      expect(otherResult.artifactRef).not.toBe(prepared.artifactRef);
    });
  });

  it("ABSENTとCANCELLEDを往復で区別する", async () => {
    await withOutput(async (outputDir) => {
      const source = await fixtureSource();
      const gateway = new CsvScheduleGateway({ source, outputDir });
      const loaded = await loadInitial(gateway);
      const result = await gateway.applyUpdate(command("op-status-roundtrip", loaded));
      const readBack = await gateway.readBack({ connectionId, artifactRef: result.artifactRef! });
      expect(
        readBack.assignments.find((row) => row.shiftAssignmentId === firstAssignmentId)?.status,
      ).toBe("ABSENT");
      expect(
        readBack.assignments.find((row) => row.shiftAssignmentId === cancelledAssignmentId)?.status,
      ).toBe("CANCELLED");
    });
  });

  it("A04/A14: 版競合、条件付き更新なし、照会不能、一括保証なしをcapabilityで明示する", async () => {
    await withOutput(async (outputDir) => {
      const source = await fixtureSource();
      const normal = new CsvScheduleGateway({ source, outputDir });
      const loaded = await loadInitial(normal);
      await expect(
        normal.applyUpdate(
          command("op-revision-conflict", loaded, { expectedSourceRevision: "old-revision" }),
        ),
      ).resolves.toMatchObject({ kind: "CONFLICT", revisionCheckEnforced: true });

      const fallback = new CsvScheduleGateway({
        source,
        outputDir: path.join(outputDir, "fallback"),
        capabilities: {
          canConditionalUpdate: false,
          supportsIdempotencyKey: false,
          supportsResultLookup: false,
          supportsAtomicBatch: false,
        },
        artifactRefFactory: (() => {
          let sequence = 0;
          return () => `csv://fallback/${++sequence}`;
        })(),
      });
      const fallbackLoaded = await loadInitial(fallback);
      const one = await fallback.applyUpdate(
        command("op-fallback-one", fallbackLoaded, {
          expectedSourceRevision: "not-read",
          absences: [],
        }),
      );
      expect(one.kind).toBe("PREPARED");
      expect(one.revisionCheckEnforced).toBe(false);
      expect(
        await fallback.getUpdateResult({
          connectionId,
          operationId: "op-fallback-one",
          expectedRequestHash: one.operation.requestHash,
        }),
      ).toBe("LOOKUP_UNAVAILABLE");
      const repeated = await fallback.applyUpdate(
        command("op-fallback-one", fallbackLoaded, {
          expectedSourceRevision: "not-read",
          absences: [],
        }),
      );
      expect(repeated.kind).toBe("PREPARED");
      expect(repeated.artifactRef).not.toBe(one.artifactRef);

      const two = await fallback.applyUpdate(command("op-fallback-two", fallbackLoaded));
      expect(two.kind).toBe("NOT_APPLIED");
      expect(two.artifactRef).toBeUndefined();
    });
  });

  it("A14: 明示的artifactRefでも内容由来のsourceRevisionを混同しない", async () => {
    await withOutput(async (outputDir) => {
      const source = await fixtureSource();
      let sequence = 0;
      const gateway = new CsvScheduleGateway({
        source,
        outputDir,
        artifactRefFactory: () => `csv://explicit/${++sequence}`,
      });
      const loaded = await loadInitial(gateway);
      const first = await gateway.applyUpdate(command("op-explicit-a", loaded));
      const second = await gateway.applyUpdate(
        command("op-explicit-b", loaded, {
          additions: [
            {
              shiftAssignmentId: "00000003-0000-4000-8000-000000000009",
              commitmentId: "commitment-2",
              staffId: "00000004-0000-4000-8000-000000000001",
              roleCode: "FLOOR",
              startAt: "2026-09-01T10:00:00+09:00",
              endAt: "2026-09-01T14:00:00+09:00",
              sourceCaseId: replacementCaseId,
            },
          ],
        }),
      );
      expect(first.artifactRef).not.toBe(second.artifactRef);
      expect(first.newSourceRevision).not.toBe(second.newSourceRevision);
    });
  });

  it("完全性不明の原本を成功や確定失敗へ丸めない", async () => {
    await withOutput(async (outputDir) => {
      const input = await sourceText();
      const sourceDirectory = await mkdtemp(path.join(tmpdir(), "taskcal-csv-incomplete-"));
      try {
        const csvPath = path.join(sourceDirectory, "schedule.csv");
        const manifestPath = path.join(sourceDirectory, "manifest.json");
        const incomplete = { ...input.manifest };
        delete incomplete.days;
        await writeFile(csvPath, input.csv);
        await writeFile(manifestPath, JSON.stringify(incomplete));
        const gateway = new CsvScheduleGateway({
          source: new FileCsvScheduleSource(csvPath, manifestPath),
          outputDir,
        });
        const loaded = await gateway.loadSchedule({ connectionId, scheduleId });
        const result = await gateway.applyUpdate(command("op-incomplete", loaded));
        expect(loaded.completeness).toBe("UNKNOWN");
        expect(result.kind).toBe("UNKNOWN");
        expect(result.artifactRef).toBeUndefined();
      } finally {
        await rm(sourceDirectory, { recursive: true, force: true });
      }
    });
  });
});
