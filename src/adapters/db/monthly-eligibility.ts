import "server-only";
import type { Tx } from "./transaction";
import { TaskcalError } from "../../contracts/errors";
import { computeRequestHash } from "../../contracts/operation";
import type { MonthlyScheduleSnapshot, StaffProfile } from "../../domain/interval";

/** 固定デモの可能時間。永続化先が未承認なので、対象日以外は検査不能として止める。 */
const DEMO_DATES = new Set(["2026-09-21", "2026-09-22", "2026-09-25"]);
const jst = (value: Date): string =>
  `${new Date(value.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19)}+09:00`;

export async function loadLatestMonthlyEligibility(
  tx: Tx,
  input: {
    storeId: string;
    businessDate: string;
    allowedDates?: ReadonlySet<string>;
  },
): Promise<{ monthlySchedule: MonthlyScheduleSnapshot; staffProfiles: readonly StaffProfile[] }> {
  if (!(input.allowedDates ?? DEMO_DATES).has(input.businessDate)) {
    throw new TaskcalError("OUT_OF_SCOPE", "可能時間が設定された固定デモ日ではありません。");
  }
  const month = input.businessDate.slice(0, 7);
  const days = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
  ).getUTCDate();
  const refs = await tx.query<{
    date: string;
    source_revision: string;
    artifact_ref: string;
    version: number;
  }>(
    `select to_char(s.business_date, 'YYYY-MM-DD') as date, r.source_revision, r.artifact_ref, r.version
       from schedule s join authoritative_schedule_ref r on r.schedule_id = s.schedule_id
      where s.store_id = $1 and s.business_date >= $2::date
        and s.business_date < ($2::date + interval '1 month') order by s.business_date`,
    [input.storeId, `${month}-01`],
  );
  const dates = new Set(refs.rows.map((row) => row.date));
  if (
    dates.size !== days ||
    Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`).some(
      (date) => !dates.has(date),
    )
  ) {
    throw new TaskcalError("INVALID_INPUT", "月内勤務表の正式版参照が完全ではありません。");
  }
  const staff = await tx.query<{
    staff_id: string;
    store_id: string;
    role_code: string;
    active: boolean;
    monthly_cap_minutes: number;
  }>(
    `select staff_id, store_id, role_code, active, monthly_cap_minutes from staff
        where store_id = $1 order by staff_id`,
    [input.storeId],
  );
  if (staff.rows.length !== 4) {
    throw new TaskcalError("INVALID_INPUT", "固定fixtureのスタッフ集合が一致しません。");
  }
  const shifts = await tx.query<{
    shift_assignment_id: string;
    business_date: string;
    staff_id: string;
    role_code: string;
    start_at: Date;
    end_at: Date;
    status: MonthlyScheduleSnapshot["assignments"][number]["status"];
  }>(
    `select a.shift_assignment_id, to_char(s.business_date, 'YYYY-MM-DD') as business_date,
              a.staff_id, a.role_code, a.start_at, a.end_at, a.status
         from shift_assignment a join schedule s on s.schedule_id = a.schedule_id
        where s.store_id = $1 and s.business_date >= $2::date
          and s.business_date < ($2::date + interval '1 month')
        order by a.shift_assignment_id`,
    [input.storeId, `${month}-01`],
  );
  const assignments = shifts.rows.map((row) => ({
    shiftAssignmentId: row.shift_assignment_id,
    businessDate: row.business_date,
    staffId: row.staff_id,
    roleCode: row.role_code,
    startAt: jst(row.start_at),
    endAt: jst(row.end_at),
    status: row.status,
  }));
  const monthlyRevision = computeRequestHash({
    refs: refs.rows,
    assignments,
    staff: staff.rows,
  });
  return {
    monthlySchedule: {
      storeId: input.storeId,
      timezone: "Asia/Tokyo",
      month,
      sourceRevision: monthlyRevision,
      staffIds: staff.rows.map((row) => row.staff_id),
      completeness: "COMPLETE",
      assignments,
    },
    staffProfiles: staff.rows.map((row) => ({
      staffId: row.staff_id,
      storeId: row.store_id,
      status: row.active ? ("ACTIVE" as const) : ("INACTIVE" as const),
      roleCodes: [row.role_code],
      availabilityWindows: [
        {
          startAt: `${input.businessDate}T18:00:00+09:00`,
          endAt: `${input.businessDate}T22:00:00+09:00`,
        },
      ],
      monthlyWorkLimits: [{ targetMonth: month, limitMinutes: row.monthly_cap_minutes }],
    })),
  };
}
