import { NextResponse } from "next/server";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { loadStatementDebug } from "@/lib/accounts/statementDebug";
import { OWNER_ID } from "@/lib/settings/userdir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 과거 기록 화면에서 "점검용으로 보내기"로 남긴 PDF 글자 위치 (관리자 것) */
export async function GET(req: Request) {
  if (!diagAccess(req)) return NextResponse.json(DENIED, { status: 401 });
  const d = loadStatementDebug(OWNER_ID);
  return d ? NextResponse.json(d, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "보낸 PDF 글자가 없습니다." }, { status: 404 });
}
