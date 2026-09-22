import { describe, expect, it } from "vitest";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import { OPERATION_MATCH } from "@/contracts/operation";
import {
  decideExternalAttempt,
  matchStoredRequest,
} from "@/adapters/db/repositories/operation-match";

describe("DB repositoryのoperationId/requestHash境界", () => {
  it("既存行が無ければ新規操作として扱う", () => {
    expect(matchStoredRequest(undefined, "a".repeat(64))).toBe(OPERATION_MATCH.NEW);
  });

  it("同じoperationIdとrequestHashはREPLAYとして既存結果を使う", () => {
    const hash = "a".repeat(64);
    expect(matchStoredRequest(hash, hash)).toBe(OPERATION_MATCH.REPLAY);
  });

  it("同じoperationIdでrequestHashが違えばOPERATION_CONFLICTを返す", () => {
    expect.assertions(2);
    try {
      matchStoredRequest("a".repeat(64), "b".repeat(64));
    } catch (error) {
      expect(error).toBeInstanceOf(TaskcalError);
      expect(error).toMatchObject({ code: ERROR_CODES.OPERATION_CONFLICT });
    }
  });

  it("外部作用前はNEWだけを開始し、残存状態は照合へ回す", () => {
    const hash = "a".repeat(64);
    expect(decideExternalAttempt("NEW", hash, hash)).toBe("START");
    expect(decideExternalAttempt("IN_FLIGHT", hash, hash)).toBe("LOOKUP_REQUIRED");
    expect(decideExternalAttempt("UNKNOWN", hash, hash)).toBe("LOOKUP_REQUIRED");
    expect(decideExternalAttempt("RECONCILE_REQUIRED", hash, hash)).toBe("LOOKUP_REQUIRED");
    expect(decideExternalAttempt("ACCEPTED", hash, hash)).toBe("REPLAY");
    expect(decideExternalAttempt("FAILED", hash, hash)).toBe("REPLAY");
  });

  it("外部作用開始の判定でも異なるhashを衝突拒否する", () => {
    expect(() => decideExternalAttempt("NEW", "a".repeat(64), "b".repeat(64))).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.OPERATION_CONFLICT }),
    );
  });
});
