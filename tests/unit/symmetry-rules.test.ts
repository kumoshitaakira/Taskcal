/**
 * 対称性検査そのものを検査する。
 *
 * 検査が緩いと「守っていると主張しているのに守れていない」状態になり、無いより
 * 悪い。各規則について、実ファイルの内容から守るべき語を落とせば実際に失敗する
 * ことを確かめる。
 *
 * **実ファイルは書き換えない。** メモリ上で文字列を加工して判定する。テストが
 * ソースを壊すと、並行実行する他のテストを巻き込む。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDefinition } from "../../scripts/lib/extract-definition";
import { SYMMETRY_RULES, evaluateRule } from "../../scripts/lib/symmetry-rules";

const ROOT = process.cwd();

async function bodyOf(file: string, name: string): Promise<string> {
  const text = await readFile(path.join(ROOT, file), "utf8");
  const body = extractDefinition(text, name);
  expect(body, `${file} に ${name} が見つかりません`).toBeDefined();
  return body as string;
}

describe("対称性検査の規則", () => {
  it("すべての規則が、現在のコードでは満たされている", async () => {
    for (const rule of SYMMETRY_RULES) {
      for (const member of rule.members) {
        const body = await bodyOf(member.file, member.name);
        expect(evaluateRule(rule, body), `${rule.label} / ${member.name}`).toEqual({ ok: true });
      }
    }
  });

  it("守るべき語を落とすと、すべての規則が失敗する", async () => {
    for (const rule of SYMMETRY_RULES) {
      const member = rule.members[0];
      const body = await bodyOf(member.file, member.name);

      // mode が all なら1語落とすだけで失敗する。any なら全部落とす必要がある。
      const toRemove = rule.mode === "any" ? rule.mustContain : [rule.mustContain[0]];
      let broken = body;
      for (const needle of toRemove) broken = broken.split(needle).join("");

      expect(evaluateRule(rule, broken).ok, `${rule.label} が落ちない`).toBe(false);
    }
  });

  it("all の規則は、1語でも欠ければ失敗する", async () => {
    for (const rule of SYMMETRY_RULES) {
      if (rule.mode === "any" || rule.mustContain.length < 2) continue;
      const member = rule.members[0];
      const body = await bodyOf(member.file, member.name);

      for (const needle of rule.mustContain) {
        const broken = body.split(needle).join("");
        expect(evaluateRule(rule, broken).ok, `${rule.label} / ${needle} を落としても通る`).toBe(
          false,
        );
      }
    }
  });

  it("規則のラベルに、守る受入ケースまたは不変条件が書かれている", () => {
    // 何を守る検査かがコードから追えるようにする（AGENTS.md 実装手順4）。
    for (const rule of SYMMETRY_RULES) {
      expect(rule.label, rule.label).toMatch(/A\d{2}|D\d{2}|ADR-\d{3}|RFC-\d{3}/);
    }
  });
});
