import { NextResponse } from "next/server";
import { loadData, type DataRequest } from "@/lib/data/server";
import { requireAdmin } from "@/lib/settings/auth";

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
      const denied = requireAdmin(req);
      if (denied) return NextResponse.json({ error: `한국투자증권 시세는 로그인해야 쓸 수 있습니다. ${denied[1]}` }, { status: denied[0] });
    }
    if (body.tickers) body.tickers = body.tickers.filter((t) => /^[0-9A-Z]{6}$/.test(t));
    body.universeSize = Math.min(Math.max(body.universeSize ?? 100, 1), 300);
    return NextResponse.json(await loadData(body));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
