/**
 * テスト用のCSV管理版ストア。**テスト専用。**
 *
 * 一時ディレクトリに担当Bの `csv-store.ts` と同じ配置で管理版を作り、本物の
 * `createCsvScheduleGateway` をその上で動かす。台（fake）ではなく本物の adapter を
 * 通すための足場で、DBの正式版参照は作らない（それは各テストが自分で入れる）。
 *
 * 月内の勤務は `shifts` で与える。範囲宣言は対象月の全日を宣言し `COMPLETE` にする
 * （Q06／A09：完全でなければ月次上限の検査が成立しない）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCsvScheduleGateway } from "@/adapters/csv/csv-schedule-gateway";
import { artifactRefOf, importRevision, registerConnection } from "@/adapters/csv/csv-store";
import { CSV_COLUMNS, type CsvManifest, type MonthlyCsv } from "@/adapters/csv/monthly-csv";
import type { AssignmentStatus, ScheduleGateway } from "@/contracts/schedule-gateway";

export interface FixtureShift {
  readonly shiftAssignmentId: string;
  readonly staffId: string;
  /** `YYYY-MM-DDTHH:MM:00+09:00` */
  readonly startAt: string;
  readonly endAt: string;
  readonly status?: AssignmentStatus;
  readonly sourceCaseId?: string;
}

export interface CsvFixtureInput {
  readonly connectionId: string;
  readonly storeId: string;
  readonly month: string;
  readonly roleCode: string;
  readonly staffIds: readonly string[];
  readonly shifts: readonly FixtureShift[];
  /** 営業日 → 勤務表ID。省略した日は決定的に採番する。 */
  readonly scheduleIds?: Readonly<Record<string, string>>;
}

export interface CsvFixture {
  readonly root: string;
  readonly gateway: ScheduleGateway;
  readonly parsed: MonthlyCsv;
  readonly sourceRevision: string;
  readonly artifactRef: string;
  /** 営業日 → 勤務表ID。DBの `schedule` 行を同じIDで作る。 */
  readonly scheduleIdOf: (date: string) => string;
  readonly cleanup: () => Promise<void>;
}

function monthDates(month: string): string[] {
  const [year, number] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** 決定的な勤務表ID。テストが日付からDBの行を作れるように、日から決める。 */
function defaultScheduleId(storeId: string, date: string): string {
  const day = date.slice(8, 10);
  // storeId の先頭8桁を混ぜて、複数テストの店舗で衝突させない。
  return `${storeId.slice(0, 8)}-0000-4000-8000-0000000000${day}`;
}

/** 勤務一覧からCSVと範囲宣言を作る。`parseMonthlyCsv` の受理条件に合わせる。 */
export function buildCsvInput(input: CsvFixtureInput): { csv: string; manifest: CsvManifest } {
  const scheduleIdOf = (date: string) =>
    input.scheduleIds?.[date] ?? defaultScheduleId(input.storeId, date);
  const rows = input.shifts.map((shift) => ({
    scheduleId: scheduleIdOf(shift.startAt.slice(0, 10)),
    businessDate: shift.startAt.slice(0, 10),
    shiftAssignmentId: shift.shiftAssignmentId,
    staffId: shift.staffId,
    roleCode: input.roleCode,
    startAt: shift.startAt,
    endAt: shift.endAt,
    status: shift.status ?? "SCHEDULED",
    sourceCaseId: shift.sourceCaseId ?? "",
  }));
  const csv =
    [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((k) => row[k]).join(","))].join(
      "\n",
    ) + "\n";
  const manifest: CsvManifest = {
    formatVersion: 1,
    storeId: input.storeId,
    timezone: "Asia/Tokyo",
    month: input.month,
    roleCode: input.roleCode,
    staffIds: [...input.staffIds],
    days: monthDates(input.month).map((date) => ({
      date,
      scheduleId: scheduleIdOf(date),
      assignmentIds: rows
        .filter((row) => row.businessDate === date)
        .map((row) => row.shiftAssignmentId),
    })),
  };
  return { csv, manifest };
}

/** 一時ディレクトリに管理版ストアを作り、本物のGatewayを返す。 */
export async function createCsvFixture(input: CsvFixtureInput): Promise<CsvFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "taskcal-csv-store-"));
  await registerConnection(root, input.connectionId);
  const { parsed } = await importRevision(root, input.connectionId, buildCsvInput(input));
  return {
    root,
    gateway: createCsvScheduleGateway({ root }),
    parsed,
    sourceRevision: parsed.sourceRevision,
    artifactRef: artifactRefOf(parsed.sourceRevision),
    scheduleIdOf: (date) => input.scheduleIds?.[date] ?? defaultScheduleId(input.storeId, date),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
