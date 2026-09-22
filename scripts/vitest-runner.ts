import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

export type SpawnProcess = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdio?: "inherit" },
) => ChildProcess;

export type VitestRunResult =
  | { kind: "exit"; exitCode: number }
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "spawn-error"; message: string };

/** Vitestを子プロセスで実行し、呼出し元が終了結果とログを扱えるようにする。 */
export function runVitest(
  args: string[],
  spawnProcess: SpawnProcess = spawn,
): Promise<VitestRunResult> {
  const vitestPath = path.resolve("node_modules", "vitest", "vitest.mjs");

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: VitestRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnProcess(process.execPath, [vitestPath, ...args], {
        env: process.env,
        stdio: "inherit",
      });
    } catch (error) {
      settle({
        kind: "spawn-error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.once("error", (error: Error) => {
      settle({ kind: "spawn-error", message: error.message });
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal !== null) {
        settle({ kind: "signal", signal });
        return;
      }
      settle({ kind: "exit", exitCode: code ?? 1 });
    });
  });
}

export function exitCodeOf(result: VitestRunResult): number {
  return result.kind === "exit" ? result.exitCode : 1;
}

export function reportVitestFailure(prefix: string, result: VitestRunResult): void {
  if (result.kind === "spawn-error") {
    process.stderr.write(`${prefix} ERROR: Vitestを起動できません: ${result.message}\n`);
  } else if (result.kind === "signal") {
    process.stderr.write(`${prefix} ERROR: Vitestが${result.signal}で終了しました。\n`);
  } else if (result.exitCode !== 0) {
    process.stderr.write(`${prefix} ERROR: Vitestがexit code ${result.exitCode}で終了しました。\n`);
  }
}
