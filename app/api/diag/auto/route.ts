import { NextResponse } from "next/server";
import { autoReport } from "@/lib/diag/auto";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const jobs = namedJobs<Awaited<ReturnType<typeof autoReport>>>("diag-auto");

/**
 * 자동 매매 점검 (조회만, ?acct=kis-xxxx 는 더 붙인 계좌): 운용 상태, 성과 기준, 최근 저녁 계산·아침 주문·장중 기록, 지금 잔고 합계.
 * 증권사 잔고를 읽느라 20초가 넘으면 202 { job } → ?job=<id> 로 이어서 물어봄 (프록시 60초 제한)
 */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  const id = new URL(req.url).searchParams.get("job");
  if (id) return pollJob(jobs, "diag", id);
  const acct = new URL(req.url).searchParams.get("acct") || undefined;
  return startJob(jobs, "diag", `auto:${acct ?? ""}`, () => autoReport(acct));
}
