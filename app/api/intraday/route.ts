import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { quoteCredentials } from "@/lib/kis/config";
import { kisEnvFor } from "@/lib/kis/userkeys";
import { runKisStudy } from "@/lib/intraday/server";
import type { IntradayReport, IntradayRequest } from "@/lib/intraday/study";
import { BusyError, dataGate, rateLimited } from "@/lib/server/limiter";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jobs = namedJobs<IntradayReport>("intraday");

/** 단타 전략 찾기. 처음엔 1분봉을 받느라 몇 분 걸려서 작업으로 돌리고 GET ?job= 으로 이어서 물어봄 */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const wait = rateLimited(user.id);
  if (wait > 0) return NextResponse.json({ error: `짧은 시간에 너무 많이 실행했습니다. ${Math.ceil(wait / 60000)}분 뒤에 다시 해 주세요.` }, { status: 429 });
  let body: IntradayRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  const cred = quoteCredentials(kisEnvFor(user));
  return startJob(jobs, user.id, JSON.stringify(body), (progress) => dataGate.run(() => runKisStudy(body, cred, progress)),
    { errStatus: (e) => (e instanceof BusyError ? 429 : 400) });
}

export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return pollJob(jobs, user.id, new URL(req.url).searchParams.get("job") ?? "");
}
