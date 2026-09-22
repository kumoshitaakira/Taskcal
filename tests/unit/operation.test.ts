import { describe, expect, it } from "vitest";
import { computeRequestHash } from "@/contracts/operation";

describe("computeRequestHash", () => {
  it("キーの順序が違っても同じ内容なら同じhashになる", () => {
    const a = computeRequestHash({
      caseId: "c1",
      assignments: [{ staffId: "s1", start: "18:00" }],
    });
    const b = computeRequestHash({
      assignments: [{ start: "18:00", staffId: "s1" }],
      caseId: "c1",
    });
    expect(a).toBe(b);
  });

  it("内容が違えば別のhashになる（同じ操作IDで内容が異なる要求を検出するため）", () => {
    const a = computeRequestHash({ caseId: "c1", staffId: "s1" });
    const b = computeRequestHash({ caseId: "c1", staffId: "s2" });
    expect(a).not.toBe(b);
  });

  it("配列の順序は内容の違いとして扱う", () => {
    const a = computeRequestHash([1, 2]);
    const b = computeRequestHash([2, 1]);
    expect(a).not.toBe(b);
  });

  it("undefined のフィールドは無視する", () => {
    expect(computeRequestHash({ a: 1, b: undefined })).toBe(computeRequestHash({ a: 1 }));
  });

  it("undefined と null を区別する", () => {
    expect(computeRequestHash(undefined)).not.toBe(computeRequestHash(null));
  });

  it("Date を拒否する（展開すると別時刻が同じhashになり、D07が危険側に破れる）", () => {
    expect(() => computeRequestHash({ startAt: new Date("2026-09-21T18:00:00Z") })).toThrow();
    expect(() => computeRequestHash({ m: new Map([["a", 1]]) })).toThrow();
    expect(() => computeRequestHash({ s: new Set([1]) })).toThrow();
  });

  it("NaN・Infinity・BigInt・循環参照を拒否する", () => {
    expect(() => computeRequestHash({ n: NaN })).toThrow();
    expect(() => computeRequestHash({ n: Infinity })).toThrow();
    expect(() => computeRequestHash({ n: BigInt(1) })).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => computeRequestHash(circular)).toThrow();
  });

  it("A06の前提: 安定IDで整列した割当は、CSV行順が変わっても同じhashになる", () => {
    const a = { shiftAssignmentId: "sa-001", staffId: "s1" };
    const b = { shiftAssignmentId: "sa-002", staffId: "s2" };
    const sortById = (items: (typeof a)[]) =>
      [...items].sort((x, y) => x.shiftAssignmentId.localeCompare(y.shiftAssignmentId));

    expect(computeRequestHash({ additions: sortById([a, b]) })).toBe(
      computeRequestHash({ additions: sortById([b, a]) }),
    );
  });
});
