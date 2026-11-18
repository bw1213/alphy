import { NextResponse } from "next/server";
import { loadData, type DataRequest, type DataResponse } from "@/lib/data/server";
import { requireUser } from "@/lib/settings/auth";
import { credentialsFor, quoteCredentials, type KisCredentials } from "@/lib/kis/config";
import { kisEnvFor } from "@/lib/kis/userkeys";
import { normalizeTicker } from "@/lib/data/market";
import { cleanSpec } from "@/lib/data/backfill";
import { BusyError, dataGate, rateLimited } from "@/lib/server/limiter";
import { createJobStore, type JobStore, type JobView } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 시세 받기는 작업으로 시작하고 한 요청은 최대 이만큼만 기다림.
 * DSM 역방향 프록시가 60초 동안 응답이 없으면 연결을 끊고 HTML 오류 페이지를 주기 때문에 그보다 짧게.
 * 그때까지 안 끝나면 202 + 작업 id 를 주고, 화면이 GET ?job= 으로 이어서 물어봄.
 */
const WAIT_MS = 20_000;

const g = globalThis as unknown as { __alphyDataJobs?: JobStore<DataResponse> };
const jobs = (g.__alphyDataJobs ??= createJobStore<DataResponse>());

function reply(owner: string, j: JobView<DataResponse>) {
  if (j.state === "done") {
    jobs.remove(owner, j.id);
    return NextResponse.json(j.result);
  }
  if (j.state === "error") {
    jobs.remove(owner, j.id);
    return NextResponse.json({ error: j.error }, { status: j.status ?? 500 });
  }
  return NextResponse.json({ job: j.id, progress: j.progress ?? null }, { status: 202, headers: { "Cache-Control": "no-store" } });
}

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
    // 배당 정보(한국투자증권 예탁원 배당일정·해외 권리조회)는 실전 키로 (없으면 Yahoo 만. 모의투자 서버는 지원하지 않을 수 있음)
    const userEnv = kisEnvFor(user);
    const kisDividendCred = credentialsFor("real", userEnv);
    if (body.tickers) body.tickers = [...new Set(body.tickers.map((t) => normalizeTicker(String(t))).filter(Boolean))];
    body.pit = body.pit === true;
    if (body.backfill && typeof body.backfill === "object") {
      body.backfill = Object.fromEntries(Object.entries(body.backfill).slice(0, 50)
        .map(([k, v]) => [k === "*" ? "*" : normalizeTicker(k), v === "auto" || v === null ? v : cleanSpec(v)] as const)
        .filter(([k]) => k));
    } else body.backfill = null;
    // 시점별 목록은 종목이 계속 바뀌어 전체 종목 수가 2배쯤 되므로 200 까지만
    body.universeSize = Math.min(Math.max(body.universeSize ?? 100, 1), body.pit ? 200 : 300);
    // 느린 NAS 를 위해 한 번에 2건만 받고 나머지는 줄을 섬. 같은 요청을 다시 누르면 돌던 작업을 이어서 봄
    const j = jobs.start(user.id, JSON.stringify(body),
      (onProgress) => dataGate.run(() => loadData(body, { kisCred, kisDividendCred, onProgress })),
      (e) => (e instanceof BusyError ? 429 : undefined));
    return reply(user.id, (await jobs.wait(user.id, j.id, WAIT_MS)) ?? j);
  } catch (e) {
    if (e instanceof BusyError) return NextResponse.json({ error: e.message }, { status: 429 });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** 진행 중인 시세 받기 작업 상태. 요청 횟수 제한에는 세지 않음 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const id = new URL(req.url).searchParams.get("job") ?? "";
  const j = await jobs.wait(user.id, id, WAIT_MS);
  if (!j) return NextResponse.json({ error: "시세 받기 작업을 찾지 못했습니다 (서버가 다시 시작됐을 수 있어요). 다시 실행해 주세요." }, { status: 404 });
  return reply(user.id, j);
}
