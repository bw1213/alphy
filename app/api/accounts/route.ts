import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { listAccounts } from "@/lib/accounts/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 내 계좌 목록 (한국투자증권 자동 + 수동 계좌) */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return NextResponse.json({ accounts: listAccounts(user) }, { headers: { "Cache-Control": "no-store" } });
}
