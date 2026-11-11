import { NextResponse } from "next/server";
import { quoteCredentials } from "@/lib/kis/config";
import { getClient } from "@/lib/kis/client";
import { kisQuote } from "@/lib/kis/market";
import { requireAdmin } from "@/lib/settings/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const code = new URL(req.url).searchParams.get("code")?.toUpperCase() ?? "";
  if (!/^[0-9A-Z]{6}$/.test(code)) return NextResponse.json({ error: "종목코드는 6자리입니다" }, { status: 400 });
  const cred = quoteCredentials();
  if (!cred) return NextResponse.json({ error: "한국투자증권 앱키가 설정되지 않았습니다" }, { status: 503 });
  try {
    return NextResponse.json(await kisQuote(getClient(cred), code));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
