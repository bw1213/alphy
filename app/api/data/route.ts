import { NextResponse } from "next/server";
import { loadData, type DataRequest } from "@/lib/data/server";
import { requireUser } from "@/lib/settings/auth";
import { quoteCredentials, type KisCredentials } from "@/lib/kis/config";
import { kisEnvFor } from "@/lib/kis/userkeys";
import { normalizeTicker } from "@/lib/data/market";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DataRequest;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end)) {
      return NextResponse.json({ error: "날짜 형식은 YYYY-MM-DD" }, { status: 400 });
    }
    // 한국투자증권 시세는 로그인한 사람 본인의 앱키(호출 한도)로 받음
    let kisCred: KisCredentials | null | undefined;
    if (body.source === "kis") {
      const { user, denied } = requireUser(req);
      if (denied) return NextResponse.json({ error: `한국투자증권 시세는 로그인해야 쓸 수 있습니다. ${denied[1]}` }, { status: denied[0] });
      kisCred = quoteCredentials(kisEnvFor(user));
    }
    if (body.tickers) body.tickers = [...new Set(body.tickers.map((t) => normalizeTicker(String(t))).filter(Boolean))];
    body.pit = body.pit === true;
    // 시점별 목록은 종목이 계속 바뀌어 전체 종목 수가 2배쯤 되므로 200 까지만
    body.universeSize = Math.min(Math.max(body.universeSize ?? 100, 1), body.pit ? 200 : 300);
    return NextResponse.json(await loadData(body, { kisCred }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
