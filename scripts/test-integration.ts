import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { integrationTestMode } from "./integration-test-gate";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

const mode = integrationTestMode();

if (mode === "ci-missing-database-url") {
  process.stderr.write(
    "[integration] ERROR: CIでDATABASE_URLが未設定のため、skipせず失敗します。\n",
  );
  process.exitCode = 1;
} else {
  if (mode === "local-skip") {
    process.stderr.write(
      "[integration] SKIP: ローカルでDATABASE_URLが未設定のため、統合テストを実行しません。\n",
    );
  } else {
    process.stdout.write(
      "[integration] RUN: DATABASE_URLが設定されているため、PostgreSQL統合テストを実行します。\n",
    );
  }

  const vitestPath = path.resolve("node_modules", "vitest", "vitest.mjs");
  const child = spawn(
    process.execPath,
    [vitestPath, "run", "tests/integration", ...process.argv.slice(2)],
    {
      env: process.env,
      stdio: "inherit",
    },
  );

  child.once("error", (error: Error) => {
    process.stderr.write(`[integration] ERROR: Vitestを起動できません: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (signal !== null) {
      process.stderr.write(`[integration] ERROR: Vitestが${signal}で終了しました。\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
    if (mode === "local-skip" && code === 0) {
      process.stderr.write(
        "[integration] RESULT: DATABASE_URL未設定のため、ローカルの統合テストは未実行です。\n",
      );
    } else if (mode === "local-skip") {
      process.stderr.write(
        "[integration] RESULT: ローカルの統合テストrunnerが失敗しました。未実行のまま成功扱いにはしていません。\n",
      );
    } else if (code === 0) {
      process.stdout.write("[integration] RESULT: PostgreSQL統合テストが完了しました。\n");
    }
  });
}
