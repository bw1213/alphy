import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/settings/auth";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";
import { addCustom, allStocks, lookupCodes, refreshIfStale, refreshStocks, removeCustom, searchStocks } from "@/lib/stocks/master";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

function status() {
  const { store, all } = allStocks();
  return { count: all.length, downloaded: store.entries.length, updated: store.updated ?? null, custom: store.custom, error: store.error ?? null, errorAt: store.errorAt ?? null };
}

/** 목록 새로 받기는 시장별 파일을 여러 개 내려받아 오래 걸릴 수 있어 작업으로 돌림 (프록시 60초 제한) */
const refreshJobs = namedJobs<ReturnType<typeof status>>("stocks-refresh");

/**
 * ?job=<id>   "지금 새로 받기" 결과 물어보기
 * ?q=삼성      이름·코드·초성 검색 (최대 limit 개, 기본 20)
 * ?codes=a,b  코드 → 이름
 * (없음)      목록 상태
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const q = u.searchParams.get("q");
  const codes = u.searchParams.get("codes");
  if (q !== null) {
    refreshIfStale();
    const limit = Math.min(50, Math.max(1, Number(u.searchParams.get("limit")) || 20));
    return NextResponse.json({ items: searchStocks(allStocks().all, q.slice(0, 40), limit) }, noStore);
  }
  const job = u.searchParams.get("job");
  if (job !== null) {
    const denied = requireAdmin(req);
    if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
    return pollJob(refreshJobs, "admin", job);
  }
  if (codes !== null) {
    const list = codes.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean).slice(0, 300);
    return NextResponse.json({ items: lookupCodes(list) }, noStore);
  }
  return NextResponse.json(status(), noStore);
}

/** { action: "refresh" } | { action: "add", code, name, market } | { action: "remove", code, market } — 관리자만 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try {
    if (body?.action === "refresh") return startJob(refreshJobs, "admin", "refresh", async () => { await refreshStocks(); return status(); }, { errStatus: () => 400 });
    if (body?.action === "add") addCustom({ code: String(body.code ?? ""), name: String(body.name ?? ""), market: String(body.market ?? "KOSPI") });
    else if (body?.action === "remove") removeCustom(String(body.code ?? ""), body.market ? String(body.market) : undefined);
    else return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    return NextResponse.json(status());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
