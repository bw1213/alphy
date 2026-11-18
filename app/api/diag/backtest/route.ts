import { NextResponse } from "next/server";
import { backtestReport, type DiagBacktestRequest } from "@/lib/diag/report";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { BusyError, dataGate } from "@/lib/server/limiter";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jobs = namedJobs<Awaited<ReturnType<typeof backtestReport>>>("diag-backtest");

/**
 * 서버에서 백테스트 재현 (결과는 저장하지 않음).
 * 20초 안에 안 끝나면 202 { job } → GET ?job=<id> 로 이어서 물어봄 (프록시 60초 제한).
 * { "strategy": "저장한 전략 이름 또는 기본 전략 id", "tickers": ["069500"], "start": "2023-01-01", "end": "2026-11-13", "cash": 10000000, "monthly": 0, "backfill": true }
 * backfill: true 면 상장 전 기간을 지수로 채움 (화면의 '상장 전 기간은 지수로 채우기')
 * 또는 저장하지 않은 적립·분할 매도 설정: { "cycle": { ... }, "tickers": ["069500"] }
 */
export async function POST(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  let body: DiagBacktestRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  return startJob(jobs, "diag", JSON.stringify(body), () => dataGate.run(() => backtestReport(body)), { errStatus: (e) => (e instanceof BusyError ? 429 : 400) });
}

/** 진행 중인 백테스트 재현 결과 물어보기: ?job=<id> */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  return pollJob(jobs, "diag", new URL(req.url).searchParams.get("job") ?? "");
}
