/**
 * 打診先の適格性（D01、Q06／A09、Q15）。担当Bの規則へ渡す入力の組立てと、結果の分け方。
 *
 * 規則そのものは `tests/unit/interval.test.ts`。ここで見るのは、名簿のうち誰を外し、
 * 理由をどう返すか。可能時間は必要枠そのものを渡すので、ここでは検査されない。
 */

import { describe, expect, it } from "vitest";
import {
  buildListEligibleInput,
  createOutreachEligibility,
} from "@/application/outreach-eligibility";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import type { StaffConditions } from "@/contracts/repository";
import type { LoadedSchedule } from "@/contracts/schedule-gateway";

const STORE = "00000001-0000-4000-8000-000000000001";
const ABSENT = "00000004-0000-4000-8000-000000000001";
const FREE = "00000004-0000-4000-8000-000000000002";
const BUSY = "00000004-0000-4000-8000-000000000003";
const INACTIVE = "00000004-0000-4000-8000-000000000004";
const CAPPED = "00000004-0000-4000-8000-000000000005";
const UNKNOWN = "00000004-0000-4000-8000-000000000006";

const snapshot = {
  storeId: STORE,
  connectionId: "mock:test",
  scheduleId: "00000002-0000-4000-8000-000000000026",
  businessDate: "2026-09-26",
  absentStaffId: ABSENT,
  roleCode: "FLOOR",
  // 永続層の形（UTC）。判定側の形（+09:00）へ写されることを確かめる。
  requiredStartAt: "2026-09-26T09:00:00.000Z",
  requiredEndAt: "2026-09-26T13:00:00.000Z",
};

function schedule(overrides: Partial<LoadedSchedule> = {}): LoadedSchedule {
  return {
    scheduleId: snapshot.scheduleId,
    sourceRevision: "b".repeat(64),
    requestedRange: { fromDate: "2026-09-01", toDate: "2026-10-01" },
    completeness: "COMPLETE",
    missingDates: [],
    assignments: [
      {
        shiftAssignmentId: "00000003-0000-4000-8000-000000000001",
        staffId: ABSENT,
        roleCode: "FLOOR",
        startAt: "2026-09-26T09:00:00.000Z",
        endAt: "2026-09-26T13:00:00.000Z",
        status: "SCHEDULED",
      },
      // BUSY は同じ日の 19〜21時に勤務がある。必要枠 18〜22時と重なる。
      {
        shiftAssignmentId: "00000003-0000-4000-8000-000000000002",
        staffId: BUSY,
        roleCode: "FLOOR",
        startAt: "2026-09-26T10:00:00.000Z",
        endAt: "2026-09-26T12:00:00.000Z",
        status: "SCHEDULED",
      },
      // CAPPED は月内に既に 120 分の割当がある（上限 300 分に 180 分しか残らない）。
      // 完了済みも数える（Q06）。
      {
        shiftAssignmentId: "00000003-0000-4000-8000-000000000003",
        staffId: CAPPED,
        roleCode: "FLOOR",
        startAt: "2026-09-20T09:00:00.000Z",
        endAt: "2026-09-20T11:00:00.000Z",
        status: "COMPLETED",
      },
    ],
    ...overrides,
  };
}

function conditions(): StaffConditions[] {
  return [
    { staffId: ABSENT, storeId: STORE, active: true, roleCode: "FLOOR", monthlyCapMinutes: 9600 },
    { staffId: FREE, storeId: STORE, active: true, roleCode: "FLOOR", monthlyCapMinutes: 9600 },
    { staffId: BUSY, storeId: STORE, active: true, roleCode: "FLOOR", monthlyCapMinutes: 9600 },
    {
      staffId: INACTIVE,
      storeId: STORE,
      active: false,
      roleCode: "FLOOR",
      monthlyCapMinutes: 9600,
    },
    { staffId: CAPPED, storeId: STORE, active: true, roleCode: "FLOOR", monthlyCapMinutes: 300 },
  ];
}

const roster = [FREE, BUSY, INACTIVE, CAPPED, UNKNOWN].map((staffId) => ({
  staffId,
  endpointKey: `staff:${staffId}`,
  endpointVersion: 1,
}));

describe("打診先の適格性", () => {
  it("在籍・重複・月次上限で外し、理由を相手ごとに返す。適格な相手には必要枠そのものを提示する", () => {
    const listing = createOutreachEligibility().listEligible(
      buildListEligibleInput({
        snapshot,
        storeTimezone: "Asia/Tokyo",
        reloaded: schedule(),
        conditions: conditions(),
        roster,
      }),
    );
    expect(listing.eligible).toEqual([
      {
        staffId: FREE,
        endpointKey: `staff:${FREE}`,
        endpointVersion: 1,
        offeredStartAt: "2026-09-26T18:00:00+09:00",
        offeredEndAt: "2026-09-26T22:00:00+09:00",
      },
    ]);
    expect(listing.excluded).toEqual([
      { staffId: BUSY, reason: "EXISTING_ASSIGNMENT_OVERLAP" },
      { staffId: INACTIVE, reason: "STAFF_INACTIVE" },
      { staffId: CAPPED, reason: "MONTHLY_CAP_EXCEEDED" },
      { staffId: UNKNOWN, reason: "CONDITIONS_MISSING" },
    ]);
  });

  it("A09：範囲宣言に無い相手は「勤務0件＝残枠あり」と読まず、対象外として外す", () => {
    // 宣言は FREE だけ。BUSY 等は名簿には居るが、月内入力が揃っているとは言えない。
    const listing = createOutreachEligibility().listEligible(
      buildListEligibleInput({
        snapshot,
        storeTimezone: "Asia/Tokyo",
        reloaded: schedule({ declaredStaffIds: [ABSENT, FREE] }),
        conditions: conditions(),
        roster,
      }),
    );
    expect(listing.eligible.map((c) => c.staffId)).toEqual([FREE]);
    expect(listing.excluded).toEqual(
      expect.arrayContaining([
        { staffId: BUSY, reason: "STAFF_NOT_IN_MONTHLY_SNAPSHOT" },
        { staffId: CAPPED, reason: "STAFF_NOT_IN_MONTHLY_SNAPSHOT" },
      ]),
    );
  });

  it("A09：月内入力が完全でなければ判定せず、打診を始めさせない", () => {
    const input = buildListEligibleInput({
      snapshot,
      storeTimezone: "Asia/Tokyo",
      reloaded: schedule({ completeness: "INCOMPLETE", missingDates: ["2026-09-30"] }),
      conditions: conditions(),
      roster,
    });
    let thrown: unknown;
    try {
      createOutreachEligibility().listEligible(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaskcalError);
    expect((thrown as TaskcalError).code).toBe(ERROR_CODES.INVALID_INPUT);
  });

  it("取得範囲が対象月を覆っていなければ、COMPLETE でも信じない", () => {
    expect(() =>
      buildListEligibleInput({
        snapshot,
        storeTimezone: "Asia/Tokyo",
        reloaded: schedule({ requestedRange: { fromDate: "2026-09-20", toDate: "2026-10-01" } }),
        conditions: conditions(),
        roster,
      }),
    ).toThrow(TaskcalError);
  });

  it("判定に要る行だけを渡す（名簿に居ない人の勤務は含めない）", () => {
    const input = buildListEligibleInput({
      snapshot,
      storeTimezone: "Asia/Tokyo",
      reloaded: schedule(),
      conditions: conditions(),
      roster: roster.filter((c) => c.staffId === FREE),
    });
    expect(input.monthlySchedule.staffIds).toEqual([FREE]);
    expect(input.monthlySchedule.assignments).toEqual([]);
    expect(input.staffProfiles.map((p) => p.staffId)).toEqual([FREE]);
  });
});
