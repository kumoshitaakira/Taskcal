import type { MonthlyCsv } from "@/adapters/csv/monthly-csv";
import { TaskcalError } from "@/contracts/errors";
import { MVP_TIMEZONE, type MonthlyScheduleSnapshot } from "@/domain/interval";

const MONTH_PATTERN = /^([1-9]\d{3})-(0[1-9]|1[0-2])$/;

function invalid(message: string): never {
  throw new TaskcalError("INVALID_INPUT", message);
}

function monthDates(month: string): readonly string[] {
  const match = MONTH_PATTERN.exec(month);
  if (!match) invalid("対象月の形式が不正です。");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from(
    { length: dayCount },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
  );
}

/**
 * CSV adapterの結果を、月次上限検査へ渡せる完全なdomain snapshotへ変換する。
 *
 * `COMPLETE`は呼び出し側の文字列をそのまま信頼せず、対象月の全日が宣言され、
 * 欠損日がないことをここで再検査する。正式採用前の版再検査に使えるよう、
 * adapterが計算したsourceRevisionもsnapshotへ保持する。
 */
export function createMonthlyScheduleSnapshot(monthlyCsv: MonthlyCsv): MonthlyScheduleSnapshot {
  if (monthlyCsv.manifest.timezone !== MVP_TIMEZONE) {
    invalid("MVPで対応する勤務表のタイムゾーンが不正です。");
  }
  if (!monthlyCsv.sourceRevision) {
    invalid("勤務表の内容版が必要です。");
  }
  if (monthlyCsv.completeness !== "COMPLETE" || monthlyCsv.missingDates.length > 0) {
    invalid("月次上限を検査するには対象月の勤務表が完全である必要があります。");
  }

  const expectedDates = monthDates(monthlyCsv.manifest.month);
  const declaredDates = monthlyCsv.manifest.days?.map((day) => day.date);
  if (
    !declaredDates ||
    declaredDates.length !== expectedDates.length ||
    new Set(declaredDates).size !== declaredDates.length ||
    expectedDates.some((date) => !declaredDates.includes(date))
  ) {
    invalid("対象月の全営業日が宣言されていません。");
  }

  return {
    storeId: monthlyCsv.manifest.storeId,
    timezone: monthlyCsv.manifest.timezone,
    month: monthlyCsv.manifest.month,
    sourceRevision: monthlyCsv.sourceRevision,
    staffIds: [...monthlyCsv.manifest.staffIds],
    completeness: "COMPLETE",
    assignments: monthlyCsv.assignments.map(
      ({ shiftAssignmentId, businessDate, staffId, roleCode, startAt, endAt, status }) => ({
        shiftAssignmentId,
        businessDate,
        staffId,
        roleCode,
        startAt,
        endAt,
        status,
      }),
    ),
  };
}
