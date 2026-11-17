import { NextResponse } from "next/server";
import { kisReport } from "@/lib/diag/kis";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const jobs = namedJobs<Awaited<ReturnType<typeof kisReport>>>("diag-kis");

/**
 * 한국투자증권 API 실제 호출 점검 (조회만, 주문 없음). ?env=real|mock (없으면 둘 다), ?code=005930
 * 20초 안에 안 끝나면 202 { job } → 같은 주소에 ?job=<id> 로 이어서 물어봄 (프록시 60초 제한)
 */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  const q = new URL(req.url).searchParams;
  const id = q.get("job");
  if (id) return pollJob(jobs, "diag", id);
  const env = q.get("env"), code = q.get("code");
  return startJob(jobs, "diag", JSON.stringify([env, code]), () => kisReport({ env, code }));
}
