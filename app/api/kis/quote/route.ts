import { NextResponse } from "next/server";
import { quoteCredentials } from "@/lib/kis/config";
import { kisEnvFor } from "@/lib/kis/userkeys";
import { getClient } from "@/lib/kis/client";
import { kisQuote } from "@/lib/kis/market";
import { requireUser } from "@/lib/settings/auth";
import { lookupCodes } from "@/lib/stocks/master";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const code = new URL(req.url).searchParams.get("code")?.toUpperCase() ?? "";
  if (!/^[0-9A-Z]{6}$/.test(code)) return NextResponse.json({ error: "종목코드는 6자리입니다" }, { status: 400 });
  const cred = quoteCredentials(kisEnvFor(user));
  if (!cred) return NextResponse.json({ error: "한국투자증권 앱키가 설정되지 않았습니다" }, { status: 503 });
  try {
    const q = await kisQuote(getClient(cred), code);
    // 증권사 현재가 응답에는 종목 이름이 없어 종목 목록에서 채움
    if (!q.name) { try { q.name = lookupCodes([code])[0]?.name; } catch { /* 목록 없음 */ } }
    return NextResponse.json(q);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
