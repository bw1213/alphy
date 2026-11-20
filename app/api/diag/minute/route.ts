import { NextResponse } from "next/server";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { quoteCredentials } from "@/lib/kis/config";
import { getClient } from "@/lib/kis/client";
import { kisMinuteDay } from "@/lib/kis/minute";
import { cachedMinuteDays } from "@/lib/intraday/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 종목·날짜별 1분봉 (owner 의 시세 키, 받은 것은 캐시). 한 번에 20쌍까지.
 * { "pairs": [{ "code": "005930", "date": "2026-11-18" }] } → { items: [{ code, date, bars: [[HHMM,시,고,저,종,량]] }] }
 */
export async function POST(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  let body: { pairs?: { code?: string; date?: string }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  const pairs = (body.pairs ?? []).filter((p) => /^[0-9A-Z]{6}$/.test(String(p.code)) && /^\d{4}-\d{2}-\d{2}$/.test(String(p.date))).slice(0, 20) as { code: string; date: string }[];
  if (!pairs.length) return NextResponse.json({ error: "pairs 에 code·date 를 넣어 주세요." }, { status: 400 });
  const cred = quoteCredentials();
  if (!cred) return NextResponse.json({ error: "한국투자증권 앱키가 없습니다." }, { status: 400 });
  const client = getClient(cred);
  const items: { code: string; date: string; bars: unknown[] | null; error?: string }[] = [];
  for (const { code, date } of pairs) {
    try {
      const [d] = await cachedMinuteDays(code, [date], (ymd) => kisMinuteDay(client, code, ymd));
      items.push({ code, date, bars: d?.bars ?? [] });
    } catch (e) { items.push({ code, date, bars: null, error: (e as Error).message }); }
  }
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
