/**
 * 常駐worker。担当A（ADR-003：webとworkerは別プロセス・単一DB・同じリリース単位）。
 *
 * 2026-09-22時点の状態：
 *   通知待ち（outbox）の送信、未処理の返信の解釈、期限に達した案件の停止、
 *   結果不明な通知の照合、止まった案件の復旧、通知処理中の案件の完了判定を行う。
 *   **配送に失敗した通知の再送は未実装**（attempt を含む操作IDが要る）。
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
  process.stdout.write(
    "worker: 通知待ちの送信、返信の解釈、期限の停止、結果の照合、復旧、完了判定を行います。\n",
  );
  process.stdout.write("worker: 配送に失敗した通知の再送は未実装です。\n");

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

    // A18：期限に達した案件を止める。判定と実行を分けない（detect-deadline.ts）。
    while (running && drained < DRAIN_LIMIT) {
      const outcome = await services.detectDeadline().catch((error: unknown) => {
        process.stderr.write(
          `worker: 期限の検知で例外 ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { handled: false } as const;
      });
      if (!outcome.handled) break;
      drained += 1;
      const to = outcome.result.ok ? outcome.result.to : `拒否 ${outcome.result.code}`;
      process.stdout.write(`worker: 期限停止 ${outcome.caseId} -> ${to}\n`);
    }

    // A13：結果不明で終わった通知を照合する。**再送はしない。**
    while (running && drained < DRAIN_LIMIT) {
      const outcome = await services.reconcileOutbox().catch((error: unknown) => {
        process.stderr.write(
          `worker: 送信結果の照会で例外 ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { handled: false } as const;
      });
      if (!outcome.handled) break;
      process.stdout.write(
        `worker: 送信照合 ${outcome.outboxId} -> ${outcome.finding}/${outcome.status}\n`,
      );
      // 照会できないものは動いていない。同じ項目を選び直して空回りしない。
      if (outcome.finding === "UNRESOLVED") break;
      drained += 1;
    }

    // Q11・Q12・Q13：照合待ち・要対応・停止保留の案件を進める（recover-case.ts）。
    while (running && drained < DRAIN_LIMIT) {
      const outcome = await services.recoverCase().catch((error: unknown) => {
        process.stderr.write(
          `worker: 復旧で例外 ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { handled: false } as const;
      });
      if (!outcome.handled) break;
      process.stdout.write(`worker: 復旧 ${outcome.caseId} -> ${outcome.to}\n`);
      // 戻せなかった案件は進んでいない。終端へは落とさず、次の巡回で見る。
      if (outcome.to === "WAITING") break;
      drained += 1;
    }

    // Q07：正式採用・読戻し・必要通知の受付まで済んだ案件を完了させる。
    // 通知が止まっている案件は、勤務を取り消さずに要対応へ回す（A13 / D09）。
    while (running && drained < DRAIN_LIMIT) {
      const outcome = await services.settleReporting().catch((error: unknown) => {
        process.stderr.write(
          `worker: 完了判定で例外 ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { handled: false } as const;
      });
      if (!outcome.handled) break;
      process.stdout.write(`worker: 通知処理 ${outcome.caseId} -> ${outcome.to}\n`);
      // まだ通知を待っている案件は進んでいない。同じ案件を選び直して空回りしない。
      if (outcome.to === "WAITING") break;
      drained += 1;
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
