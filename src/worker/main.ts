/**
 * 常駐worker。担当A（ADR-003：webとworkerは別プロセス・単一DB・同じリリース単位）。
 *
 * 2026-09-21時点の状態：
 *   **ジョブ処理は未実装。** 現在はDB接続とheartbeatの保存だけを行う。
 *   期限処理、outbox送信、受信イベントの処理はDay 2以降に追加する。
 *
 * 設計（RFC-003 §2）：
 *   - 案件状態から1ステップだけ処理し、対象がなければ待機する。
 *   - 返信・期限・復旧イベントが次のジョブを起こす。
 *   - 受信イベントはモデル処理の前に永続化する（AGENTS.md）。
 */

import { randomUUID } from "node:crypto";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

const WORKER_NAME = "main";
const TICK_MS = 2_000;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL が未設定です。.env.example を .env.local へ複製してください。");
  }

  const pool = new Pool({ connectionString, max: 2 });
  const instanceId = randomUUID();
  const startedAt = new Date();
  let loopCount = 0;
  let running = true;

  const stop = (signal: string) => {
    if (!running) return;
    running = false;
    process.stdout.write(`worker: ${signal} を受信。処理中のループを終えて停止します。\n`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // 接続できなければ起動しない。黙って空回りさせない。
  await pool.query("select 1");
  process.stdout.write(`worker: 起動 instance=${instanceId}\n`);
  process.stdout.write(`worker: ジョブ処理は未実装です（heartbeatのみ）。\n`);

  while (running) {
    loopCount += 1;
    await beat(pool, { instanceId, startedAt, loopCount });

    // ここで案件から1ステップ処理する（未実装）。
    // 対象がなければ待機してループへ戻る。
    await sleep(TICK_MS, () => running);
  }

  await pool.end();
  process.stdout.write(`worker: 停止しました loops=${loopCount}\n`);
}

async function beat(
  pool: Pool,
  input: { instanceId: string; startedAt: Date; loopCount: number },
): Promise<void> {
  await pool.query(
    `insert into worker_heartbeat (worker_name, instance_id, started_at, beat_at, loop_count)
     values ($1, $2, $3, now(), $4)
     on conflict (worker_name) do update
       set instance_id = excluded.instance_id,
           started_at = excluded.started_at,
           beat_at = excluded.beat_at,
           loop_count = excluded.loop_count`,
    [WORKER_NAME, input.instanceId, input.startedAt, input.loopCount],
  );
}

/** 停止要求に素早く反応するため、短い間隔で分割して待つ。 */
async function sleep(totalMs: number, shouldContinue: () => boolean): Promise<void> {
  const step = 200;
  for (let waited = 0; waited < totalMs; waited += step) {
    if (!shouldContinue()) return;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
