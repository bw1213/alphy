import { NextResponse } from "next/server";
import { dataReport } from "@/lib/diag/report";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jobs = namedJobs<Awaited<ReturnType<typeof dataReport>>>("diag-data");

/** 20초 안에 안 끝나면 202 { job } → 같은 주소에 ?job=<id> (프록시 60초 제한). 종목별 시세 범위·빈 구간·캐시 상태. ?tickers=069500,005930&start=2024-01-01&end=2026-11-13&source=naver */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  const q = new URL(req.url).searchParams;
  const id = q.get("job");
  if (id) return pollJob(jobs, "diag", id);
  const args = { tickers: q.get("tickers") ?? q.get("ticker"), start: q.get("start") ?? undefined, end: q.get("end") ?? undefined, source: q.get("source") };
  return startJob(jobs, "diag", JSON.stringify(args), () => dataReport(args), { errStatus: () => 400 });
}
