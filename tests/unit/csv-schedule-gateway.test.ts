/**
 * CSV版 `ScheduleGateway`（RFC-010 §4・§6・§7、A02・A06・A07・A14）。
 *
 * 一時ディレクトリの管理版ストアで本物の adapter を動かす。DBは使わない。
 * 見るのは、成果物が正式採用を意味しないこと、同じ操作の再生、内容不一致の拒否、
 * 期待版から派生すること、読戻しが往復すること、出力のみモードの区別。
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { matchesExpected, plannedAbsences } from "@/application/adoption-check";
import { createCsvScheduleGateway } from "@/adapters/csv/csv-schedule-gateway";
import { artifactRefOf, readOperationRecord } from "@/adapters/csv/csv-store";
import { computeRequestHash } from "@/contracts/operation";
import type {
  ApplyUpdateCommand,
  ApplyUpdatePayloadForHash,
  PlannedAssignment,
} from "@/contracts/schedule-gateway";
import { createCsvFixture, type CsvFixture } from "../stubs/csv-fixture";

const CONNECTION = "mock:gateway-test";
const STORE = randomUUID();
const ABSENT = randomUUID();
const CANDIDATE = randomUUID();
const OTHER = randomUUID();
const ABSENT_SHIFT = randomUUID();
const CASE = randomUUID();
const START = "2026-09-26T18:00:00+09:00";
const END = "2026-09-26T22:00:00+09:00";

const fixtures: CsvFixture[] = [];

async function fixture(): Promise<CsvFixture> {
  const created = await createCsvFixture({
    connectionId: CONNECTION,
    storeId: STORE,
    month: "2026-09",
    roleCode: "FLOOR",
    staffIds: [ABSENT, CANDIDATE, OTHER],
    shifts: [
      { shiftAssignmentId: ABSENT_SHIFT, staffId: ABSENT, startAt: START, endAt: END },
      {
        shiftAssignmentId: randomUUID(),
        staffId: OTHER,
        startAt: "2026-09-27T18:00:00+09:00",
        endAt: "2026-09-27T22:00:00+09:00",
      },
    ],
  });
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

function authoritative(f: CsvFixture) {
  return {
    scheduleId: f.scheduleIdOf("2026-09-26"),
    sourceRevision: f.sourceRevision,
    artifactRef: f.artifactRef,
    adoptedAt: "2026-09-26T00:00:00.000Z",
  };
}

/** 永続層の形（UTC ISO）で命令を作る。adapter が +09:00 固定形式へ写す。 */
function command(
  f: CsvFixture,
  overrides: Partial<{
    additions: PlannedAssignment[];
    expectedSourceRevision: string;
    operationId: string;
  }> = {},
): ApplyUpdateCommand {
  const additions = overrides.additions ?? [
    {
      shiftAssignmentId: "10000000-0000-4000-8000-000000000001",
      commitmentId: "20000000-0000-4000-8000-000000000001",
      staffId: CANDIDATE,
      roleCode: "FLOOR",
      startAt: "2026-09-26T09:00:00.000Z",
      endAt: "2026-09-26T13:00:00.000Z",
      sourceCaseId: CASE,
    },
  ];
  const absences = [
    {
      shiftAssignmentId: ABSENT_SHIFT,
      startAt: "2026-09-26T09:00:00.000Z",
      endAt: "2026-09-26T13:00:00.000Z",
    },
  ];
  const payload: ApplyUpdatePayloadForHash = {
    connectionId: CONNECTION,
    scheduleId: f.scheduleIdOf("2026-09-26"),
    expectedSourceRevision: overrides.expectedSourceRevision ?? f.sourceRevision,
    additions,
    absences,
  };
  return {
    operation: {
      operationId: overrides.operationId ?? `apply:${randomUUID()}`,
      requestHash: computeRequestHash(payload),
    },
    ...payload,
  };
}

describe("CSV管理版ストア上の ScheduleGateway", () => {
  it("loadSchedule：正式版参照が指す版を対象月の範囲で返す。参照が無ければ外部作用の前に断る", async () => {
    const f = await fixture();
    const loaded = await f.gateway.loadSchedule({
      connectionId: CONNECTION,
      scheduleId: f.scheduleIdOf("2026-09-26"),
      authoritative: authoritative(f),
    });
    expect(loaded).toMatchObject({
      sourceRevision: f.sourceRevision,
      requestedRange: { fromDate: "2026-09-01", toDate: "2026-10-01" },
      completeness: "COMPLETE",
      missingDates: [],
    });
    expect(loaded.assignments).toHaveLength(2);

    await expect(
      f.gateway.loadSchedule({
        connectionId: CONNECTION,
        scheduleId: f.scheduleIdOf("2026-09-26"),
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    // 参照はあるのに版がストアに無い。旧版へ黙って戻らない。
    await expect(
      f.gateway.loadSchedule({
        connectionId: CONNECTION,
        scheduleId: f.scheduleIdOf("2026-09-26"),
        authoritative: {
          ...authoritative(f),
          sourceRevision: "f".repeat(64),
          artifactRef: artifactRefOf("f".repeat(64)),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("applyUpdate：PREPARED は検査済みの作業用CSVができたこと。欠勤は ABSENT で、追加は由来つきで往復する", async () => {
    const f = await fixture();
    const cmd = command(f);
    const result = await f.gateway.applyUpdate(cmd);
    expect(result.kind).toBe("PREPARED");
    expect(result.revisionCheckEnforced).toBe(true);
    expect(result.newSourceRevision).not.toBe(f.sourceRevision);
    expect(result.artifactRef).toBe(artifactRefOf(result.newSourceRevision!));
    expect(result.mappings).toEqual([
      {
        commitmentId: cmd.additions[0].commitmentId,
        shiftAssignmentId: cmd.additions[0].shiftAssignmentId,
      },
    ]);

    const back = await f.gateway.readBack({
      connectionId: CONNECTION,
      artifactRef: result.artifactRef!,
    });
    expect(back.sourceRevision).toBe(result.newSourceRevision);
    expect(matchesExpected(back.assignments, cmd.additions, cmd.absences, CASE)).toBe(true);
    const added = back.assignments.find(
      (a) => a.shiftAssignmentId === cmd.additions[0].shiftAssignmentId,
    );
    expect(added).toMatchObject({
      staffId: CANDIDATE,
      status: "SCHEDULED",
      sourceCaseId: CASE,
      startAt: "2026-09-26T18:00:00+09:00",
      endAt: "2026-09-26T22:00:00+09:00",
    });
    // 他の日の勤務は変わらない。
    expect(back.assignments).toHaveLength(3);

    // A02：作業用成果物ができても、旧版の正式版参照から読めば含まれない。
    const stillOld = await f.gateway.loadSchedule({
      connectionId: CONNECTION,
      scheduleId: f.scheduleIdOf("2026-09-26"),
      authoritative: authoritative(f),
    });
    expect(stillOld.assignments.map((a) => a.shiftAssignmentId)).not.toContain(
      cmd.additions[0].shiftAssignmentId,
    );
  });

  it("A07：元CSV（旧版）を読み戻しても、期待する内容とは一致しない", async () => {
    const f = await fixture();
    const cmd = command(f);
    await f.gateway.applyUpdate(cmd);
    const wrong = await f.gateway.readBack({
      connectionId: CONNECTION,
      artifactRef: f.artifactRef,
    });
    expect(matchesExpected(wrong.assignments, cmd.additions, cmd.absences, CASE)).toBe(false);
  });

  it("ADR-006／D07：同じ操作IDは同じ結果を再生し、内容が違えば CONFLICT で拒否する", async () => {
    const f = await fixture();
    const cmd = command(f);
    const first = await f.gateway.applyUpdate(cmd);
    const again = await f.gateway.applyUpdate(cmd);
    expect(again).toEqual(first);

    const tampered = command(f, {
      operationId: cmd.operation.operationId,
      additions: [{ ...cmd.additions[0], endAt: "2026-09-26T12:00:00.000Z" }],
    });
    const conflict = await f.gateway.applyUpdate(tampered);
    expect(conflict.kind).toBe("CONFLICT");

    // 照会も同じ規則。期待ハッシュが違えば結び付けない。
    expect(
      await f.gateway.getUpdateResult({
        operationId: cmd.operation.operationId,
        connectionId: CONNECTION,
        expectedRequestHash: cmd.operation.requestHash,
      }),
    ).toEqual(first);
    expect(
      await f.gateway.getUpdateResult({
        operationId: cmd.operation.operationId,
        connectionId: CONNECTION,
        expectedRequestHash: tampered.operation.requestHash,
      }),
    ).toBe("CONFLICT");
  });

  it("getUpdateResult：記録が無ければ未反映、接続を知らなければ照会不能", async () => {
    const f = await fixture();
    const missing = await f.gateway.getUpdateResult({
      operationId: `apply:${randomUUID()}`,
      connectionId: CONNECTION,
    });
    expect(missing).toMatchObject({ kind: "NOT_APPLIED", revisionCheckEnforced: false });
    expect(
      await f.gateway.getUpdateResult({ operationId: "apply:x", connectionId: "mock:unknown" }),
    ).toBe("LOOKUP_UNAVAILABLE");
  });

  it("期待版がストアに無ければ、別の版へ重ねずに CONFLICT を返して記録する", async () => {
    const f = await fixture();
    const cmd = command(f, { expectedSourceRevision: "e".repeat(64) });
    const result = await f.gateway.applyUpdate(cmd);
    expect(result).toMatchObject({ kind: "CONFLICT", revisionCheckEnforced: true });
    expect(await readOperationRecord(f.root, CONNECTION, cmd.operation.operationId)).toMatchObject({
      result: { kind: "CONFLICT" },
    });
    // 旧seedの目印のような、管理版IDの形でない値も同じ。
    expect(
      (await f.gateway.applyUpdate(command(f, { expectedSourceRevision: "seed:2026-09:1" }))).kind,
    ).toBe("CONFLICT");
  });

  it("検査で弾いた更新は NOT_APPLIED（外部作用の前）。欠勤対象が予定済みでない・追加が4時間超・宣言に無い日", async () => {
    const f = await fixture();
    // 一度欠勤にした版から、もう一度同じ勤務を欠勤にしようとする。
    const first = await f.gateway.applyUpdate(command(f));
    const twice = await f.gateway.applyUpdate(
      command(f, {
        expectedSourceRevision: first.newSourceRevision!,
        additions: [
          {
            shiftAssignmentId: randomUUID(),
            commitmentId: randomUUID(),
            staffId: OTHER,
            roleCode: "FLOOR",
            startAt: "2026-09-26T09:00:00.000Z",
            endAt: "2026-09-26T13:00:00.000Z",
            sourceCaseId: CASE,
          },
        ],
      }),
    );
    expect(twice).toMatchObject({ kind: "NOT_APPLIED", revisionCheckEnforced: true });

    const tooLong = await f.gateway.applyUpdate(
      command(f, {
        additions: [
          {
            shiftAssignmentId: randomUUID(),
            commitmentId: randomUUID(),
            staffId: CANDIDATE,
            roleCode: "FLOOR",
            startAt: "2026-09-26T08:00:00.000Z",
            endAt: "2026-09-26T13:00:00.000Z",
            sourceCaseId: CASE,
          },
        ],
      }),
    );
    expect(tooLong.kind).toBe("NOT_APPLIED");

    const otherMonth = await f.gateway.applyUpdate(
      command(f, {
        additions: [
          {
            shiftAssignmentId: randomUUID(),
            commitmentId: randomUUID(),
            staffId: CANDIDATE,
            roleCode: "FLOOR",
            startAt: "2026-10-01T09:00:00.000Z",
            endAt: "2026-10-01T13:00:00.000Z",
            sourceCaseId: CASE,
          },
        ],
      }),
    );
    expect(otherMonth.kind).toBe("NOT_APPLIED");
  });

  it("A14：出力のみモードでは成果物を作るが EXPORTED_ONLY を返す（正式採用させない）", async () => {
    const f = await fixture();
    const exportOnly = createCsvScheduleGateway({ root: f.root, mode: "EXPORT_ONLY" });
    const cmd = command(f);
    const result = await exportOnly.applyUpdate(cmd);
    expect(result.kind).toBe("EXPORTED_ONLY");
    expect(result.artifactRef).toBeDefined();
    const back = await exportOnly.readBack({
      connectionId: CONNECTION,
      artifactRef: result.artifactRef!,
    });
    expect(matchesExpected(back.assignments, cmd.additions, cmd.absences, CASE)).toBe(true);
  });

  it("readBack：成果物参照からパスを辿らない。形が違えば断る", async () => {
    const f = await fixture();
    await expect(
      f.gateway.readBack({ connectionId: CONNECTION, artifactRef: "../../etc/passwd" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      f.gateway.readBack({ connectionId: CONNECTION, artifactRef: artifactRefOf("0".repeat(64)) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("A06の前提：欠勤の区間は元勤務の全時間と一致する必要がある（Q04）", async () => {
    const f = await fixture();
    const cmd = command(f);
    const partial: ApplyUpdateCommand = {
      ...cmd,
      absences: [{ ...cmd.absences[0], endAt: "2026-09-26T11:00:00.000Z" }],
    };
    const result = await f.gateway.applyUpdate(partial);
    expect(result.kind).toBe("NOT_APPLIED");
    expect(plannedAbsences).toBeDefined();
  });
});
