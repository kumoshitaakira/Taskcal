import { describe, expect, it } from "vitest";
import { extractDefinition } from "../../scripts/lib/extract-definition";

/**
 * 対称性検査は、この切り出しの上に成り立っている。範囲を誤ると検査が
 * 信用できなくなるため、書き方ごとの挙動を固定する。
 */
describe("定義の切り出し（check:consistency の対称性検査）", () => {
  it("1行の署名を取る", () => {
    const src = "interface X {\n  foo(a: string): Promise<void>;\n}";
    expect(extractDefinition(src, "foo")).toBe("  foo(a: string): Promise<void>;");
  });

  it("インライン型を含む複数行の署名を、戻り値まで取る", () => {
    // ここで `}` で切ると、戻り値の型に書かれた規則を見落とす。
    const src = [
      "interface X {",
      "  foo(ref: {",
      "    a: string;",
      "    b: string;",
      '  }): Promise<Y | "CONFLICT">;',
      "}",
    ].join("\n");
    const out = extractDefinition(src, "foo");
    expect(out).toContain("b: string");
    expect(out).toContain("CONFLICT");
  });

  it("インライン型を持つ関数の本体を取る", () => {
    // `}): R {` の `}` で切ると本体を見落とす。
    const src = ["export function f(i: {", "  a: string;", "}): R {", "  return MARKER;", "}"].join(
      "\n",
    );
    expect(extractDefinition(src, "export function f")).toContain("MARKER");
  });

  it("interface の全フィールドを取る", () => {
    const src = "export interface I {\n  a: string;\n  b: MARKER;\n}";
    expect(extractDefinition(src, "export interface I")).toContain("MARKER");
  });

  it("字下げされたクラスメソッドの本体を、入れ子ごと取る", () => {
    const src = [
      "class C {",
      "  async m(): Promise<void> {",
      "    if (x) {",
      "      inner();",
      "    }",
      "    MARKER();",
      "  }",
      "}",
    ].join("\n");
    const out = extractDefinition(src, "async m");
    expect(out).toContain("inner()");
    expect(out).toContain("MARKER()");
  });

  it("doc comment 内の言及ではなく、定義を取る", () => {
    // 名前の単純検索だと、コメント側を拾って本体を見落とす。
    const src = [
      "/**",
      " * foo は…",
      " */",
      "interface X {",
      "  foo(a: { c: MARKER }): P;",
      "}",
    ].join("\n");
    const out = extractDefinition(src, "foo");
    expect(out).toContain("MARKER");
    expect(out?.startsWith("/**")).toBe(false);
  });

  it("1行で閉じる定義が、次の定義まで伸びない", () => {
    const src = [
      "export interface A { readonly k: K }",
      "",
      "export interface B {",
      "  readonly LEAKED: string;",
      "}",
    ].join("\n");
    const out = extractDefinition(src, "export interface A");
    expect(out).not.toContain("LEAKED");
  });

  it("文字列リテラル内のブレースで切れない", () => {
    const src = [
      "class C {",
      "  async m() {",
      '    throw new Error("形式は } で終わる");',
      "    MARKER();",
      "  }",
      "}",
    ].join("\n");
    expect(extractDefinition(src, "async m")).toContain("MARKER()");
  });

  it("前方一致で別の定義を掴まない", () => {
    const src = [
      "export function resolveReconcileStall() {",
      "  return WRONG;",
      "}",
      "export function resolveReconcile() {",
      "  return RIGHT;",
      "}",
    ].join("\n");
    const out = extractDefinition(src, "export function resolveReconcile");
    expect(out).toContain("RIGHT");
    expect(out).not.toContain("WRONG");
  });

  it("コメントを落とす（コメント内の語で検査が通らないように）", () => {
    // 戻り値型から "CONFLICT" を消してもコメントに残る限り通る、という
    // 見逃しが実際に起きた。
    const src = [
      "interface X {",
      '  /** `"CONFLICT"` を返す。 */',
      '  foo(): Promise<Y | "KEPT">;',
      "}",
    ].join("\n");
    const out = extractDefinition(src, "foo");
    expect(out).toContain("KEPT");
    expect(out).not.toContain("CONFLICT");
  });

  it("文字列リテラル型は残す（検査対象になるため）", () => {
    const src = 'interface X {\n  foo(): Promise<Y | "CONFLICT">;\n}';
    expect(extractDefinition(src, "foo")).toContain("CONFLICT");
  });

  it("複数行のunion戻り値型で本体が切れない", () => {
    // `| { ... }` は1行で開いて閉じるので、素朴に見ると定義の終わりに見える。
    // ここで切ると本体が丸ごと落ち、対称性検査は「語が無い」と誤って落ちるか、
    // 語を消しても気付かない側へ倒れる。
    const src = [
      "export function f(): Promise<",
      "  | { readonly ok: true; readonly n: number }",
      "  | { readonly ok: false }",
      "> {",
      "  return MARKER();",
      "}",
    ].join("\n");
    const out = extractDefinition(src, "export function f");
    expect(out).toContain("MARKER()");
  });

  it("名前が無ければ undefined を返す", () => {
    expect(extractDefinition("interface X {}", "notThere")).toBeUndefined();
  });
});
