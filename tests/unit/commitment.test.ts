import { describe, expect, it } from "vitest";
import {
  ALLOWED_COMMITMENT_TRANSITIONS,
  COMMITMENT_BLOCK_REASON,
  COMMITMENT_STATUSES,
  TERMINAL_COMMITMENT_STATUSES,
  isAllowedCommitmentTransition,
  isSelectableCommitment,
  type CommitmentStatus,
} from "@/contracts/commitment";
import { TaskcalError } from "@/contracts/errors";

const DEADLINE = "2026-09-21T12:00:00+09:00";
const BEFORE = "2026-09-21T09:00:00+09:00";
const AFTER = "2026-09-21T12:00:00+09:00";

function selectable(overrides: Partial<Parameters<typeof isSelectableCommitment>[0]> = {}) {
  return isSelectableCommitment({
    status: "ACTIVE",
    hasUnprocessedReply: false,
    deadlineAt: DEADLINE,
    now: BEFORE,
    ...overrides,
  });
}

describe("承諾の状態遷移（RFC-011 §4）", () => {
  it("保留から有効へ戻せる（追加確認で条件が一意に定まった場合）", () => {
    expect(isAllowedCommitmentTransition("HELD", "ACTIVE")).toBe(true);
  });

  it("置き換え済み・撤回・失効からは動かさない（旧内容を書き換えない）", () => {
    for (const terminal of TERMINAL_COMMITMENT_STATUSES) {
      for (const to of COMMITMENT_STATUSES) {
        expect(isAllowedCommitmentTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("全ての status が遷移表に載っている", () => {
    for (const status of COMMITMENT_STATUSES) {
      expect(ALLOWED_COMMITMENT_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("未知の status は遷移禁止ではなく入力エラーにする", () => {
    expect(() =>
      isAllowedCommitmentTransition("UNKNOWN_STATUS" as CommitmentStatus, "ACTIVE"),
    ).toThrowError(TaskcalError);
  });
});

describe("選定できる承諾の判定（D04 / A05の前提）", () => {
  it("有効・未処理返信なし・期限内なら選定できる", () => {
    expect(selectable()).toEqual({ selectable: true });
  });

  it("有効でも未処理の新しい返信があれば選定しない（A05の前提：更新準備中の訂正）", () => {
    expect(selectable({ hasUnprocessedReply: true })).toEqual({
      selectable: false,
      reason: COMMITMENT_BLOCK_REASON.UNPROCESSED_REPLY,
    });
  });

  it("新しい版に置き換えられていれば選定しない", () => {
    expect(selectable({ supersededBy: "c2" })).toEqual({
      selectable: false,
      reason: COMMITMENT_BLOCK_REASON.SUPERSEDED,
    });
  });

  it("保留・撤回・失効は選定しない", () => {
    for (const status of ["HELD", "WITHDRAWN", "EXPIRED"] as const) {
      expect(selectable({ status })).toEqual({
        selectable: false,
        reason: COMMITMENT_BLOCK_REASON.NOT_ACTIVE,
      });
    }
  });

  it("期限に達していれば選定しない（期限ちょうども不可）", () => {
    expect(selectable({ now: AFTER })).toEqual({
      selectable: false,
      reason: COMMITMENT_BLOCK_REASON.DEADLINE_PASSED,
    });
  });

  it("status だけを見て判定していない（ACTIVE でも他の理由で落ちる）", () => {
    const blocked = selectable({ status: "ACTIVE", hasUnprocessedReply: true, now: AFTER });
    expect(blocked.selectable).toBe(false);
  });
});
