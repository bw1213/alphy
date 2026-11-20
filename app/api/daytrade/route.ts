import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { quoteCredentials } from "@/lib/kis/config";
import { kisEnvFor } from "@/lib/kis/userkeys";
import { runKisDayTrade } from "@/lib/intraday/server";
import type { DayTradeReport, DayTradeRequest } from "@/lib/intraday/daytrade";
import { deleteDayTrade, loadDayTrades, saveDayTrade } from "@/lib/intraday/store";
import { BusyError, dataGate, rateLimited } from "@/lib/server/limiter";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jobs = namedJobs<DayTradeReport>("daytrade");

/** 내 단타 전략 목록, 또는 ?job= 로 백테스트 진행 상황 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const job = new URL(req.url).searchParams.get("job");
  if (job) return pollJob(jobs, user.id, job);
  return NextResponse.json({ items: loadDayTrades(user.id) }, { headers: { "Cache-Control": "no-store" } });
}

/** { action: "run", spec, start } 백테스트(처음엔 전 종목 일봉·분봉을 받느라 수 분) · "save" { name, spec, overwrite } · "delete" { name } */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: DayTradeRequest & { action?: string; name?: string; overwrite?: boolean; note?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  try {
    if (body.action === "save") return NextResponse.json({ item: saveDayTrade(body, { overwrite: body.overwrite === true, user: user.id }), items: loadDayTrades(user.id) });
    if (body.action === "delete") { deleteDayTrade(String(body.name ?? ""), user.id); return NextResponse.json({ items: loadDayTrades(user.id) }); }
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const wait = rateLimited(user.id);
  if (wait > 0) return NextResponse.json({ error: `짧은 시간에 너무 많이 실행했습니다. ${Math.ceil(wait / 60000)}분 뒤에 다시 해 주세요.` }, { status: 429 });
  const run: DayTradeRequest = { spec: body.spec, start: body.start, end: body.end, commission: body.commission, slippage: body.slippage };
  const cred = quoteCredentials(kisEnvFor(user));
  return startJob(jobs, user.id, JSON.stringify(run), (progress) => dataGate.run(() => runKisDayTrade(run, cred, progress)),
    { errStatus: (e) => (e instanceof BusyError ? 429 : 400) });
}
