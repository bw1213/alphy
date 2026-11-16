import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { getClient } from "@/lib/kis/client";
import { getBalance } from "@/lib/kis/trading";
import { tradeCredentialsFor } from "@/lib/kis/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 내 계좌 잔고 (로그인한 사람 본인의 앱키·계좌) */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  try {
    return NextResponse.json(await getBalance(getClient(tradeCredentialsFor(user))));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
