/** 固定fixture → 正規化CSV保存 → 再読込。業務状態や正式版参照は変更しない。 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseMonthlyCsv } from "../src/adapters/csv/monthly-csv";
import { TaskcalError } from "../src/contracts/errors";

async function main(): Promise<void> {
  const fixture = path.resolve("fixtures/dev/month-2026-09");
  const [csv, metadata] = await Promise.all([
    readFile(path.join(fixture, "schedule.csv"), "utf8"),
    readFile(path.join(fixture, "manifest.json"), "utf8"),
  ]);
  const input = parseMonthlyCsv(csv, JSON.parse(metadata));
  const directory = path.resolve("var/csv-check", input.sourceRevision);
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, "schedule.csv");
  try {
    // 既存成果物を上書きしない。再実行は読戻して一致を確認する。
    await writeFile(output, input.normalizedCsv, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const saved = await readFile(output, "utf8");
  if (saved !== input.normalizedCsv)
    throw new TaskcalError(
      "REVISION_CONFLICT",
      "保存済みCSVが期待内容と一致しません。上書きせず停止しました。",
    );
  const readBack = parseMonthlyCsv(saved, input.manifest);
  if (readBack.sourceRevision !== input.sourceRevision)
    throw new TaskcalError("REVISION_CONFLICT", "読戻し版が一致しません。");
  process.stdout.write(
    JSON.stringify(
      {
        result: "CSV_ROUND_TRIP_VERIFIED",
        assignments: readBack.assignments.length,
        completeness: readBack.completeness,
        sourceRevision: readBack.sourceRevision,
        output,
        formallyAdopted: false,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error: unknown) => {
  // 入力原文や接続情報を含む例外は表示しない。
  process.stderr.write(
    error instanceof TaskcalError
      ? `${error.code}: ${error.message}\n`
      : "CSV確認に失敗しました。fixtureと出力先を確認してください。\n",
  );
  process.exitCode = 1;
});
