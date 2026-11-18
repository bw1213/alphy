import { NextResponse } from "next/server";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { manualReport } from "@/lib/diag/manual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 수동 계좌 점검 (조회만): 계좌별 전략·종목·기록 잔고와 최근 저녁 계산(목표 보유·안내) */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  try { return NextResponse.json(manualReport()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}
