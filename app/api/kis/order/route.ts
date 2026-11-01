import { NextResponse } from "next/server";
import { checkTradeToken } from "@/lib/kis/auth";
import { tradeCredentials } from "@/lib/kis/config";
import { getClient } from "@/lib/kis/client";
import { placeOrder, validateOrder } from "@/lib/kis/trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = checkTradeToken(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let order;
  try { order = validateOrder(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const client = getClient(tradeCredentials());
    const result = await placeOrder(client, order);
    console.log(`[kis-order] ${client.env} ${order.side} ${order.code} x${order.qty} ${order.type}${order.price ? "@" + order.price : ""} → ${result.orderNo}`);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
