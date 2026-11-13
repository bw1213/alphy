import { NextResponse } from "next/server";
import { dataReport } from "@/lib/diag/report";
import { DENIED, diagAccess } from "@/lib/diag/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 종목별 시세 범위·빈 구간·캐시 상태. ?tickers=069500,005930&start=2024-01-01&end=2026-11-13&source=naver */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    const out = await dataReport({ tickers: q.get("tickers") ?? q.get("ticker"), start: q.get("start") ?? undefined, end: q.get("end") ?? undefined, source: q.get("source") });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
