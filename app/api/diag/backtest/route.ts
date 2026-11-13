import { NextResponse } from "next/server";
import { backtestReport, type DiagBacktestRequest } from "@/lib/diag/report";
import { DENIED, diagAccess } from "@/lib/diag/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 서버에서 백테스트 재현 (결과는 저장하지 않음).
 * { "strategy": "저장한 전략 이름 또는 기본 전략 id", "tickers": ["069500"], "start": "2023-01-01", "end": "2026-11-13", "cash": 10000000, "monthly": 0 }
 * 또는 저장하지 않은 적립·분할 매도 설정: { "cycle": { ... }, "tickers": ["069500"] }
 */
export async function POST(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  let body: DiagBacktestRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  try {
    return NextResponse.json(await backtestReport(body), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
