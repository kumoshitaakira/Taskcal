/**
 * 模擬providerの受信口。
 *
 * Server Action ではなく Route Handler にしてある。外部から叩ける安定したURLが
 * 要るため：curl・統合テスト・デモの再現から同じ経路を通す。とくに A15
 * （接続違いの同じ eventId）は HTTP 経路で再現できることに意味がある。
 *
 * **これは模擬環境の入口であり、本番のwebhookではない。** 署名検証は無い。
 * `channelVerified` は経路の検証結果であって本人確認ではない（RFC-011 §6）。
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { TaskcalError } from "@/contracts/errors";
import { buildAppServices } from "@/application/deps";
import { MAX_REPLY_CHARS } from "@/config/mvp-policy";

export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  provider: z.string().min(1).max(64),
  connectionId: z.string().min(1).max(128),
  eventId: z.string().min(1).max(128),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  from: z.strictObject({
    provider: z.string().min(1).max(64),
    connectionId: z.string().min(1).max(128),
    endpointKey: z.string().min(1).max(128),
    endpointVersion: z.number().int().positive(),
  }),
  /** 返信対象の送信Message（RFC-011 §3）。無い返信は本人と確認できない扱いになる。 */
  inReplyToMessageId: z.uuid().optional(),
  // 空本文を受け取らない。解釈できない受信を作るだけで、保留の記録が増える。
  body: z.string().min(1).max(MAX_REPLY_CHARS).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { code: "INVALID_INPUT", detail: "JSONではありません。" },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    // 検証の詳細は返さない。入力の形だけを伝える（ADR-008）。
    return NextResponse.json(
      { code: "INVALID_INPUT", detail: "受信イベントの形式が不正です。" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const services = buildAppServices();
  try {
    const result = await services.receiveInboundEvent({
      provider: parsed.data.provider,
      connectionId: parsed.data.connectionId,
      eventId: parsed.data.eventId,
      occurredAt: parsed.data.occurredAt ?? now,
      receivedAt: now,
      from: parsed.data.from,
      inReplyToMessageId: parsed.data.inReplyToMessageId,
      body: parsed.data.body,
      // 模擬環境なので署名検証は行っていない。本人確認でもない。
      channelVerified: false,
    });
    if (!result.ok) {
      return NextResponse.json({ code: result.code, detail: result.detail }, { status: 409 });
    }
    return NextResponse.json(result, { status: result.match === "NEW" ? 201 : 200 });
  } catch (error) {
    if (error instanceof TaskcalError) {
      return NextResponse.json({ code: error.code, detail: error.message }, { status: 409 });
    }
    throw error;
  }
}
