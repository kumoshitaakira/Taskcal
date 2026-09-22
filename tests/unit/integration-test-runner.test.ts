import { execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type Environment } from "../../scripts/integration-test-gate";
import { runVitest, type SpawnProcess } from "../../scripts/vitest-runner";

const execFileAsync = promisify(execFile);

function fakeSpawn(child: ChildProcess): SpawnProcess {
  return (() => child) as unknown as SpawnProcess;
}

function cleanEnvironment(overrides: Environment = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.DATABASE_URL;
  return env;
}

describe("integration test process gate", () => {
  it("npm testはCIのDATABASE_URL欠落でVitestを起動せず失敗する", async () => {
    const env = cleanEnvironment({ CI: "true" });
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/test.ts"], {
      cwd: process.cwd(),
      env,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error: unknown) => {
        const failure = error as { code?: number | string; stderr?: string };
        return { code: Number(failure.code), stderr: failure.stderr ?? "" };
      },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("skipせず失敗します");
  });

  it("focusedなintegration commandはローカル未設定時にVitestを起動しない", async () => {
    const env = cleanEnvironment({ CI: "false", GITHUB_ACTIONS: "false" });
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/test-integration.ts"],
      { cwd: process.cwd(), env },
    );

    expect(result.stderr).toContain("[integration] SKIP");
    expect(result.stderr).toContain("未実行");
    expect(result.stdout).not.toContain("RUN");
  });

  it("focusedなintegration commandもCIのDATABASE_URL欠落で失敗する", async () => {
    const env = cleanEnvironment({ CI: "true" });
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/test-integration.ts"],
      { cwd: process.cwd(), env },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error: unknown) => {
        const failure = error as { code?: number | string; stderr?: string };
        return { code: Number(failure.code), stderr: failure.stderr ?? "" };
      },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("skipせず失敗します");
  });

  it("Vitestの非0終了コードを伝播する", async () => {
    const child = new EventEmitter() as ChildProcess;
    const pending = runVitest(["run"], fakeSpawn(child));
    child.emit("exit", 7, null);

    await expect(pending).resolves.toEqual({ kind: "exit", exitCode: 7 });
  });

  it("Vitestのsignal終了を失敗として扱う", async () => {
    const child = new EventEmitter() as ChildProcess;
    const pending = runVitest(["run"], fakeSpawn(child));
    child.emit("exit", null, "SIGTERM");

    await expect(pending).resolves.toEqual({ kind: "signal", signal: "SIGTERM" });
  });

  it("Vitestのspawn失敗を失敗結果へ変換する", async () => {
    const child = new EventEmitter() as ChildProcess;
    const pending = runVitest(["run"], fakeSpawn(child));
    child.emit("error", new Error("spawn failed"));

    await expect(pending).resolves.toEqual({ kind: "spawn-error", message: "spawn failed" });
  });
});
