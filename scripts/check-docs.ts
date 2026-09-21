/**
 * コードと文書の食い違いを検出する。
 *
 * 背景：環境変数名や既定値を変えたときに、それを説明している文書の更新が
 * 繰り返し漏れた。担当者が古い記載どおりに運用すると、想定より多くの有料
 * 呼出しを許可する等の実害が出る。人の注意ではなく検査で止める。
 *
 * 検査するもの：
 *   1. env schema と `.env.example` の項目が一致すること（両方向）
 *   2. 文書が参照する環境変数名が、実在すること
 *   3. 既定値を持つ定数の値が、それを説明する文書に現れること
 *
 * 使い方: npm run check:docs
 */

import { readFile } from "node:fs/promises";
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

async function main(): Promise<void> {
  await checkEnvExampleMatchesSchema();
  await checkDocsReferenceRealEnvNames();
  await checkDocumentedDefaults();

  if (problems.length > 0) {
    process.stderr.write("コードと文書の食い違いがあります:\n");
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("check:docs: コードと文書は一致しています\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
