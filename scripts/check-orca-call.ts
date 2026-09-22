/**
 * OrcaRouterへ**実際に1回だけ**呼び出して、接続と応答形式を確かめる。
 *
 * `check:orca` は設定の点検だけで、実呼出しをしない。こちらは**課金され得る**
 * 呼出しを行う。手元で明示的に実行するもので、CIからは動かさない（ADR-007）。
 *
 * 使い方: npm run check:orca:call
 *
 * 確かめること（RFC-004 §7・§8、ADR-007）：
 *   - `chat/completions` の要求形式がこの接続で通るか（OpenAI互換の仮定）
 *   - `response_format: json_schema` が効くか。効かない場合、プロンプト側の
 *     schema指示だけで `modelReplyOutputSchema` を通る出力になるか
 *   - 応答から実使用モデル・トークン数を取れるか（取れなければ UNKNOWN）
 *   - 予約と精算が対で残るか。**失敗しても費用を0にしない**
 *
 * **1回で終える。** 失敗しても自動で再試行しない。結果不明（`UnknownOutcomeError`）は
 * 予約額を `UNKNOWN_CHARGE` として残す仕様なので、再実行のたびに予約が積み上がる。
 *
 * 出力に秘密値・返信原文を出さない（ADR-008）。返信本文はマスク後の長さだけを示す。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

interface Fixture {
  readonly id: string;
  readonly offer: {
    readonly date: string;
    readonly roleCode: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly deadlineAt: string;
  };
  readonly anonymousStaffRef: string;
  readonly afterCommit: boolean;
  readonly replyText: string;
  readonly expect: { readonly intent: string };
}

/** 案件・実行の識別子。実呼出しの記録が架空データと混ざらないよう分けておく。 */
const RUN_ID = `check-orca-call:${new Date().toISOString().slice(0, 10)}`;

async function main(): Promise<void> {
  const fixturePath = path.join(process.cwd(), "fixtures/eval/reply-accept-full.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;

  const { getServerEnv } = await import("@/config/env");
  const env = getServerEnv();
  if (!env.ORCA_BASE_URL || !env.ORCA_API_KEY || !env.ORCA_MODEL) {
    process.stderr.write(
      "OrcaRouterの接続情報（ORCA_BASE_URL / ORCA_API_KEY / ORCA_MODEL）が未設定です。\n" +
        "npm run check:orca で不足を確認してください。実呼出しは行いませんでした。\n",
    );
    process.exitCode = 1;
    return;
  }

  const { createModelGateway } = await import("@/adapters/orca");
  const { createPgBudgetLedger } = await import("@/adapters/db/budget-ledger");
  const { createPgModelCallStore } = await import("@/adapters/db/model-call-store");
  const { computeRequestHash } = await import("@/contracts/operation");
  const { modelReplyOutputSchema } = await import("@/contracts/model-output");
  const { PROMPT_VERSION } = await import("@/application/interpret-reply");
  const { closePool } = await import("@/adapters/db/pool");

  const gateway = createModelGateway({
    ledger: createPgBudgetLedger(),
    callStore: createPgModelCallStore(),
  });
  if (!gateway.isConfigured()) {
    // 接続情報があっても金額上限・単価が無ければ有料呼出しを開始しない（RFC-004 §7）。
    process.stderr.write(
      "金額上限または単価が未設定のため、実呼出しを開始しません（RFC-004 §7 / ADR-007）。\n" +
        "npm run check:orca で不足を確認してください。\n",
    );
    process.exitCode = 1;
    await closePool();
    return;
  }

  // 案件行は作らない。model_call.case_id は uuid 型なので、この確認用の
  // 使い捨てIDを使う（外部キーは張っていない）。
  const caseId = randomUUID();
  const request = {
    // 再実行のたびに新しいIDにする。同じIDだと保存済み結果の再生になり、
    // **実呼出しを確かめたことにならない**（それはそれで正しい動作）。
    requestId: `check-orca-call:${randomUUID()}`,
    requestHash: computeRequestHash({ fixture: fixture.id, replyText: fixture.replyText }),
    step: "INTERPRET_REPLY" as const,
    attempt: 0,
    caseId,
    runId: RUN_ID,
    anonymousStaffRef: fixture.anonymousStaffRef,
    offer: fixture.offer,
    afterCommit: fixture.afterCommit,
    replyText: fixture.replyText,
    promptVersion: PROMPT_VERSION,
  };

  process.stdout.write(`OrcaRouterへ1回だけ実呼出しします（fixture: ${fixture.id}）\n`);
  process.stdout.write(`  model(要求) : ${env.ORCA_MODEL}\n`);
  process.stdout.write(`  run_id      : ${RUN_ID}\n`);
  process.stdout.write("  ※ 失敗しても自動で再試行しません。\n\n");

  const startedAt = Date.now();
  try {
    const response = await gateway.interpretReply(request);
    const { usage, output } = response;

    process.stdout.write("結果: 応答を受け取りました\n");
    process.stdout.write(`  実使用モデル : ${usage.resolvedModel ?? "取得不能"}`);
    process.stdout.write(` （${usage.modelMeasurement}）\n`);
    process.stdout.write(`  選択主体     : ${usage.routingSource}\n`);
    process.stdout.write(
      `  トークン     : 入力 ${usage.inputTokens ?? "—"} / 出力 ${usage.outputTokens ?? "—"}` +
        (usage.reasoningTokens === undefined ? "" : `（うち推論 ${usage.reasoningTokens}）`) +
        ` （${usage.tokenMeasurement}）\n`,
    );
    if (usage.outputLimitExceeded) {
      // RFC-004 §7 は出力上限を見積りの前提にしている。崩れたら黙って通さない。
      process.stdout.write(
        "  ⚠ 出力上限   : 要求した上限を実測が超えました。**予約が実費を下回り得ます。**\n" +
          "                 推論モデルでは推論トークンが max_tokens の対象外になります。\n",
      );
    }
    process.stdout.write(
      `  費用         : ${usage.costMicroUsd ?? "—"} microUSD （${usage.costKind}）\n`,
    );
    process.stdout.write(`  遅延         : ${usage.latencyMs ?? Date.now() - startedAt} ms\n`);
    process.stdout.write(`  schema検査   : ${usage.validationResult}\n`);
    process.stdout.write(`  prompt版     : ${usage.promptVersion}\n`);
    process.stdout.write(`  rules版      : ${usage.rulesVersion}\n`);
    // 原文は出さない。長さだけ（ADR-008）。
    process.stdout.write(`  マスク後本文 : ${response.maskedReplyText.length} 文字\n`);

    // 契約schemaをもう一度通す。gatewayが通したものと同じ判定であることの確認。
    const reparsed = modelReplyOutputSchema.safeParse(output);
    process.stdout.write(`\n  契約schema   : ${reparsed.success ? "通過" : "不一致"}\n`);
    process.stdout.write(`  intent       : ${output.interpretation.intent}`);
    process.stdout.write(` （fixtureの期待: ${fixture.expect.intent}）\n`);
    if (output.interpretation.intent !== fixture.expect.intent) {
      // 1件の不一致で良し悪しを決めない。評価はRFC-008の固定セットで行う。
      process.stdout.write(
        "  ※ 期待と違います。**1件の結果で精度を判断しない。**\n" +
          "     RFC-008の固定fixtureによる評価は別途必要です。\n",
      );
    }
  } catch (error) {
    // 例外は「成否不明」。確定失敗と断定しない（RFC-004 §7）。
    const name = error instanceof Error ? error.name : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n結果: 呼出しが成立しませんでした（${name}）\n`);
    process.stderr.write(`  ${message}\n`);
    process.stderr.write(
      "  課金の有無は不明です。予約は UNKNOWN_CHARGE として残ります（0にしません）。\n" +
        "  **自動で再試行しないでください。** 下の予約行を確認してから判断します。\n",
    );
    process.exitCode = 1;
  }

  await reportReservations(caseId);
  await closePool();
}

/** 予約と精算が対で残っているかを見る（RFC-004 §7 / D12）。 */
async function reportReservations(caseId: string): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{
      estimated_micro_usd: string;
      settled_micro_usd: string | null;
      cost_kind: string | null;
    }>(
      `select estimated_micro_usd, settled_micro_usd, cost_kind
         from budget_reservation where case_id = $1 order by created_at`,
      [caseId],
    );
    process.stdout.write(`\n予算台帳（case_id=${caseId}）: ${rows.length} 件\n`);
    for (const row of rows) {
      process.stdout.write(
        `  予約 ${row.estimated_micro_usd} / 精算 ${row.settled_micro_usd ?? "未精算"}` +
          ` （${row.cost_kind ?? "—"}）\n`,
      );
    }
    if (rows.some((row) => row.settled_micro_usd === null)) {
      process.stdout.write("  ※ 未精算の予約があります。精算が対で行われていません。\n");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
