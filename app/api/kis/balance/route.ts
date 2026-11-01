import { NextResponse } from "next/server";
import { checkTradeToken } from "@/lib/kis/auth";
import { tradeCredentials } from "@/lib/kis/config";
import { getClient } from "@/lib/kis/client";
import { getBalance } from "@/lib/kis/trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = checkTradeToken(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  try {
    return NextResponse.json(await getBalance(getClient(tradeCredentials())));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
