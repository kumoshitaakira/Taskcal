/**
 * スタッフ役の返信投入。
 *
 * **役の切替は本人認証ではない**（RFC-011 §6）。架空スタッフのローカルな切替で、
 * 本番の本人確認とは別。宛先は打診時に固定した版をそのまま送る——画面の現在値で
 * 上書きすると、宛先が変わったのに本人として扱ってしまう（A15）。
 */

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { buildAppServices } from "@/application/deps";
import { MAX_REPLY_CHARS } from "@/config/mvp-policy";
import { NOTICE, type NoticeCode } from "../_components/notice";

function back(code: NoticeCode, count?: number): never {
  redirect(count === undefined ? `/staff?n=${code}` : `/staff?n=${code}&c=${count}`);
}

export async function submitReplyAction(formData: FormData): Promise<void> {
  const body = String(formData.get("body") ?? "").trim();
  const provider = String(formData.get("provider") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const endpointKey = String(formData.get("endpointKey") ?? "");
  const endpointVersion = Number(formData.get("endpointVersion") ?? 0);
  // イベントIDはフォームが描画時に作る。二重送信が同じ受信イベントになる（A15）。
  const eventId = String(formData.get("eventId") ?? "");
  const inReplyToMessageId = String(formData.get("inReplyToMessageId") ?? "");

  if (
    !body ||
    !provider ||
    !connectionId ||
    !endpointKey ||
    !endpointVersion ||
    !eventId ||
    !inReplyToMessageId
  ) {
    back(NOTICE.INPUT_MISSING);
  }
  if (body.length > MAX_REPLY_CHARS) back(NOTICE.REPLY_TOO_LONG);

  const services = buildAppServices();
  const now = new Date().toISOString();
  const result = await services.receiveInboundEvent({
    provider,
    connectionId,
    eventId,
    occurredAt: now,
    receivedAt: now,
    from: { provider, connectionId, endpointKey, endpointVersion },
    inReplyToMessageId,
    body,
    // 模擬環境なので署名検証は行っていない。本人確認でもない。
    channelVerified: false,
  });

  revalidatePath("/staff");
  revalidatePath("/manager");

  if (!result.ok) back(NOTICE.FAILED);
  if (result.match === "DUPLICATE") back(NOTICE.REPLY_DUPLICATE);
  if (result.senderIdentity !== "VERIFIED_OUTREACH_TARGET") back(NOTICE.REPLY_UNMATCHED);
  back(NOTICE.REPLY_RECORDED, result.receivedSeq);
}
