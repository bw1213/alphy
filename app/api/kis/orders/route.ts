import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { getClient } from "@/lib/kis/client";
import { tradeCredentialsFor } from "@/lib/kis/access";
import { cancelOrder, listDayOrders } from "@/lib/kis/orders";
import { kst } from "@/lib/auto/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 내 계좌의 오늘 주문·체결 내역 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  try {
    const client = getClient(tradeCredentialsFor(user));
    return NextResponse.json({ env: client.env, date: kst().date, orders: await listDayOrders(client, kst().date) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** 미체결 취소 { orderNo, orgNo } */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const orderNo = String(b?.orderNo ?? "").trim(), orgNo = String(b?.orgNo ?? "").trim();
  if (!/^\d{1,12}$/.test(orderNo) || !/^\d{0,8}$/.test(orgNo)) return NextResponse.json({ error: "주문번호가 올바르지 않습니다." }, { status: 400 });
  try {
    const msg = await cancelOrder(getClient(tradeCredentialsFor(user)), { orderNo, orgNo });
    console.log(`[kis-order] ${user.id} 취소 ${orderNo} → ${msg}`);
    return NextResponse.json({ ok: true, message: msg });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
