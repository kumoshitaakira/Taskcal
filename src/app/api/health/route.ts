import { NextResponse } from "next/server";
import { getRuntimeStatus } from "@/application/runtime-status";

// 起動状態はリクエストごとに確認する。
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getRuntimeStatus();
  const healthy = status.database.status === "OK";
  return NextResponse.json(status, { status: healthy ? 200 : 503 });
}
