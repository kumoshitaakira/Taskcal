import { describe, expect, it } from "vitest";
import { TaskcalError } from "@/contracts/errors";
import {
  ALLOWED_OUTREACH_TRANSITIONS,
  DELIVERY_NOT_SENT,
  DELIVERY_STATES,
  OUTREACH_STATES,
  SENDER_IDENTITY,
  TERMINAL_OUTREACH_STATES,
  isAllowedOutreachTransition,
  resolveOutreachAfterInbound,
  resolveOutreachAfterSend,
  type OutreachState,
} from "@/contracts/outreach-state";

describe("打診の状態遷移（RFC-011 §2）", () => {
  it("全ての状態が遷移表に載っている", () => {
    for (const state of OUTREACH_STATES) {
      expect(ALLOWED_OUTREACH_TRANSITIONS[state]).toBeDefined();
    }
  });

  it("終了した打診からは動かさない", () => {
    for (const terminal of TERMINAL_OUTREACH_STATES) {
      expect(ALLOWED_OUTREACH_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("回答済みから再び回答待ちへ戻せる（訂正・撤回: RFC-011 §4）", () => {
    expect(isAllowedOutreachTransition("ANSWERED", "AWAITING_REPLY")).toBe(true);
    expect(isAllowedOutreachTransition("ANSWERED", "CLARIFYING")).toBe(true);
  });

  it("送信待ちから直接回答済みへ飛ばさない", () => {
    expect(isAllowedOutreachTransition("PENDING_SEND", "ANSWERED")).toBe(false);
    expect(isAllowedOutreachTransition("PENDING_SEND", "AWAITING_REPLY")).toBe(false);
  });

  it("未知の状態は遷移禁止ではなく入力エラーにする", () => {
    expect(() =>
      isAllowedOutreachTransition("UNKNOWN_STATUS" as OutreachState, "SENT"),
    ).toThrowError(TaskcalError);
  });
});

describe("送信結果の反映（A11 / RFC-011 §6）", () => {
  it("受け付けられた場合だけ送信済みへ進む", () => {
    expect(resolveOutreachAfterSend({ current: "PENDING_SEND", outcome: "ACCEPTED" })).toBe("SENT");
  });

  it("失敗・結果不明・未送信では送信待ちのまま据え置く", () => {
    for (const outcome of ["QUEUED", "FAILED", "UNKNOWN", DELIVERY_NOT_SENT] as const) {
      expect(resolveOutreachAfterSend({ current: "PENDING_SEND", outcome })).toBe("PENDING_SEND");
    }
  });

  it("配送状態をそのまま打診状態へ写していない（全ての配送状態で遷移先が有効）", () => {
    for (const outcome of [...DELIVERY_STATES, DELIVERY_NOT_SENT]) {
      const next = resolveOutreachAfterSend({ current: "PENDING_SEND", outcome });
      expect(OUTREACH_STATES).toContain(next);
    }
  });

  it("失効・終了した打診は送信結果で動かさない", () => {
    expect(resolveOutreachAfterSend({ current: "EXPIRED", outcome: "ACCEPTED" })).toBe("EXPIRED");
    expect(resolveOutreachAfterSend({ current: "CLOSED", outcome: "ACCEPTED" })).toBe("CLOSED");
  });
});

describe("受信の反映（A15 / RFC-011 §6）", () => {
  it("宛先本人と確認できた本文のある受信だけ回答済みにする", () => {
    expect(
      resolveOutreachAfterInbound({
        current: "AWAITING_REPLY",
        senderIdentity: SENDER_IDENTITY.VERIFIED_OUTREACH_TARGET,
        hasBody: true,
      }),
    ).toBe("ANSWERED");
  });

  it("本人と確認できない受信では状態を動かさない（記録はする）", () => {
    for (const senderIdentity of [SENDER_IDENTITY.UNMATCHED, SENDER_IDENTITY.UNVERIFIABLE]) {
      expect(
        resolveOutreachAfterInbound({ current: "AWAITING_REPLY", senderIdentity, hasBody: true }),
      ).toBe("AWAITING_REPLY");
    }
  });

  it("本文の無いイベントを返信として扱わない", () => {
    expect(
      resolveOutreachAfterInbound({
        current: "AWAITING_REPLY",
        senderIdentity: SENDER_IDENTITY.VERIFIED_OUTREACH_TARGET,
        hasBody: false,
      }),
    ).toBe("AWAITING_REPLY");
  });

  it("未送信・失効・終了の打診への返信では状態を動かさない", () => {
    for (const current of ["PENDING_SEND", "EXPIRED", "CLOSED"] as const) {
      expect(
        resolveOutreachAfterInbound({
          current,
          senderIdentity: SENDER_IDENTITY.VERIFIED_OUTREACH_TARGET,
          hasBody: true,
        }),
      ).toBe(current);
    }
  });
});
