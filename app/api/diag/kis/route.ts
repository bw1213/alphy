import { NextResponse } from "next/server";
import { kisReport } from "@/lib/diag/kis";
import { DENIED, diagAccess } from "@/lib/diag/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 한국투자증권 API 실제 호출 점검 (조회만, 주문 없음). ?env=real|mock (없으면 둘 다), ?code=005930 */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    return NextResponse.json(await kisReport({ env: q.get("env"), code: q.get("code") }), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
