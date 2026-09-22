import { describe, expect, it } from "vitest";
import {
  CANDIDATE_INELIGIBILITY,
  calculateMonthlyAssignedMinutes,
  deriveAvailableIntervals,
  evaluateCandidateEligibility,
  overlapsTimeRange,
  validateCandidateTimeRange,
  type MonthlyAssignment,
  type MonthlyScheduleSnapshot,
  type StaffProfile,
  calculateMonthlyCapacity,
} from "@/domain/interval";

const STAFF_A = "00000004-0000-4000-8000-000000000001";
const STAFF_B = "00000004-0000-4000-8000-000000000002";
const STAFF_C = "00000004-0000-4000-8000-000000000003";
const STAFF_OUTSIDE = "00000004-0000-4000-8000-000000000099";
const STORE = "00000001-0000-4000-8000-000000000001";

const range = (startAt: string, endAt: string) => ({ startAt, endAt });

const assignment = (
  id: string,
  staffId: string,
  startAt: string,
  endAt: string,
  status: MonthlyAssignment["status"],
  businessDate = "2026-09-21",
): MonthlyAssignment => ({
  shiftAssignmentId: id,
  businessDate,
  staffId,
  roleCode: "FLOOR",
  startAt,
  endAt,
  status,
});

const snapshot = (
  assignments: readonly MonthlyAssignment[] = [],
  staffIds: readonly string[] = [STAFF_A, STAFF_B, STAFF_C],
): MonthlyScheduleSnapshot => ({
  storeId: STORE,
  timezone: "Asia/Tokyo",
  month: "2026-09",
  sourceRevision: "test-source-revision",
  staffIds,
  completeness: "COMPLETE",
  assignments,
});

const staff = (overrides: Partial<StaffProfile> = {}): StaffProfile => ({
  staffId: STAFF_B,
  storeId: STORE,
  status: "ACTIVE",
  roleCodes: ["FLOOR"],
  availabilityWindows: [range("2026-09-21T18:00:00+09:00", "2026-09-21T22:00:00+09:00")],
  monthlyWorkLimits: [{ targetMonth: "2026-09", limitMinutes: 600 }],
  ...overrides,
});

describe("interval domain (U03)", () => {
  it("A17: 半開区間は接しているだけなら重複しない", () => {
    expect(
      overlapsTimeRange(
        range("2026-09-21T18:00:00+09:00", "2026-09-21T19:00:00+09:00"),
        range("2026-09-21T19:00:00+09:00", "2026-09-21T22:00:00+09:00"),
      ),
    ).toBe(false);
  });

  it.each([
    ["日跨ぎ", range("2026-09-21T22:00:00+09:00", "2026-09-22T01:00:00+09:00")],
    ["15分刻み外", range("2026-09-21T18:00:00+09:00", "2026-09-21T19:05:00+09:00")],
    ["開始時刻の15分刻み外", range("2026-09-21T18:05:00+09:00", "2026-09-21T19:05:00+09:00")],
    ["4時間超", range("2026-09-21T18:00:00+09:00", "2026-09-21T22:15:00+09:00")],
  ] as const)("A10/A17: %sはOUT_OF_SCOPEで拒否する", (label, proposed) => {
    expect(() => validateCandidateTimeRange(proposed, "2026-09-21")).toThrow(
      expect.objectContaining({ code: "OUT_OF_SCOPE" }),
    );
    expect(label).toBeTruthy();
  });

  it.each(["SCHEDULED", "COMPLETED"] as const)(
    "A17: %s勤務を差し引いた分断空き時間を1区間へ丸めない",
    (status) => {
      const available = deriveAvailableIntervals({
        staffId: STAFF_B,
        businessDate: "2026-09-21",
        availabilityWindows: staff().availabilityWindows,
        existingAssignments: [
          assignment(
            "00000003-0000-4000-8000-000000000001",
            STAFF_B,
            "2026-09-21T19:00:00+09:00",
            "2026-09-21T20:00:00+09:00",
            status,
          ),
        ],
      });
      expect(available).toEqual([
        range("2026-09-21T18:00:00+09:00", "2026-09-21T19:00:00+09:00"),
        range("2026-09-21T20:00:00+09:00", "2026-09-21T22:00:00+09:00"),
      ]);
    },
  );

  it("複数の独立した可能時間のうち、候補時間を覆う区間があれば分断扱いにしない", () => {
    const result = evaluateCandidateEligibility({
      storeId: STORE,
      roleCode: "FLOOR",
      businessDate: "2026-09-21",
      proposedTime: range("2026-09-21T18:00:00+09:00", "2026-09-21T19:00:00+09:00"),
      absentStaffId: STAFF_A,
      staff: staff({
        availabilityWindows: [
          range("2026-09-21T18:00:00+09:00", "2026-09-21T19:00:00+09:00"),
          range("2026-09-21T20:00:00+09:00", "2026-09-21T22:00:00+09:00"),
        ],
      }),
      monthlySchedule: snapshot(),
    });
    expect(result).toMatchObject({ eligible: true });
  });

  it("複数の独立した可能時間に候補時間が収まらなければAVAILABILITY_NOT_COVEREDにする", () => {
    const result = evaluateCandidateEligibility({
      storeId: STORE,
      roleCode: "FLOOR",
      businessDate: "2026-09-21",
      proposedTime: range("2026-09-21T19:00:00+09:00", "2026-09-21T20:00:00+09:00"),
      absentStaffId: STAFF_A,
      staff: staff({
        availabilityWindows: [
          range("2026-09-21T18:00:00+09:00", "2026-09-21T19:00:00+09:00"),
          range("2026-09-21T20:00:00+09:00", "2026-09-21T22:00:00+09:00"),
        ],
      }),
      monthlySchedule: snapshot(),
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: CANDIDATE_INELIGIBILITY.AVAILABILITY_NOT_COVERED,
    });
  });

  it("月次入力で対象外のスタッフは月次0分として扱わない", () => {
    const result = evaluateCandidateEligibility({
      storeId: STORE,
      roleCode: "FLOOR",
      businessDate: "2026-09-21",
      proposedTime: range("2026-09-21T18:00:00+09:00", "2026-09-21T22:00:00+09:00"),
      absentStaffId: STAFF_A,
      staff: staff({ staffId: STAFF_OUTSIDE }),
      monthlySchedule: snapshot([], [STAFF_A, STAFF_B, STAFF_C]),
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: CANDIDATE_INELIGIBILITY.STAFF_NOT_IN_MONTHLY_SNAPSHOT,
    });
  });

  it("A09: COMPLETEDとSCHEDULEDを数え、CANCELLEDとABSENTを除く", () => {
    const result = calculateMonthlyAssignedMinutes({
      snapshot: snapshot([
        assignment(
          "00000003-0000-4000-8000-000000000001",
          STAFF_B,
          "2026-09-01T10:00:00+09:00",
          "2026-09-01T18:00:00+09:00",
          "COMPLETED",
          "2026-09-01",
        ),
        assignment(
          "00000003-0000-4000-8000-000000000002",
          STAFF_B,
          "2026-09-21T12:00:00+09:00",
          "2026-09-21T16:00:00+09:00",
          "SCHEDULED",
        ),
        assignment(
          "00000003-0000-4000-8000-000000000003",
          STAFF_B,
          "2026-09-10T18:00:00+09:00",
          "2026-09-10T22:00:00+09:00",
          "CANCELLED",
          "2026-09-10",
        ),
        assignment(
          "00000003-0000-4000-8000-000000000004",
          STAFF_B,
          "2026-09-22T18:00:00+09:00",
          "2026-09-22T22:00:00+09:00",
          "ABSENT",
          "2026-09-22",
        ),
        assignment(
          "00000003-0000-4000-8000-000000000005",
          STAFF_C,
          "2026-09-21T18:00:00+09:00",
          "2026-09-21T22:00:00+09:00",
          "SCHEDULED",
        ),
      ]),
      staffId: STAFF_B,
    });
    expect(result).toBe(12 * 60);
  });

  it("A09: 月内入力がINCOMPLETE/UNKNOWNなら上限を推測せず拒否する", () => {
    for (const completeness of ["INCOMPLETE", "UNKNOWN"] as const) {
      expect(() =>
        calculateMonthlyAssignedMinutes({
          snapshot: { ...snapshot(), completeness },
          staffId: STAFF_B,
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it("候補の適格性を店舗・職種・在籍・欠勤者・重複・月次上限で検査する", () => {
    const input = {
      storeId: STORE,
      roleCode: "FLOOR",
      businessDate: "2026-09-21",
      proposedTime: range("2026-09-21T18:00:00+09:00", "2026-09-21T22:00:00+09:00"),
      absentStaffId: STAFF_A,
      staff: staff(),
      monthlySchedule: snapshot(),
    };
    expect(evaluateCandidateEligibility(input)).toMatchObject({ eligible: true });

    expect(evaluateCandidateEligibility({ ...input, absentStaffId: STAFF_B })).toMatchObject({
      eligible: false,
      reason: CANDIDATE_INELIGIBILITY.ABSENT_STAFF,
    });
    expect(
      evaluateCandidateEligibility({ ...input, staff: staff({ roleCodes: ["KITCHEN"] }) }),
    ).toMatchObject({ eligible: false, reason: CANDIDATE_INELIGIBILITY.ROLE_NOT_ALLOWED });
    expect(
      evaluateCandidateEligibility({ ...input, staff: staff({ status: "INACTIVE" }) }),
    ).toMatchObject({ eligible: false, reason: CANDIDATE_INELIGIBILITY.STAFF_INACTIVE });
    expect(
      evaluateCandidateEligibility({
        ...input,
        staff: staff({ storeId: "00000001-0000-4000-8000-000000000099" }),
      }),
    ).toMatchObject({ eligible: false, reason: CANDIDATE_INELIGIBILITY.WRONG_STORE });
    expect(
      evaluateCandidateEligibility({
        ...input,
        monthlySchedule: snapshot([
          assignment(
            "00000003-0000-4000-8000-000000000009",
            STAFF_B,
            "2026-09-21T19:00:00+09:00",
            "2026-09-21T20:00:00+09:00",
            "SCHEDULED",
          ),
        ]),
      }),
    ).toMatchObject({
      eligible: false,
      reason: CANDIDATE_INELIGIBILITY.EXISTING_ASSIGNMENT_OVERLAP,
    });
  });

  it("A17: 分断空きは候補だけを不適格にし、範囲外として理由を残す", () => {
    const result = evaluateCandidateEligibility({
      storeId: STORE,
      roleCode: "FLOOR",
      businessDate: "2026-09-21",
      proposedTime: range("2026-09-21T18:00:00+09:00", "2026-09-21T19:00:00+09:00"),
      absentStaffId: STAFF_A,
      staff: staff(),
      monthlySchedule: snapshot([
        assignment(
          "00000003-0000-4000-8000-000000000010",
          STAFF_B,
          "2026-09-21T19:00:00+09:00",
          "2026-09-21T20:00:00+09:00",
          "SCHEDULED",
        ),
      ]),
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: CANDIDATE_INELIGIBILITY.OUT_OF_SCOPE,
      availableIntervals: [
        range("2026-09-21T18:00:00+09:00", "2026-09-21T19:00:00+09:00"),
        range("2026-09-21T20:00:00+09:00", "2026-09-21T22:00:00+09:00"),
      ],
    });
  });

  it("A09: 完了済み勤務で月次枠を使い、代替勤務追加後の残枠を検査する", () => {
    const result = evaluateCandidateEligibility({
      storeId: STORE,
      roleCode: "FLOOR",
      businessDate: "2026-09-21",
      proposedTime: range("2026-09-21T18:00:00+09:00", "2026-09-21T22:00:00+09:00"),
      absentStaffId: STAFF_A,
      staff: staff({
        monthlyWorkLimits: [{ targetMonth: "2026-09", limitMinutes: 12 * 60 + 4 * 60 }],
      }),
      monthlySchedule: snapshot([
        assignment(
          "00000003-0000-4000-8000-000000000011",
          STAFF_B,
          "2026-09-01T10:00:00+09:00",
          "2026-09-01T18:00:00+09:00",
          "COMPLETED",
          "2026-09-01",
        ),
        assignment(
          "00000003-0000-4000-8000-000000000012",
          STAFF_B,
          "2026-09-21T12:00:00+09:00",
          "2026-09-21T16:00:00+09:00",
          "SCHEDULED",
        ),
      ]),
    });
    expect(result).toMatchObject({ eligible: true });
    expect(result.monthlyCapacity).toMatchObject({
      usedMinutes: 12 * 60,
      proposedMinutes: 4 * 60,
      remainingAfterMinutes: 0,
      withinLimit: true,
    });
  });

  it("A09: 月次上限超過は候補を不適格にする", () => {
    const result = evaluateCandidateEligibility({
      storeId: STORE,
      roleCode: "FLOOR",
      businessDate: "2026-09-21",
      proposedTime: range("2026-09-21T18:00:00+09:00", "2026-09-21T22:00:00+09:00"),
      absentStaffId: STAFF_A,
      staff: staff({ monthlyWorkLimits: [{ targetMonth: "2026-09", limitMinutes: 12 * 60 }] }),
      monthlySchedule: snapshot([
        assignment(
          "00000003-0000-4000-8000-000000000013",
          STAFF_B,
          "2026-09-01T10:00:00+09:00",
          "2026-09-01T18:00:00+09:00",
          "COMPLETED",
          "2026-09-01",
        ),
        assignment(
          "00000003-0000-4000-8000-000000000014",
          STAFF_B,
          "2026-09-21T12:00:00+09:00",
          "2026-09-21T16:00:00+09:00",
          "SCHEDULED",
        ),
      ]),
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: CANDIDATE_INELIGIBILITY.MONTHLY_CAP_EXCEEDED,
    });
    expect(result.monthlyCapacity?.remainingAfterMinutes).toBe(-4 * 60);
  });

  it("A09: 直接の月次余力計算でも候補日とsnapshot月の不一致を拒否する", () => {
    expect(() =>
      calculateMonthlyCapacity({
        snapshot: snapshot(),
        staffId: STAFF_B,
        limitMinutes: 6 * 60,
        proposedTime: range("2026-10-01T18:00:00+09:00", "2026-10-01T22:00:00+09:00"),
        businessDate: "2026-10-01",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("取消・欠勤勤務は候補の既存重複にも月次上限にも数えない", () => {
    const cancelled = assignment(
      "00000003-0000-4000-8000-000000000015",
      STAFF_B,
      "2026-09-21T18:00:00+09:00",
      "2026-09-21T22:00:00+09:00",
      "CANCELLED",
    );
    const absent = assignment(
      "00000003-0000-4000-8000-000000000016",
      STAFF_B,
      "2026-09-21T18:00:00+09:00",
      "2026-09-21T22:00:00+09:00",
      "ABSENT",
    );
    expect(
      evaluateCandidateEligibility({
        storeId: STORE,
        roleCode: "FLOOR",
        businessDate: "2026-09-21",
        proposedTime: range("2026-09-21T18:00:00+09:00", "2026-09-21T22:00:00+09:00"),
        absentStaffId: STAFF_A,
        staff: staff({ monthlyWorkLimits: [{ targetMonth: "2026-09", limitMinutes: 4 * 60 }] }),
        monthlySchedule: snapshot([cancelled, absent]),
      }),
    ).toMatchObject({ eligible: true });
  });
});
