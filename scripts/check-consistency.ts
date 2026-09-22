/**
 * コードと文書、コード同士の食い違いを検出する。
 *
 * 背景：環境変数名や既定値を変えたときに、それを説明している文書の更新が
 * 繰り返し漏れた。担当者が古い記載どおりに運用すると、想定より多くの有料
 * 呼出しを許可する等の実害が出る。人の注意ではなく検査で止める。
 *
 * 検査するもの：
 *   1. env schema と `.env.example` の項目が一致すること（両方向）
 *   2. 文書が参照する環境変数名が、実在すること
 *   3. 既定値を持つ定数の値が、それを説明する文書に現れること
 *   4. 廃止した説明が文書に残っていないこと
 *   5. 検査のために作った関数が、実際に呼ばれていること
 *   6. 同種の操作群が、同じ規則を持つこと（対称性）
 *   7. スキルがCodexとClaude Codeの両方から使える状態にあること
 *
 * 使い方: npm run check:consistency
 */

import { readFile, readdir } from "node:fs/promises";
import { extractDefinition } from "./lib/extract-definition";
import { SYMMETRY_RULES, evaluateRule } from "./lib/symmetry-rules";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

/** 既定値を持つ定数と、その値を説明している文書。 */
const DOCUMENTED_DEFAULTS: {
  readonly constName: string;
  readonly source: string;
  readonly documentedIn: readonly string[];
}[] = [
  {
    constName: "DEFAULT_CASE_CALL_LIMIT",
    source: "src/adapters/orca/budget.ts",
    documentedIn: [
      ".env.example",
      "README.md",
      "src/adapters/orca/README.md",
      "docs/OPEN-QUESTIONS.md",
    ],
  },
  {
    constName: "MAX_REPLY_CHARS",
    source: "src/config/mvp-policy.ts",
    documentedIn: [".env.example", "docs/OPEN-QUESTIONS.md"],
  },
  {
    constName: "MAX_OUTPUT_TOKENS",
    source: "src/config/mvp-policy.ts",
    documentedIn: [".env.example", "docs/OPEN-QUESTIONS.md"],
  },
  {
    constName: "MAX_STAFF",
    source: "src/config/mvp-policy.ts",
    documentedIn: ["docs/OPEN-QUESTIONS.md"],
  },
];

/**
 * 廃止した説明。文書に残っていたら失敗させる。
 *
 * 数値や名前の一致だけでは、方式を変えたときの説明の陳腐化を検出できない。
 * 実際に「1文字=2トークン」という古い上限の説明が決定記録に残り、それを信じて
 * 再実装すると予約不足を作り直すところだった。
 */
const RETIRED_WORDING: { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /1文字\s*=\s*2トークン|1文字あたり2トークン/,
    why: "トークン上限はUTF-8のbyte長基準へ変更済み（estimateInputTokens）",
  },
  {
    pattern: /ORCA_ESTIMATED_MICRO_USD_PER_CALL/,
    why: "固定額の見積りは廃止し、単価と上限から要求ごとに算出する",
  },
];

/**
 * 検査のために作ったのに、どこからも呼ばれていない関数を見つける。
 *
 * `validateEvidenceSpans` を作ってテストからしか呼んでおらず、本番経路に
 * 通していなかった。「作ったが繋いでいない」は繰り返している型なので、
 * 機械的に止める。
 */
const MUST_BE_CALLED: { readonly name: string; readonly from: readonly string[] }[] = [
  { name: "validateEvidenceSpans", from: ["src/adapters/orca/orca-client.ts"] },
  { name: "maskContactInfo", from: ["src/adapters/orca/orca-client.ts"] },
  { name: "assertWithinInputBounds", from: ["src/adapters/orca/orca-client.ts"] },
  { name: "estimateCallCost", from: ["src/adapters/orca/orca-client.ts"] },
  { name: "compareMigrations", from: ["src/application/runtime-status.ts"] },
  // 対称性の判定本体。ここが呼ばれていないと、テストが見ている evaluateRule と
  // 実際に走る判定が別物になる。
  { name: "evaluateRule", from: ["scripts/check-consistency.ts"] },
  // 作ったが繋いでいない状態を止める。検査を足しても呼ばなければ効かない。
  {
    name: "assertOutsideTransaction",
    from: ["src/application/interpret-reply.ts", "src/application/send-outbox.ts"],
  },
  { name: "isAllowedOutreachTransition", from: ["src/adapters/db/outreach-repository.ts"] },
  { name: "isAllowedCommitmentTransition", from: ["src/adapters/db/commitment-repository.ts"] },
  { name: "resolveOutreachAfterSend", from: ["src/application/send-outbox.ts"] },
  { name: "resolveOutreachAfterInbound", from: ["src/application/receive-inbound-event.ts"] },
  {
    name: "computeRequestHash",
    // 外部作用の内容ハッシュを作る経路。ここを落とすと、同じ操作IDで内容の違う
    // 要求を REPLAY として握り潰す（ADR-006 / D07）。
    from: ["src/application/start-outreach.ts", "src/application/adopt-plan.ts"],
  },
  {
    name: "isSelectableCommitment",
    // D08：選定の時点と、正式採用の直前の両方で通す。片方だけでは、準備中に
    // 届いた訂正を見落とす（A05）。
    from: ["src/application/case-view.ts", "src/application/adopt-plan.ts"],
  },
  // 定義して呼ばない状態を止める。円換算は表示経路だけが呼ぶ（RFC-004 §7）。
  { name: "toJpyForDisplay", from: ["src/application/model-usage-view.ts"] },
  { name: "resolveReconcile", from: ["src/application/adopt-plan.ts"] },
  { name: "resolveCaseReconcile", from: ["src/application/adopt-plan.ts"] },
  // Q13／ADR-022：`PREPARING` 中の停止は行き先が変わる。期限検知だけで引き継がない。
  { name: "resolvePreparingStop", from: ["src/application/adopt-plan.ts"] },
  {
    name: "isAllowedScheduleUpdateTransition",
    from: ["src/adapters/db/schedule-update-repository.ts"],
  },
];

/** 文書として走査する範囲。 */
const DOCS_TO_SCAN = [
  ".env.example",
  "README.md",
  "docs/OPEN-QUESTIONS.md",
  "src/adapters/orca/README.md",
  "src/config/README.md",
  "src/contracts/README.md",
];

/** 環境変数名を参照する文書。 */
const DOCS_REFERENCING_ENV = [
  ".env.example",
  "README.md",
  "docs/OPEN-QUESTIONS.md",
  "src/adapters/orca/README.md",
  "src/config/README.md",
];

const problems: string[] = [];

async function read(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), "utf8");
}

/** `NAME: ...` の形で宣言された環境変数名を取り出す。 */
function envNamesFromSchema(source: string): Set<string> {
  const body = /serverEnvSchema\s*=\s*z\.object\(\{([\s\S]*?)\n\}\);/.exec(source)?.[1] ?? "";
  return new Set([...body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]));
}

/** 文書中に現れる環境変数らしき名前を取り出す。 */
function envNamesInText(text: string): Set<string> {
  return new Set([...text.matchAll(/\b(ORCA_[A-Z0-9_]+|DATABASE_URL)\b/g)].map((m) => m[1]));
}

/** `export const NAME = 1_000;` から値を取り出す。 */
function numericConst(source: string, name: string): number | undefined {
  const raw = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*([0-9_]+)`).exec(source)?.[1];
  return raw === undefined ? undefined : Number(raw.replace(/_/g, ""));
}

/** 桁区切りの書き方が違っても見つける。 */
function mentionsNumber(text: string, value: number): boolean {
  const plain = String(value);
  const variants = [
    plain,
    plain.replace(/\B(?=(\d{3})+(?!\d))/g, "_"),
    plain.replace(/\B(?=(\d{3})+(?!\d))/g, ","),
  ];
  return variants.some((v) => new RegExp(`\\b${v}\\b`).test(text));
}

async function checkEnvExampleMatchesSchema(): Promise<void> {
  const schemaNames = envNamesFromSchema(await read("src/config/env-schema.ts"));
  const exampleText = await read(".env.example");
  // 値の代入行だけを見る（コメント内の説明は対象にしない）。
  const exampleNames = new Set([...exampleText.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

  for (const name of schemaNames) {
    if (!exampleNames.has(name)) {
      problems.push(`.env.example に ${name} の行がありません（env-schema.ts にはあります）`);
    }
  }
  for (const name of exampleNames) {
    if (!schemaNames.has(name)) {
      problems.push(`.env.example の ${name} は env-schema.ts に存在しません（改名・削除の残り）`);
    }
  }
}

async function checkDocsReferenceRealEnvNames(): Promise<void> {
  const schemaNames = envNamesFromSchema(await read("src/config/env-schema.ts"));
  for (const doc of DOCS_REFERENCING_ENV) {
    const text = await read(doc);
    for (const name of envNamesInText(text)) {
      if (!schemaNames.has(name)) {
        problems.push(`${doc} が参照する ${name} は env-schema.ts に存在しません`);
      }
    }
  }
}

async function checkDocumentedDefaults(): Promise<void> {
  for (const entry of DOCUMENTED_DEFAULTS) {
    const value = numericConst(await read(entry.source), entry.constName);
    if (value === undefined) {
      problems.push(`${entry.source} に ${entry.constName} の定義が見つかりません`);
      continue;
    }
    for (const doc of entry.documentedIn) {
      if (!mentionsNumber(await read(doc), value)) {
        problems.push(
          `${doc} に ${entry.constName} の現在値 ${value} が出てきません` +
            `（既定値を変えたら、それを説明している文書も直す）`,
        );
      }
    }
  }
}

async function checkRetiredWording(): Promise<void> {
  for (const doc of DOCS_TO_SCAN) {
    const text = await read(doc);
    for (const { pattern, why } of RETIRED_WORDING) {
      if (pattern.test(text)) {
        problems.push(`${doc} に廃止した説明が残っています（${why}）`);
      }
    }
  }
}

/**
 * スキルが両ツールから使えるか。
 *
 * `.agents/skills/` が正本で、`.claude/skills/` のシンボリックリンクから
 * Claude Codeへ公開する（CLAUDE.md）。`docs/AI-DEVELOPMENT.md` のスキル表が
 * 両ツールの呼び出し名を対にして示す唯一の場所。片方だけ足すと、もう一方の
 * ツールから使えないまま気付かない。
 */
async function checkSkillParity(): Promise<void> {
  const entries = await readdir(path.join(ROOT, ".agents", "skills"), { withFileTypes: true });
  const aiDevelopment = await read("docs/AI-DEVELOPMENT.md");

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    try {
      await read(path.join(".agents", "skills", name, "SKILL.md"));
    } catch {
      problems.push(`.agents/skills/${name}/SKILL.md がありません`);
      continue;
    }
    try {
      // リンク切れならここで失敗する。
      await read(path.join(".claude", "skills", name, "SKILL.md"));
    } catch {
      problems.push(`.claude/skills/${name} からSKILL.mdを読めません（Claude Codeから使えない）`);
    }
    // 表の行として、両ツールの呼び出し名が対で並んでいることを確かめる。
    // ファイル内のどこかに名前があるだけでは足りない（依頼例にも出てくる）。
    const hasTableRow = aiDevelopment
      .split("\n")
      .some(
        (line) =>
          line.startsWith("|") &&
          line.includes(`\`${name}\``) &&
          line.includes(`\`$${name}\``) &&
          line.includes(`\`/${name}\``),
      );
    if (!hasTableRow) {
      problems.push(
        `docs/AI-DEVELOPMENT.md のスキル表に ${name} の行がありません` +
          `（Codexの $名 とClaude Codeの /名 を対で示す唯一の場所）`,
      );
    }
  }
}

async function checkSymmetry(): Promise<void> {
  for (const rule of SYMMETRY_RULES) {
    for (const member of rule.members) {
      // 1ファイルの欠落で以降の検査を止めない。他の検査と同じく problems へ積む。
      let source: string;
      try {
        source = await read(member.file);
      } catch {
        problems.push(`${member.file} を読めません（対称性: ${rule.label}）`);
        continue;
      }
      const body = extractDefinition(source, member.name);
      if (body === undefined) {
        problems.push(`${member.file} に ${member.name} がありません（対称性: ${rule.label}）`);
        continue;
      }
      // 判定は evaluateRule に集約する。ここへ複製すると、テストが見ているのは
      // evaluateRule だけになり、実際に走る判定が無検査になる。
      const verdict = evaluateRule(rule, body);
      if (!verdict.ok) {
        problems.push(
          `${member.file} の ${member.name} に ${verdict.missing.join(" / ")} がありません` +
            `（対称性: ${rule.label}）`,
        );
      }
    }
  }
}

async function checkFunctionsAreCalled(): Promise<void> {
  for (const entry of MUST_BE_CALLED) {
    for (const caller of entry.from) {
      const text = await read(caller);
      // import 行を除いた本文で、呼出しの形になっているかを見る。
      const body = text
        .split("\n")
        .filter((line) => !/^\s*(import|export)\s/.test(line))
        .join("\n");
      if (!new RegExp(`\\b${entry.name}\\s*\\(`).test(body)) {
        problems.push(
          `${caller} が ${entry.name} を呼んでいません` +
            `（検査のために作った関数を本番経路へ通していない）`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  await checkEnvExampleMatchesSchema();
  await checkRetiredWording();
  await checkFunctionsAreCalled();
  await checkSymmetry();
  await checkSkillParity();
  await checkDocsReferenceRealEnvNames();
  await checkDocumentedDefaults();

  if (problems.length > 0) {
    process.stderr.write("食い違いがあります:\n");
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("check:consistency: 食い違いはありません\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
