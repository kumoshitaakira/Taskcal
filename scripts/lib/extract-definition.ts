/**
 * ソースから定義の本体を切り出し、**コメントを除いた**コードを返す。
 *
 * `check-consistency.ts` の対称性検査が使う。切り出しや除外を誤ると、誤検出
 * （正しいのに失敗）か見逃し（欠落なのに通る）になり、検査そのものが信用できなく
 * なる。開発中に実際に次の4つを出した。いずれも回帰テストで固定している。
 *
 *   - 名前の単純検索が doc comment 内の言及を拾った
 *   - `foo(a: { ... }): T {` のインライン型の `}` で本体が切れた
 *   - 1行で閉じる定義が、次の定義まで伸びた
 *   - 文字列リテラル内の `}` で本体が切れた
 *   - 前方一致で `resolveReconcile` が `resolveReconcileStall` を掴んだ
 *
 * **コメントを落とすのが重要。** 落とさないと、戻り値型から `"CONFLICT"` を
 * 削除しても doc comment に残る限り検査が通ってしまう（実際にそうなっていた）。
 *
 * 一方で**文字列の中身は残す**。TypeScriptの文字列リテラル型（`| "CONFLICT"`）が
 * 検査対象になるため。ブレースとセミコロンだけは、文字列の中にあるものを数えない。
 */

/** 識別子として使える文字。名前一致の境界判定に使う。 */
const IDENT = /[A-Za-z0-9_$]/;

interface ScanState {
  depth: number;
  sawBrace: boolean;
  inLineComment: boolean;
  inBlockComment: boolean;
  /** 文字列・テンプレートの開始引用符。中にいなければ undefined。 */
  quote?: string;
}

export function extractDefinition(text: string, name: string): string | undefined {
  const lines = text.split("\n");
  const startLine = lines.findIndex((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(name)) return false;
    // 前方一致で別の定義を掴まないよう、直後が識別子の続きでないことを確かめる。
    const next = trimmed.charAt(name.length);
    return next === "" || !IDENT.test(next);
  });
  if (startLine === -1) return undefined;

  const state: ScanState = {
    depth: 0,
    sawBrace: false,
    inLineComment: false,
    inBlockComment: false,
  };
  const code: string[] = [];

  for (let i = startLine; i < lines.length; i += 1) {
    const { kept, ended } = scanLine(lines[i], state);
    code.push(kept);
    if (ended) break;
    state.inLineComment = false;
  }
  return code.join("\n");
}

/** 1行を走査し、コードだけを残す。定義がこの行で終わるかも返す。 */
function scanLine(line: string, state: ScanState): { kept: string; ended: boolean } {
  let kept = "";
  let ended = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (state.inLineComment) continue;
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (state.quote !== undefined) {
      // 中身は残すが、区切り文字としては数えない。
      kept += ch;
      if (ch === "\\") {
        // エスケープは次の1文字も文字列の一部。
        if (next !== undefined) kept += next;
        i += 1;
      } else if (ch === state.quote) {
        state.quote = undefined;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      state.inLineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      state.quote = ch;
      kept += ch;
      continue;
    }

    kept += ch;

    if (ch === "{") {
      state.depth += 1;
      state.sawBrace = true;
      continue;
    }
    if (ch === "}") {
      state.depth -= 1;
      if (state.depth === 0) {
        // この `}` の後ろに `;` と空白しか無ければ、定義の終わり。
        // `}): Promise<...>` のようにまだ続く場合は終わりにしない。
        const rest = line.slice(i + 1).trim();
        if (rest === "" || rest === ";") {
          ended = true;
          break;
        }
      }
      continue;
    }
    // 本体を持たない宣言（signature）は、対応が取れた `;` で終わり。
    if (ch === ";" && state.depth === 0) {
      ended = true;
      break;
    }
  }
  return { kept, ended };
}
