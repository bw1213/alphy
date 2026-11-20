import { NextResponse } from "next/server";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { quoteCredentials } from "@/lib/kis/config";
import { runKisStudy } from "@/lib/intraday/server";
import type { IntradayReport, IntradayRequest } from "@/lib/intraday/study";
import { BusyError, dataGate } from "@/lib/server/limiter";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jobs = namedJobs<IntradayReport>("diag-intraday");

/**
 * 단타 전략 찾기 (owner 의 시세 키, 주문 없음). /api/intraday 와 같은 계산.
 * { "tickers": ["069500"], "start": "2025-11-20", "barMinutes": 5, "commission": 0.015, "slippage": 0.02 }
 */
export async function POST(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  let body: IntradayRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  return startJob(jobs, "diag", JSON.stringify(body), (progress) => dataGate.run(() => runKisStudy(body, quoteCredentials(), progress)),
    { errStatus: (e) => (e instanceof BusyError ? 429 : 400) });
}

export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  return pollJob(jobs, "diag", new URL(req.url).searchParams.get("job") ?? "");
}
