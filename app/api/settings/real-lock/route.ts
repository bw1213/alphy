import { NextResponse } from "next/server";
import { clientIp, requireOwner } from "@/lib/settings/auth";
import { recordLogin } from "@/lib/settings/loginlog";
import { serverRealLock, updateSettings } from "@/lib/settings/store";
import { stepUpError } from "@/lib/settings/stepup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 서버 전체 실전 주문 잠금 (owner 만).
 * { on: true, code }  2단계 인증 코드가 맞으면 잠금 해제
 * { on: false }       바로 잠금 (위급할 때 막히지 않게 코드 없이)
 */
export async function POST(req: Request) {
  const { user, denied } = requireOwner(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let b: { on?: unknown; code?: unknown };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const ip = clientIp(req);
  const lock = serverRealLock();
  if (b.on === true) {
    if (lock.env === "no") return NextResponse.json({ error: "NAS .env 의 KIS_ALLOW_REAL_ORDERS=no 로 잠겨 있어 화면에서 풀 수 없습니다." }, { status: 409 });
    const err = stepUpError(req, user.id, b.code);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    updateSettings((s) => { s.kis.realUnlock = { at: Date.now(), ip }; });
    recordLogin(req, ip, "real-unlock", process.env, Date.now(), user.id);
    console.log(`[settings] 실전 주문 잠금 해제 (${ip})`);
  } else if (b.on === false) {
    updateSettings((s) => { delete s.kis.realUnlock; });
    recordLogin(req, ip, "real-lock", process.env, Date.now(), user.id);
    console.log(`[settings] 실전 주문 잠금 (${ip})`);
  } else return NextResponse.json({ error: "on 은 true 또는 false 입니다." }, { status: 400 });
  return NextResponse.json(serverRealLock());
}
