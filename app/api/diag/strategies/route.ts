import { NextResponse } from "next/server";
import { DENIED, diagAccess } from "@/lib/diag/guard";
import { DiagStrategyError, saveBuiltinStrategy, type DiagStrategyRequest } from "@/lib/diag/strategies";
import { clientIp } from "@/lib/settings/auth";
import { recordLogin } from "@/lib/settings/loginlog";
import { OWNER_ID } from "@/lib/settings/userdir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 기본 전략 + 종목·파라미터를 owner 의 내 전략에 저장 (코드는 받지 않음).
 * 접근: 로그인한 owner 또는 '내 전략 추가'를 켜고 발급한 점검 키.
 * { "name": "모멘텀 회전", "builtin": "rotation", "params": { "topK": 3 }, "tickers": ["QLD", "SSO"], "backfill": true, "overwrite": false }
 */
export async function POST(req: Request) {
  const who = diagAccess(req);
  if (!who) return NextResponse.json(DENIED, { status: 401 });
  if (!who.strategies) return NextResponse.json({ error: "이 점검 키는 읽기 전용입니다. 설정의 '점검 키'에서 '내 전략 추가도 허용'을 켜고 새로 발급하세요." }, { status: 403 });
  let body: DiagStrategyRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 }); }
  try {
    const saved = saveBuiltinStrategy(body);
    recordLogin(req, clientIp(req), "diag-strategy", process.env, Date.now(), who.via === "token" ? `${OWNER_ID}·${who.name}`.slice(0, 32) : OWNER_ID);
    return NextResponse.json({ ok: true, saved });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof DiagStrategyError ? e.status : 500 });
  }
}
