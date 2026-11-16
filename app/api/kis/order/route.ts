import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { quoteCredentials } from "@/lib/kis/config";
import { tradeCredentialsFor } from "@/lib/kis/access";
import { kisEnvFor, orderLimitFor } from "@/lib/kis/userkeys";
import { kisQuote } from "@/lib/kis/market";
import { addUsage, checkOrderLimit, usedToday } from "@/lib/kis/limits";
import { getClient } from "@/lib/kis/client";
import { placeOrder, validateOrder } from "@/lib/kis/trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let order;
  try { order = validateOrder(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const client = getClient(tradeCredentialsFor(user));
    // 실전 주문은 금액 상한 확인 (시장가는 현재가로 금액을 어림)
    let amount = 0;
    if (client.env === "real") {
      const limit = orderLimitFor(user.id);
      const price = order.type === "limit" ? order.price! : (await kisQuote(getClient(quoteCredentials(kisEnvFor(user)) ?? client.cred), order.code)).price;
      amount = price * order.qty;
      try { checkOrderLimit(amount, limit, usedToday(process.env, Date.now(), user.id)); }
      catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
    }
    const result = await placeOrder(client, order);
    if (client.env === "real") { try { addUsage(amount, process.env, Date.now(), user.id); } catch (e) { console.error(`[kis-order] 하루 합계 저장 실패: ${(e as Error).message}`); } }
    console.log(`[kis-order] ${user.id} ${client.env} ${order.side} ${order.code} x${order.qty} ${order.type}${order.price ? "@" + order.price : ""} → ${result.orderNo}`);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
