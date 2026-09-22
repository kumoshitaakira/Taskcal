/**
 * 常駐worker。担当A（ADR-003：webとworkerは別プロセス・単一DB・同じリリース単位）。
 *
 * 2026-09-22時点の状態：
 *   通知待ち（outbox）の送信と、未処理の返信の解釈を処理する。
 *   **期限の検知・停止・復旧は未実装。**
 *   解釈はOrcaRouterが未設定なら何もしない（模擬結果を返さない）。
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
/** 1ループで処理する通知待ちの上限。無制限にすると停止要求へ反応できない。 */
const DRAIN_LIMIT = 20;

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
  process.stdout.write("worker: 通知待ちの送信と、未処理の返信の解釈を処理します。\n");
  process.stdout.write("worker: 期限の検知・停止・復旧は未実装です。\n");

  const { buildAppServices } = await import("@/application/deps");
  const services = buildAppServices();

  while (running) {
    loopCount += 1;
    await beat(pool, { instanceId, startedAt, loopCount });

    // 送信できるものがある間は続けて処理し、無くなったら待機する。
    // 1ループで1件だけにすると、8人への打診に16秒かかる。
    let drained = 0;
    while (running && drained < DRAIN_LIMIT) {
      const outcome = await services.sendOutbox().catch((error: unknown) => {
        // 1件の失敗でworkerを止めない。次のループで拾い直す。
        process.stderr.write(
          `worker: 送信で例外 ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { handled: false } as const;
      });
      if (!outcome.handled) break;
      drained += 1;
      process.stdout.write(`worker: 送信 ${outcome.outboxId} -> ${outcome.status}\n`);
    }

    // 未処理の返信を解釈する。モデルが未設定なら何もしない（模擬結果を返さない）。
    while (running && drained < DRAIN_LIMIT) {
      const outcome = await services.interpretPending().catch((error: unknown) => {
        process.stderr.write(
          `worker: 解釈で例外 ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { handled: false, reason: "NONE" } as const;
      });
      if (!outcome.handled) break;
      drained += 1;
      // 保留は進捗であって成功ではない。何が止めたかを出す。
      const detail = "blocked" in outcome ? `保留 ${outcome.blocked}` : outcome.applied;
      process.stdout.write(`worker: 解釈 ${outcome.inboundEventId} -> ${detail}\n`);
    }

    if (drained === 0) await sleep(TICK_MS, () => running);
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
