import { NextResponse } from "next/server";
import { loadData, type DataRequest } from "@/lib/data/server";
import { requireUser } from "@/lib/settings/auth";
import { quoteCredentials, type KisCredentials } from "@/lib/kis/config";
import { kisEnvFor } from "@/lib/kis/userkeys";
import { normalizeTicker } from "@/lib/data/market";
import { BusyError, dataGate, rateLimited } from "@/lib/server/limiter";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  // 앱 전체가 로그인 뒤에 있지만(middleware), 누구 요청인지 알아야 사람별로 제한할 수 있음
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const wait = rateLimited(user.id);
  if (wait > 0) return NextResponse.json({ error: `짧은 시간에 너무 많이 실행했습니다. ${Math.ceil(wait / 60000)}분 뒤에 다시 해 주세요.` }, { status: 429 });
  try {
    const body = (await req.json()) as DataRequest;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end)) {
      return NextResponse.json({ error: "날짜 형식은 YYYY-MM-DD" }, { status: 400 });
    }
    // 한국투자증권 시세는 로그인한 사람 본인의 앱키(호출 한도)로 받음
    let kisCred: KisCredentials | null | undefined;
    if (body.source === "kis") {
      kisCred = quoteCredentials(kisEnvFor(user));
    }
    if (body.tickers) body.tickers = [...new Set(body.tickers.map((t) => normalizeTicker(String(t))).filter(Boolean))];
    body.pit = body.pit === true;
    // 시점별 목록은 종목이 계속 바뀌어 전체 종목 수가 2배쯤 되므로 200 까지만
    body.universeSize = Math.min(Math.max(body.universeSize ?? 100, 1), body.pit ? 200 : 300);
    // 느린 NAS 를 위해 한 번에 2건만 받고 나머지는 줄을 섬
    return NextResponse.json(await dataGate.run(() => loadData(body, { kisCred })));
  } catch (e) {
    if (e instanceof BusyError) return NextResponse.json({ error: e.message }, { status: 429 });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
