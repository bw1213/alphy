import { NextResponse } from "next/server";
import { loadData, type DataRequest } from "@/lib/data/server";
import { requireOwner } from "@/lib/settings/auth";
import { normalizeTicker } from "@/lib/data/market";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DataRequest;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end)) {
      return NextResponse.json({ error: "날짜 형식은 YYYY-MM-DD" }, { status: 400 });
    }
    // 한국투자증권 시세는 내 앱키의 호출 한도를 쓰므로 로그인한 사람만
    if (body.source === "kis") {
      const denied = requireOwner(req).denied;
      if (denied) return NextResponse.json({ error: `한국투자증권 시세는 쓸 수 없습니다. ${denied[1]}` }, { status: denied[0] });
    }
    if (body.tickers) body.tickers = [...new Set(body.tickers.map((t) => normalizeTicker(String(t))).filter(Boolean))];
    body.pit = body.pit === true;
    // 시점별 목록은 종목이 계속 바뀌어 전체 종목 수가 2배쯤 되므로 200 까지만
    body.universeSize = Math.min(Math.max(body.universeSize ?? 100, 1), body.pit ? 200 : 300);
    return NextResponse.json(await loadData(body));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
