import { NextResponse } from "next/server";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { quoteCredentials } from "@/lib/kis/config";
import { runKisDayTrade } from "@/lib/intraday/server";
import type { DayTradeReport, DayTradeRequest } from "@/lib/intraday/daytrade";
import { loadDayTrades, saveDayTrade } from "@/lib/intraday/store";
import { BusyError, dataGate } from "@/lib/server/limiter";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jobs = namedJobs<DayTradeReport>("diag-daytrade");

/** ?job= 백테스트 결과, 없으면 owner 의 내 단타 전략 목록 */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  const job = new URL(req.url).searchParams.get("job");
  if (job) return pollJob(jobs, "diag", job);
  return NextResponse.json({ items: loadDayTrades() });
}

/**
 * 날마다 종목을 고르는 단타 백테스트 { spec, start, end } (owner 시세 키, 주문 없음).
 * { save: { name, spec, note, overwrite } } 는 owner 의 내 단타 전략에 저장 ('내 전략 추가 허용' 키만)
 */
export async function POST(req: Request) {
  const who = diagAccess(req);
  if (!who) return NextResponse.json(DENIED, { status: 401 });
  let body: DayTradeRequest & { save?: { name?: string; spec?: unknown; note?: string; overwrite?: boolean } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  if (body.save) {
    if (!who.strategies) return NextResponse.json({ error: "이 점검 키는 내 전략 추가가 허용되지 않았습니다." }, { status: 403 });
    try { return NextResponse.json({ item: saveDayTrade(body.save, { overwrite: body.save.overwrite === true }) }); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  }
  const run: DayTradeRequest = { spec: body.spec, start: body.start, end: body.end, commission: body.commission, slippage: body.slippage };
  return startJob(jobs, "diag", JSON.stringify(run), (progress) => dataGate.run(() => runKisDayTrade(run, quoteCredentials(), progress)),
    { errStatus: (e) => (e instanceof BusyError ? 429 : 400) });
}
