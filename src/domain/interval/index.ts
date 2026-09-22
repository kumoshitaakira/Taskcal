import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import { ASSIGNMENT_STATUSES, type AssignmentStatus } from "@/contracts/schedule-gateway";
import { MAX_ADDITIONAL_SHIFT_MINUTES, TIME_GRANULARITY_MINUTES } from "@/config/mvp-policy";

/** MVPで扱う勤務表のタイムゾーン。CSVの固定形式と同じ値に限定する。 */
export const MVP_TIMEZONE = "Asia/Tokyo" as const;

export interface TimeRange {
  readonly startAt: string;
  readonly endAt: string;
}

export interface MonthlyWorkLimit {
  readonly targetMonth: string;
  readonly limitMinutes: number;
}

export interface StaffProfile {
  readonly staffId: string;
  readonly storeId: string;
  readonly status: "ACTIVE" | "INACTIVE";
  readonly roleCodes: readonly string[];
  /** 対象日の候補可能時間。複数区間を入力できるが、差し引き後の分断はMVP対象外。 */
  readonly availabilityWindows: readonly TimeRange[];
  readonly monthlyWorkLimits: readonly MonthlyWorkLimit[];
}

export interface MonthlyAssignment {
  readonly shiftAssignmentId: string;
  readonly businessDate: string;
  readonly staffId: string;
  readonly roleCode: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: AssignmentStatus;
}

/** 月次上限を検査するための、完全性を伴う読み取りスナップショット。 */
export interface MonthlyScheduleSnapshot {
  readonly storeId: string;
  readonly timezone: string;
  readonly month: string;
  /** 正式採用前の版再検査に使う、CSV adapter由来の内容版。 */
  readonly sourceRevision: string;
  /** 月次入力の完全性を検証した対象スタッフ集合。勤務0件のスタッフも含む。 */
  readonly staffIds: readonly string[];
  readonly completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  readonly assignments: readonly MonthlyAssignment[];
}

export interface MonthlyCapacity {
  readonly limitMinutes: number;
  readonly usedMinutes: number;
  readonly proposedMinutes: number;
  readonly remainingBeforeMinutes: number;
  readonly remainingAfterMinutes: number;
  readonly withinLimit: boolean;
}

export const CANDIDATE_INELIGIBILITY = {
  STAFF_INACTIVE: "STAFF_INACTIVE",
  WRONG_STORE: "WRONG_STORE",
  ROLE_NOT_ALLOWED: "ROLE_NOT_ALLOWED",
  ABSENT_STAFF: "ABSENT_STAFF",
  STAFF_NOT_IN_MONTHLY_SNAPSHOT: "STAFF_NOT_IN_MONTHLY_SNAPSHOT",
  EXISTING_ASSIGNMENT_OVERLAP: "EXISTING_ASSIGNMENT_OVERLAP",
  AVAILABILITY_NOT_COVERED: "AVAILABILITY_NOT_COVERED",
  OUT_OF_SCOPE: ERROR_CODES.OUT_OF_SCOPE,
  MONTHLY_CAP_NOT_CONFIGURED: "MONTHLY_CAP_NOT_CONFIGURED",
  MONTHLY_CAP_EXCEEDED: "MONTHLY_CAP_EXCEEDED",
} as const;

export type CandidateIneligibility =
  (typeof CANDIDATE_INELIGIBILITY)[keyof typeof CANDIDATE_INELIGIBILITY];

export interface CandidateEligibilityInput {
  readonly storeId: string;
  readonly roleCode: string;
  readonly businessDate: string;
  /** 承諾を自動短縮せず、そのまま検査する勤務区間。 */
  readonly proposedTime: TimeRange;
  readonly absentStaffId: string;
  readonly staff: StaffProfile;
  readonly monthlySchedule: MonthlyScheduleSnapshot;
}

export interface CandidateEligibilityResult {
  /** 承諾・正式採用ではなく、決定的な時間・勤務条件上の適格性だけを表す。 */
  readonly eligible: boolean;
  readonly staffId: string;
  readonly proposedTime: TimeRange;
  readonly availableIntervals: readonly TimeRange[];
  readonly reason?: CandidateIneligibility;
  readonly monthlyCapacity?: MonthlyCapacity;
}

interface ParsedRange extends TimeRange {
  readonly startMs: number;
  readonly endMs: number;
}

const JST_TIMESTAMP =
  /^([1-9]\d{3})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):00\+09:00$/;
const CALENDAR_DATE = /^([1-9]\d{3})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^([1-9]\d{3})-(0[1-9]|1[0-2])$/;
const ACTIVE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ["SCHEDULED", "COMPLETED"];

function invalid(message: string): never {
  throw new TaskcalError(ERROR_CODES.INVALID_INPUT, message);
}

function outOfScope(message: string): never {
  throw new TaskcalError(ERROR_CODES.OUT_OF_SCOPE, message);
}

function formatJstDate(ms: number): string {
  const value = new Date(ms + 9 * 60 * 60 * 1000);
  return [
    value.getUTCFullYear().toString().padStart(4, "0"),
    (value.getUTCMonth() + 1).toString().padStart(2, "0"),
    value.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function formatJstTimestamp(ms: number): string {
  const value = new Date(ms + 9 * 60 * 60 * 1000);
  return `${formatJstDate(ms)}T${value.getUTCHours().toString().padStart(2, "0")}:${value
    .getUTCMinutes()
    .toString()
    .padStart(2, "0")}:00+09:00`;
}

function parseCalendarDate(value: string): number {
  const match = CALENDAR_DATE.exec(value);
  if (!match) invalid("営業日の形式が不正です。");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  if (formatJstDate(ms) !== value) invalid("実在しない営業日です。");
  return ms;
}

function parseMonth(value: string): { readonly year: number; readonly month: number } {
  const match = MONTH.exec(value);
  if (!match) invalid("対象月の形式が不正です。");
  return { year: Number(match[1]), month: Number(match[2]) };
}

function parseJstTimestamp(value: string): number {
  const match = JST_TIMESTAMP.exec(value);
  if (!match) invalid("日時はAsia/Tokyoの固定形式で指定してください。");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const ms = Date.UTC(year, month - 1, day, hour - 9, minute);
  if (formatJstTimestamp(ms) !== value) invalid("実在しない日時です。");
  return ms;
}

/**
 * 明示のオフセットを持つ日時だけを受ける。
 *
 * `Date.parse` は `2026-09-26T18:00:00` や `2026-09-26` を**サーバのタイムゾーンで**
 * 解釈する。壁時計の時刻がサーバ次第で変わり、検査した区間と実際の勤務がずれる。
 */
const HAS_EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * 保存している瞬間（UTCのISO等）を、この規則が受け取る Asia/Tokyo 固定形式へ写す。
 *
 * **丸めない。** 秒・ミリ秒が残っている値は、黙って切り捨てると検査した区間と
 * 実際の勤務がずれる。MVPは15分単位なので、ここへ来る時点で0のはず。
 * 0でなければ範囲外として拒否する。
 *
 * 永続層（`Date.toISOString()`）とCSV adapter・時間規則（+09:00固定）の境界で使う。
 * 変換は +09:00 固定で、店舗の `timezone` では計算しない（`MVP_TIMEZONE`）。
 */
export function toJstFixedFormat(instant: string): string {
  if (!HAS_EXPLICIT_OFFSET.test(instant)) {
    throw new TaskcalError(
      ERROR_CODES.INVALID_INPUT,
      `タイムゾーンの無い日時は受け取れません: ${instant}`,
    );
  }
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, `日時を解釈できません: ${instant}`);
  }
  if (ms % 60_000 !== 0) {
    throw new TaskcalError(ERROR_CODES.OUT_OF_SCOPE, `秒未満を含む日時は対象外です: ${instant}`);
  }
  return formatJstTimestamp(ms);
}

function isActiveAssignment(status: AssignmentStatus): boolean {
  return ACTIVE_ASSIGNMENT_STATUSES.includes(status);
}

function assertMonthContainsDate(month: string, date: string): void {
  const { year, month: monthNumber } = parseMonth(month);
  parseCalendarDate(date);
  if (date.slice(0, 4) !== String(year) || Number(date.slice(5, 7)) !== monthNumber) {
    invalid("対象月外の勤務が含まれています。");
  }
}

/** 半開区間として日時を検査する。通常勤務の長さには上限を適用しない。 */
export function validateTimeRange(range: TimeRange): ParsedRange {
  const startMs = parseJstTimestamp(range.startAt);
  const endMs = parseJstTimestamp(range.endAt);
  if (endMs <= startMs) invalid("勤務の開始時刻は終了時刻より前である必要があります。");
  if (range.startAt.slice(0, 10) !== range.endAt.slice(0, 10)) {
    outOfScope("日跨ぎ勤務は対応範囲外です。");
  }
  const startMinute = Number(range.startAt.slice(14, 16));
  const endMinute = Number(range.endAt.slice(14, 16));
  if (startMinute % TIME_GRANULARITY_MINUTES !== 0 || endMinute % TIME_GRANULARITY_MINUTES !== 0) {
    outOfScope("勤務時間は15分単位で指定してください。");
  }
  return { ...range, startMs, endMs };
}

/** 代替勤務として使う区間のMVP制約を検査する。 */
export function validateCandidateTimeRange(range: TimeRange, businessDate: string): ParsedRange {
  parseCalendarDate(businessDate);
  const parsed = validateTimeRange(range);
  if (range.startAt.slice(0, 10) !== businessDate) {
    outOfScope("勤務区間と営業日が一致しません。");
  }
  const minutes = (parsed.endMs - parsed.startMs) / 60_000;
  if (minutes % TIME_GRANULARITY_MINUTES !== 0) {
    outOfScope("勤務時間は15分単位で指定してください。");
  }
  if (minutes > MAX_ADDITIONAL_SHIFT_MINUTES) {
    outOfScope("代替勤務が最長追加勤務時間を超えています。");
  }
  return parsed;
}

export function durationMinutes(range: TimeRange): number {
  const parsed = validateTimeRange(range);
  return (parsed.endMs - parsed.startMs) / 60_000;
}

/** 半開区間の重複。終点と始点が同じ場合は重複しない。 */
export function overlapsTimeRange(left: TimeRange, right: TimeRange): boolean {
  const a = validateTimeRange(left);
  const b = validateTimeRange(right);
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export function containsTimeRange(container: TimeRange, value: TimeRange): boolean {
  const outer = validateTimeRange(container);
  const inner = validateTimeRange(value);
  return outer.startMs <= inner.startMs && inner.endMs <= outer.endMs;
}

function mergeRanges(ranges: readonly ParsedRange[]): ParsedRange[] {
  const sorted = [...ranges].sort((left, right) => left.startMs - right.startMs);
  const merged: ParsedRange[] = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (!previous || current.startMs > previous.endMs) {
      merged.push(current);
      continue;
    }
    merged[merged.length - 1] = {
      startAt: previous.startAt,
      endAt: formatJstTimestamp(Math.max(previous.endMs, current.endMs)),
      startMs: previous.startMs,
      endMs: Math.max(previous.endMs, current.endMs),
    };
  }
  return merged;
}

function subtractBusyFromWindow(window: ParsedRange, busy: readonly ParsedRange[]): ParsedRange[] {
  let cursor = window.startMs;
  const result: ParsedRange[] = [];
  for (const occupied of busy) {
    if (occupied.endMs <= cursor) continue;
    if (occupied.startMs >= window.endMs) break;
    if (occupied.startMs > cursor) {
      const endMs = Math.min(occupied.startMs, window.endMs);
      result.push({
        startAt: formatJstTimestamp(cursor),
        endAt: formatJstTimestamp(endMs),
        startMs: cursor,
        endMs,
      });
    }
    cursor = Math.max(cursor, occupied.endMs);
    if (cursor >= window.endMs) break;
  }
  if (cursor < window.endMs) {
    result.push({
      startAt: formatJstTimestamp(cursor),
      endAt: formatJstTimestamp(window.endMs),
      startMs: cursor,
      endMs: window.endMs,
    });
  }
  return result;
}

interface DerivedAvailability {
  readonly intervals: readonly TimeRange[];
  readonly splitByExistingAssignment: boolean;
}

/** 可能時間から、同一スタッフの予定・完了勤務を差し引く。 */
function deriveAvailability(input: {
  readonly staffId: string;
  readonly businessDate: string;
  readonly availabilityWindows: readonly TimeRange[];
  readonly existingAssignments: readonly MonthlyAssignment[];
}): DerivedAvailability {
  parseCalendarDate(input.businessDate);
  const windows = mergeRanges(
    input.availabilityWindows
      .filter((window) => window.startAt.slice(0, 10) === input.businessDate)
      .map(validateTimeRange),
  );
  const busy = mergeRanges(
    input.existingAssignments
      .filter(
        (assignment) =>
          assignment.staffId === input.staffId &&
          assignment.businessDate === input.businessDate &&
          isActiveAssignment(assignment.status),
      )
      .map((assignment) => {
        if (assignment.startAt.slice(0, 10) !== assignment.businessDate) {
          outOfScope("勤務区間と営業日が一致しません。");
        }
        return validateTimeRange(assignment);
      }),
  );
  const availableByWindow = windows.map((window) => subtractBusyFromWindow(window, busy));
  return {
    intervals: mergeRanges(availableByWindow.flat()).map(({ startAt, endAt }) => ({
      startAt,
      endAt,
    })),
    splitByExistingAssignment: availableByWindow.some((intervals) => intervals.length > 1),
  };
}

export function deriveAvailableIntervals(input: {
  readonly staffId: string;
  readonly businessDate: string;
  readonly availabilityWindows: readonly TimeRange[];
  readonly existingAssignments: readonly MonthlyAssignment[];
}): readonly TimeRange[] {
  return deriveAvailability(input).intervals;
}

function assertCompleteMonthlySchedule(snapshot: MonthlyScheduleSnapshot): void {
  if (snapshot.timezone !== MVP_TIMEZONE) {
    invalid("MVPで対応する勤務表のタイムゾーンが不正です。");
  }
  if (!snapshot.sourceRevision) {
    invalid("勤務表の内容版が必要です。");
  }
  if (
    snapshot.staffIds.length === 0 ||
    new Set(snapshot.staffIds).size !== snapshot.staffIds.length
  ) {
    invalid("月次勤務表の対象スタッフ集合が不正です。");
  }
  parseMonth(snapshot.month);
  if (snapshot.completeness !== "COMPLETE") {
    invalid("月次上限を検査するには対象月の勤務表が完全である必要があります。");
  }
  const ids = new Set<string>();
  for (const assignment of snapshot.assignments) {
    if (!assignment.shiftAssignmentId || ids.has(assignment.shiftAssignmentId)) {
      invalid("勤務IDが重複しています。");
    }
    ids.add(assignment.shiftAssignmentId);
    if (!snapshot.staffIds.includes(assignment.staffId)) {
      invalid("勤務のスタッフが月次入力の対象範囲外です。");
    }
    if (!ASSIGNMENT_STATUSES.includes(assignment.status)) {
      outOfScope("対応していない勤務状態です。");
    }
    assertMonthContainsDate(snapshot.month, assignment.businessDate);
    if (assignment.startAt.slice(0, 10) !== assignment.businessDate) {
      outOfScope("勤務区間と営業日が一致しません。");
    }
    validateTimeRange(assignment);
  }
}

/** Q06の月次割当時間。COMPLETEDも数え、CANCELLED/ABSENTは除く。 */
export function calculateMonthlyAssignedMinutes(input: {
  readonly snapshot: MonthlyScheduleSnapshot;
  readonly staffId: string;
}): number {
  assertCompleteMonthlySchedule(input.snapshot);
  if (!input.snapshot.staffIds.includes(input.staffId)) {
    invalid("対象スタッフが月次入力の対象範囲外です。");
  }
  return input.snapshot.assignments
    .filter(
      (assignment) => assignment.staffId === input.staffId && isActiveAssignment(assignment.status),
    )
    .reduce((total, assignment) => total + durationMinutes(assignment), 0);
}

export function calculateMonthlyCapacity(input: {
  readonly snapshot: MonthlyScheduleSnapshot;
  readonly staffId: string;
  readonly limitMinutes: number;
  readonly proposedTime: TimeRange;
  readonly businessDate: string;
}): MonthlyCapacity {
  if (!Number.isInteger(input.limitMinutes) || input.limitMinutes < 0) {
    invalid("月次上限は0以上の整数分で指定してください。");
  }
  assertMonthContainsDate(input.snapshot.month, input.businessDate);
  const proposed = validateCandidateTimeRange(input.proposedTime, input.businessDate);
  const usedMinutes = calculateMonthlyAssignedMinutes({
    snapshot: input.snapshot,
    staffId: input.staffId,
  });
  const proposedMinutes = (proposed.endMs - proposed.startMs) / 60_000;
  return {
    limitMinutes: input.limitMinutes,
    usedMinutes,
    proposedMinutes,
    remainingBeforeMinutes: input.limitMinutes - usedMinutes,
    remainingAfterMinutes: input.limitMinutes - usedMinutes - proposedMinutes,
    withinLimit: usedMinutes + proposedMinutes <= input.limitMinutes,
  };
}

function findMonthlyLimit(staff: StaffProfile, month: string): MonthlyWorkLimit | undefined {
  const matches = staff.monthlyWorkLimits.filter((limit) => limit.targetMonth === month);
  if (matches.length > 1) invalid("同じ対象月の月次上限が重複しています。");
  const limit = matches[0];
  if (limit && (!Number.isInteger(limit.limitMinutes) || limit.limitMinutes < 0)) {
    invalid("月次上限は0以上の整数分で指定してください。");
  }
  return limit;
}

function ineligible(
  input: CandidateEligibilityInput,
  reason: CandidateIneligibility,
  availableIntervals: readonly TimeRange[] = [],
  monthlyCapacity?: MonthlyCapacity,
): CandidateEligibilityResult {
  return {
    eligible: false,
    staffId: input.staff.staffId,
    proposedTime: input.proposedTime,
    availableIntervals,
    reason,
    monthlyCapacity,
  };
}

/**
 * 店舗・職種・在籍・欠勤者除外・重複・可能時間・月次上限を一括で検査する。
 *
 * `eligible: true`は時間・勤務条件上の適格性であり、本人確認、対象打診との対応、
 * 最新の有効なCommitment、期限・停止状態、sourceRevisionの再検査、正式採用の認可を
 * 意味しない。これらはapplicationが正式採用直前に検査する。
 */
export function evaluateCandidateEligibility(
  input: CandidateEligibilityInput,
): CandidateEligibilityResult {
  const proposed = validateCandidateTimeRange(input.proposedTime, input.businessDate);
  if (input.monthlySchedule.storeId !== input.storeId) {
    invalid("対象店舗と月次勤務表の店舗が一致しません。");
  }
  assertCompleteMonthlySchedule(input.monthlySchedule);
  assertMonthContainsDate(input.monthlySchedule.month, input.businessDate);

  if (input.staff.status !== "ACTIVE") {
    return ineligible(input, CANDIDATE_INELIGIBILITY.STAFF_INACTIVE);
  }
  if (input.staff.storeId !== input.storeId) {
    return ineligible(input, CANDIDATE_INELIGIBILITY.WRONG_STORE);
  }
  if (!input.staff.roleCodes.includes(input.roleCode)) {
    return ineligible(input, CANDIDATE_INELIGIBILITY.ROLE_NOT_ALLOWED);
  }
  if (input.staff.staffId === input.absentStaffId) {
    return ineligible(input, CANDIDATE_INELIGIBILITY.ABSENT_STAFF);
  }
  if (!input.monthlySchedule.staffIds.includes(input.staff.staffId)) {
    return ineligible(input, CANDIDATE_INELIGIBILITY.STAFF_NOT_IN_MONTHLY_SNAPSHOT);
  }

  if (
    input.monthlySchedule.assignments.some(
      (assignment) =>
        assignment.staffId === input.staff.staffId &&
        assignment.businessDate === input.businessDate &&
        isActiveAssignment(assignment.status) &&
        overlapsTimeRange(assignment, proposed),
    )
  ) {
    return ineligible(input, CANDIDATE_INELIGIBILITY.EXISTING_ASSIGNMENT_OVERLAP);
  }

  const derivedAvailability = deriveAvailability({
    staffId: input.staff.staffId,
    businessDate: input.businessDate,
    availabilityWindows: input.staff.availabilityWindows,
    existingAssignments: input.monthlySchedule.assignments,
  });
  const availableIntervals = derivedAvailability.intervals;
  if (derivedAvailability.splitByExistingAssignment) {
    return ineligible(input, CANDIDATE_INELIGIBILITY.OUT_OF_SCOPE, availableIntervals);
  }
  if (!availableIntervals.some((available) => containsTimeRange(available, proposed))) {
    return ineligible(input, CANDIDATE_INELIGIBILITY.AVAILABILITY_NOT_COVERED, availableIntervals);
  }
  const monthlyLimit = findMonthlyLimit(input.staff, input.monthlySchedule.month);
  if (!monthlyLimit) {
    return ineligible(
      input,
      CANDIDATE_INELIGIBILITY.MONTHLY_CAP_NOT_CONFIGURED,
      availableIntervals,
    );
  }
  const monthlyCapacity = calculateMonthlyCapacity({
    snapshot: input.monthlySchedule,
    staffId: input.staff.staffId,
    limitMinutes: monthlyLimit.limitMinutes,
    proposedTime: proposed,
    businessDate: input.businessDate,
  });
  if (!monthlyCapacity.withinLimit) {
    return ineligible(
      input,
      CANDIDATE_INELIGIBILITY.MONTHLY_CAP_EXCEEDED,
      availableIntervals,
      monthlyCapacity,
    );
  }
  return {
    eligible: true,
    staffId: input.staff.staffId,
    proposedTime: input.proposedTime,
    availableIntervals,
    monthlyCapacity,
  };
}
