import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { integrationTestMode } from "./integration-test-gate";
import { exitCodeOf, reportVitestFailure, runVitest } from "./vitest-runner";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

async function main(): Promise<number> {
  const mode = integrationTestMode();
  if (mode === "ci-missing-database-url") {
    process.stderr.write(
      "[integration] ERROR: CIでDATABASE_URLが未設定のため、skipせず失敗します。\n",
    );
    return 1;
  }

  if (mode === "local-skip") {
    process.stderr.write(
      "[integration] SKIP: ローカルでDATABASE_URLが未設定のため、integration本体はskipします。\n",
    );
  } else {
    process.stdout.write(
      "[integration] RUN: DATABASE_URLが設定されているため、PostgreSQL統合テストを実行します。\n",
    );
  }

  const result = await runVitest(["run", ...process.argv.slice(2)]);
  if (result.kind !== "exit" || result.exitCode !== 0) {
    reportVitestFailure("[test]", result);
  } else if (mode === "local-skip") {
    process.stderr.write(
      "[integration] RESULT: unitは実行済み、DATABASE_URL未設定のためintegration本体は未実行です。\n",
    );
  } else {
    process.stdout.write("[integration] RESULT: unit + PostgreSQL統合テストが完了しました。\n");
  }
  return exitCodeOf(result);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[test] ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
