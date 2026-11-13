import { NextResponse } from "next/server";
import { overview } from "@/lib/diag/report";
import { DENIED, diagAccess } from "@/lib/diag/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 읽기 전용 점검: 버전·실행 상태·설정 요약(비밀값 없음)·저장된 전략·캐시.
 * 접근: 로그인 쿠키 또는 Authorization: Bearer <점검 키>
 * 다른 점검: GET /api/diag/data?tickers=069500&start=YYYY-MM-DD&end=YYYY-MM-DD
 *            POST /api/diag/backtest { strategy, tickers, start, end, cash, monthly }
 */
export function GET(req: Request) {
  const who = diagAccess(req);
  if (!who) return NextResponse.json(DENIED, { status: 401 });
  return NextResponse.json({ ...overview(), access: who }, { headers: { "Cache-Control": "no-store" } });
}
