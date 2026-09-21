/**
 * `ScheduleGateway` の差し替え可能な偽物。**テスト専用。`src/` へ入れない。**
 *
 * 本物（担当BのCSV adapter）はまだ無い。合成の根（`src/application/deps.ts`）には
 * `UnimplementedScheduleGateway` が入っていて、模擬結果を返さず `NOT_IMPLEMENTED` を
 * 投げる。ここで作るのは、正式採用の手順（A02〜A08）を確かめるための台。
 *
 * 成否不明・反映なし・期待版不一致・読戻し不一致を**それぞれ別に**注入できるように
 * する。1つのbooleanにまとめると、区別して扱えているかを確かめられない。
 */

import type {
  ApplyUpdateCommand,
  LoadedAssignment,
  LoadedSchedule,
  ReadBackResult,
  ScheduleGateway,
  SourceCapabilities,
  UpdateResult,
} from "@/contracts/schedule-gateway";
import type { UpdateResultKind } from "@/contracts/schedule-update";

export interface FakeScheduleGatewayOptions {
  readonly sourceRevision: string;
  readonly completeness?: LoadedSchedule["completeness"];
  readonly missingDates?: readonly string[];
  readonly capabilities?: Partial<SourceCapabilities>;
  /** `applyUpdate` の結果。既定は正常（作業用成果物ができた）。 */
  readonly applyKind?: UpdateResultKind;
  /** `applyUpdate` で例外を投げる。成否不明の経路（A03）。 */
  readonly applyThrows?: Error;
  /** `getUpdateResult` の結果。結果不明からの再開に使う。 */
  readonly lookup?: UpdateResult | "LOOKUP_UNAVAILABLE" | "CONFLICT";
  /** 読戻しを意図的にずらす（A07）。既定は要求どおりに返す。 */
  readonly readBackOverride?: (
    expected: readonly LoadedAssignment[],
  ) => readonly LoadedAssignment[];
  readonly readBackThrows?: Error;
}

export interface FakeScheduleGateway extends ScheduleGateway {
  /** 実際に呼ばれた回数。**再実行していないこと**を確かめるために数える（A03）。 */
  readonly calls: { applyUpdate: number; getUpdateResult: number; readBack: number };
  readonly lastCommand: () => ApplyUpdateCommand | undefined;
}

const DEFAULT_CAPABILITIES: SourceCapabilities = {
  canReadRevision: true,
  canConditionalUpdate: true,
  supportsIdempotencyKey: true,
  supportsResultLookup: true,
  supportsAtomicBatch: true,
};

export function createFakeScheduleGateway(
  options: FakeScheduleGatewayOptions,
): FakeScheduleGateway {
  const calls = { applyUpdate: 0, getUpdateResult: 0, readBack: 0 };
  let lastCommand: ApplyUpdateCommand | undefined;
  const capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const newRevision = `${options.sourceRevision}+1`;
  const artifactRef = "var/test/worksheet.csv";

  /** 要求どおりに反映された結果の勤務。読戻しの期待値でもある。 */
  function expectedAssignments(command: ApplyUpdateCommand): readonly LoadedAssignment[] {
    return [
      ...command.additions.map((addition) => ({
        shiftAssignmentId: addition.shiftAssignmentId,
        staffId: addition.staffId,
        roleCode: addition.roleCode,
        startAt: addition.startAt,
        endAt: addition.endAt,
        status: "SCHEDULED" as const,
        sourceCaseId: addition.sourceCaseId,
      })),
      ...command.absences.map((absence) => ({
        shiftAssignmentId: absence.shiftAssignmentId,
        staffId: "absent",
        roleCode: "FLOOR",
        startAt: absence.startAt,
        endAt: absence.endAt,
        // 欠勤は往復する。取消（CANCELLED）にしない。
        status: "ABSENT" as const,
      })),
    ];
  }

  return {
    calls,
    lastCommand: () => lastCommand,
    capabilities,

    loadSchedule(): Promise<LoadedSchedule> {
      return Promise.resolve({
        scheduleId: "fake",
        sourceRevision: options.sourceRevision,
        requestedRange: { fromDate: "2026-09-01", toDate: "2026-10-01" },
        completeness: options.completeness ?? "COMPLETE",
        missingDates: options.missingDates ?? [],
        assignments: [],
      });
    },

    applyUpdate(command): Promise<UpdateResult> {
      calls.applyUpdate += 1;
      lastCommand = command;
      if (options.applyThrows) return Promise.reject(options.applyThrows);
      const kind = options.applyKind ?? "PREPARED";
      return Promise.resolve({
        operation: command.operation,
        kind,
        artifactRef: kind === "PREPARED" || kind === "APPLIED" ? artifactRef : undefined,
        newSourceRevision: kind === "PREPARED" || kind === "APPLIED" ? newRevision : undefined,
        revisionCheckEnforced: capabilities.canConditionalUpdate,
        mappings: command.additions.map((addition) => ({
          commitmentId: addition.commitmentId,
          shiftAssignmentId: addition.shiftAssignmentId,
        })),
      });
    },

    getUpdateResult() {
      calls.getUpdateResult += 1;
      return Promise.resolve(options.lookup ?? "LOOKUP_UNAVAILABLE");
    },

    readBack(): Promise<ReadBackResult> {
      calls.readBack += 1;
      if (options.readBackThrows) return Promise.reject(options.readBackThrows);
      if (!lastCommand) return Promise.reject(new Error("applyUpdate を先に呼んでください。"));
      const expected = expectedAssignments(lastCommand);
      return Promise.resolve({
        artifactRef,
        sourceRevision: newRevision,
        assignments: options.readBackOverride ? options.readBackOverride(expected) : expected,
      });
    },
  };
}
