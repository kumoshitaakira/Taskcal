/**
 * 通知コードの照合（ADR-023）。
 *
 * URLから任意の表示を作らせないための照合なので、prototype のキーが通らないことを
 * 固定する。`value in TEXT` にすると `toString` が「既知のコード」として通り、
 * 緑の成功バッジと `[object Object]` が出る。
 */

import { describe, expect, it } from "vitest";
import { NOTICE, Notice } from "@/app/_components/notice";

/** 描画せずに判定だけを見る。返り値が null なら未知のコードとして無視している。 */
function rendered(code: string | undefined, count?: string) {
  return Notice({ code, count });
}

describe("通知コードの照合", () => {
  it("決めたコードは表示する", () => {
    for (const code of Object.values(NOTICE)) {
      expect(rendered(code), code).not.toBeNull();
    }
  });

  it("prototype のキーを既知のコードとして通さない", () => {
    for (const key of ["toString", "valueOf", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(rendered(key), key).toBeNull();
    }
  });

  it("未知の文字列とコード無しは何も出さない", () => {
    expect(rendered(undefined)).toBeNull();
    expect(rendered("")).toBeNull();
    expect(rendered("ARBITRARY_TEXT")).toBeNull();
  });

  it("件数は数値だけを受け取る（URLから任意の文字列を出させない）", () => {
    const withText = rendered(NOTICE.OUTREACH_STARTED, "<script>");
    expect(JSON.stringify(withText)).not.toContain("script");
  });

  it("`in` 演算子で照合すると prototype が通ることを固定する（この検査が効く根拠）", () => {
    const table: Record<string, unknown> = { CASE_CREATED: () => "" };
    // 実装が `value in TEXT` だったときの挙動。落ちる検査であることを示す。
    expect("toString" in table).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(table, "toString")).toBe(false);
  });
});
