/** 固定形式の開発用CSV。正式採用・ScheduleGatewayはこの段階では実装しない。 */
import { z } from "zod";
import { TaskcalError } from "../../contracts/errors";
import { computeRequestHash } from "../../contracts/operation";
import { ASSIGNMENT_STATUSES, type LoadedAssignment } from "../../contracts/schedule-gateway";
import { MAX_STAFF, MAX_ADDITIONAL_SHIFT_MINUTES } from "../../config/mvp-policy";

export const CSV_COLUMNS = [
  "scheduleId",
  "businessDate",
  "shiftAssignmentId",
  "staffId",
  "roleCode",
  "startAt",
  "endAt",
  "status",
  "sourceCaseId",
] as const;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const datePattern = /^[1-9]\d{3}-\d{2}-\d{2}$/;
const date = z.string().regex(datePattern);
const role = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/);
const timestamp = z
  .string()
  .regex(/^[1-9]\d{3}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45):00\+09:00$/);

const manifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  storeId: uuid,
  timezone: z.literal("Asia/Tokyo"),
  month: z.string().regex(/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/),
  roleCode: role,
  staffIds: z.array(uuid).min(1).max(MAX_STAFF),
  // 未指定はUNKNOWN。[]は全日未取得。空勤務日はassignmentIds: []で明示する。
  days: z
    .array(
      z.strictObject({
        date,
        scheduleId: uuid,
        assignmentIds: z.array(uuid),
      }),
    )
    .max(31)
    .optional(),
});

const rowSchema = z.strictObject({
  scheduleId: uuid,
  businessDate: date,
  shiftAssignmentId: uuid,
  staffId: uuid,
  roleCode: role,
  startAt: timestamp,
  endAt: timestamp,
  status: z.enum(ASSIGNMENT_STATUSES),
  sourceCaseId: z.union([z.literal(""), uuid]),
});

export type CsvManifest = z.infer<typeof manifestSchema>;
export interface CsvAssignment extends LoadedAssignment {
  readonly scheduleId: string;
  readonly businessDate: string;
}

export interface MonthlyCsv {
  readonly manifest: CsvManifest;
  readonly assignments: readonly CsvAssignment[];
  /** 店舗・月・完全性の宣言と勤務内容を含む。行順、改行、BOMには依存しない。 */
  readonly sourceRevision: string;
  readonly completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  readonly missingDates: readonly string[];
  readonly normalizedCsv: string;
}

function invalid(message: string): never {
  throw new TaskcalError("INVALID_INPUT", message);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label}が重複しています。`);
}

function monthDates(month: string): string[] {
  const [year, number] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from(
    { length: count },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
  );
}

/**
 * CSVと、信頼する開発fixtureの範囲宣言を照合する純粋関数。
 * manifestは外部利用者の自己申告を認証するものではない。
 * ID欠落時の自動採番はしない。CSVの行番号や内容からIDを生成しない。
 */
export function parseMonthlyCsv(csv: string, manifestInput: unknown): MonthlyCsv {
  const parsedManifest = manifestSchema.safeParse(manifestInput);
  if (!parsedManifest.success) invalid("CSV範囲宣言の形式が不正です。");
  const manifest = parsedManifest.data;
  unique(manifest.staffIds, "スタッフID");
  manifest.staffIds.sort();
  const dates = monthDates(manifest.month);
  const dateSet = new Set(dates);
  const scheduleDates = new Map<string, string>();
  const dateSchedules = new Map<string, string>();
  const registerSchedule = (day: string, id: string) => {
    if (!dateSet.has(day)) invalid("対象月外または実在しない営業日です。");
    if (
      (scheduleDates.has(id) && scheduleDates.get(id) !== day) ||
      (dateSchedules.has(day) && dateSchedules.get(day) !== id)
    ) {
      invalid("勤務表IDと営業日は一対一で対応する必要があります。");
    }
    scheduleDates.set(id, day);
    dateSchedules.set(day, id);
  };
  if (manifest.days) {
    unique(
      manifest.days.map((day) => day.date),
      "取得済み営業日",
    );
    unique(
      manifest.days.flatMap((day) => day.assignmentIds),
      "宣言された勤務ID",
    );
    manifest.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const day of manifest.days) {
      registerSchedule(day.date, day.scheduleId);
      day.assignmentIds.sort();
    }
  }

  if (Buffer.byteLength(csv, "utf8") > 1_048_576) {
    throw new TaskcalError("OUT_OF_SCOPE", "CSVは1MiB以内にしてください。");
  }
  const text = csv.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  // 固定形式では引用符・自由文を扱わない。丸めたり壊れた行を読み飛ばしたりしない。
  if (
    text.includes('"') ||
    [...text].some(
      (char) => char !== "\n" && (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    )
  ) {
    throw new TaskcalError("OUT_OF_SCOPE", "CSVの引用符・制御文字は対応範囲外です。");
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.shift() !== CSV_COLUMNS.join(",")) invalid("CSVの列名または列順が不正です。");
  const assignments: CsvAssignment[] = lines.map((line, index) => {
    const cells = line.split(",");
    if (cells.length !== CSV_COLUMNS.length) invalid(`CSVの${index + 2}行目の列数が不正です。`);
    if (!z.enum(ASSIGNMENT_STATUSES).safeParse(cells[CSV_COLUMNS.indexOf("status")]).success) {
      throw new TaskcalError("OUT_OF_SCOPE", "対応していない勤務状態です。");
    }
    const parsed = rowSchema.safeParse(
      Object.fromEntries(CSV_COLUMNS.map((key, i) => [key, cells[i]])),
    );
    if (!parsed.success) invalid(`CSVの${index + 2}行目のID・時刻・状態などの形式が不正です。`);
    const row = parsed.data;
    registerSchedule(row.businessDate, row.scheduleId);
    if (!manifest.staffIds.includes(row.staffId) || row.roleCode !== manifest.roleCode) {
      invalid(`CSVの${index + 2}行目が宣言されたスタッフ・職種と一致しません。`);
    }
    if (
      row.startAt.slice(0, 10) !== row.businessDate ||
      row.endAt.slice(0, 10) !== row.businessDate
    ) {
      throw new TaskcalError("OUT_OF_SCOPE", "営業日と異なる日付・日跨ぎ勤務は対応範囲外です。");
    }
    const minutes = (Date.parse(row.endAt) - Date.parse(row.startAt)) / 60_000;
    if (!(minutes > 0)) invalid("勤務の開始時刻は終了時刻より前である必要があります。");
    if (row.sourceCaseId && minutes > MAX_ADDITIONAL_SHIFT_MINUTES) {
      throw new TaskcalError("OUT_OF_SCOPE", "代替勤務が最長追加勤務時間を超えています。");
    }
    return { ...row, sourceCaseId: row.sourceCaseId || undefined };
  });
  unique(
    assignments.map((row) => row.shiftAssignmentId),
    "勤務ID",
  );
  assignments.sort((a, b) =>
    a.shiftAssignmentId < b.shiftAssignmentId
      ? -1
      : a.shiftAssignmentId > b.shiftAssignmentId
        ? 1
        : 0,
  );

  // 行を落としたCSVを完全と誤認しないよう、取得済み日の勤務ID集合も照合する。
  for (const day of manifest.days ?? []) {
    const actual = assignments
      .filter((row) => row.businessDate === day.date)
      .map((row) => row.shiftAssignmentId);
    if (JSON.stringify(actual) !== JSON.stringify(day.assignmentIds)) {
      invalid("取得済み営業日の勤務ID集合がCSVと一致しません。");
    }
  }
  const knownDates = new Set(manifest.days?.map((day) => day.date));
  const missingDates = dates.filter((day) => !knownDates.has(day));
  const completeness =
    manifest.days === undefined ? "UNKNOWN" : missingDates.length ? "INCOMPLETE" : "COMPLETE";
  const normalizedCsv =
    [
      CSV_COLUMNS.join(","),
      ...assignments.map((row) => CSV_COLUMNS.map((key) => row[key] ?? "").join(",")),
    ].join("\n") + "\n";
  return {
    manifest,
    assignments,
    sourceRevision: computeRequestHash({ manifest, normalizedCsv }),
    completeness,
    missingDates,
    normalizedCsv,
  };
}
