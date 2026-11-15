import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { checkTotp, clientIp, cookieHeader, issueSession, logoutUser, requireUser, totpEnabled } from "@/lib/settings/auth";
import { readLoginLog, recordLogin, type LoginEvent } from "@/lib/settings/loginlog";
import { getUser, updateUser } from "@/lib/settings/users";
import { OWNER_ID } from "@/lib/settings/userdir";
import { newTotpSecret, otpauthUri, verifyTotp } from "@/lib/settings/totp";
import { createDiagToken, listDiagTokens, revokeDiagToken } from "@/lib/settings/diag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 내 보안 상태: 2단계 인증 여부, 최근 로그인 기록(관리자는 모두, 아니면 내 것만), 점검 키 목록(owner 만, 원문 없음) */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const admin = user.role === "admin";
  const log = readLoginLog().filter((r) => admin || r.user === user.id).slice(0, admin ? 50 : 30);
  return NextResponse.json({ totpEnabled: totpEnabled(process.env, user.id), log, you: clientIp(req), admin, me: user.id, owner: user.id === OWNER_ID, diagTokens: user.id === OWNER_ID ? listDiagTokens() : [] });
}

/**
 * { action: "totp-begin" }            새 키를 만들고 QR 코드 반환 (아직 켜지지 않음)
 * { action: "totp-enable", code }     인증 앱 코드로 확인되면 켬
 * { action: "totp-disable", code }    지금 코드로 확인되면 끔
 * { action: "logout-all" }            내 모든 기기 로그아웃 (이 기기는 새로 로그인 유지, owner 면 점검 키도 폐기)
 * { action: "diag-create", name, days } 읽기 전용 점검 키 발급 (원문은 이 응답에만) — owner 만
 * { action: "diag-revoke", id }       점검 키 폐기 — owner 만
 * 2단계 인증은 모두 "내 계정" 것
 */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const me = user.id;
  const ip = clientIp(req);
  const log = (event: LoginEvent) => recordLogin(req, ip, event, process.env, Date.now(), me);
  let b: Record<string, string>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try {
    if (b.action === "totp-begin") {
      if (totpEnabled(process.env, me)) return NextResponse.json({ error: "이미 켜져 있습니다. 바꾸려면 먼저 끄세요." }, { status: 409 });
      const secret = newTotpSecret();
      updateUser(me, (u) => { u.totpPending = secret; });
      const uri = otpauthUri(secret, me === "owner" ? "admin" : me);
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
      return NextResponse.json({ secret, uri, qr });
    }
    if (b.action === "totp-enable") {
      const pending = getUser(me)?.totpPending;
      if (!pending) return NextResponse.json({ error: "먼저 'QR 코드 만들기'를 누르세요." }, { status: 400 });
      const k = verifyTotp(pending, String(b.code ?? ""));
      if (k === null) return NextResponse.json({ error: "코드가 맞지 않습니다. 휴대폰 시간이 자동으로 맞춰져 있는지 확인하고 새 코드로 다시 하세요." }, { status: 400 });
      updateUser(me, (u) => { u.totpSecret = pending; u.totpLastCounter = k; delete u.totpPending; });
      log("2fa-on");
      return NextResponse.json({ totpEnabled: true });
    }
    if (b.action === "totp-disable") {
      if (!totpEnabled(process.env, me)) return NextResponse.json({ totpEnabled: false });
      if (!checkTotp(String(b.code ?? ""), process.env, Date.now(), me)) return NextResponse.json({ error: "코드가 맞지 않습니다." }, { status: 400 });
      updateUser(me, (u) => { delete u.totpSecret; delete u.totpPending; delete u.totpLastCounter; });
      log("2fa-off");
      return NextResponse.json({ totpEnabled: false });
    }
    if (b.action === "logout-all") {
      logoutUser(me);
      log("logout-all");
      const s = issueSession(process.env, Date.now(), me);
      const res = NextResponse.json({ ok: true });
      res.headers.set("set-cookie", cookieHeader(req, s.value, s.maxAge));
      return res;
    }
    if (b.action?.startsWith("diag-") && me !== OWNER_ID) return NextResponse.json({ error: "점검 키는 owner 계정만 다룰 수 있습니다." }, { status: 403 });
    if (b.action === "diag-create") {
      const { token, view } = createDiagToken(String(b.name ?? ""), Number(b.days));
      log("diag-create");
      return NextResponse.json({ token, view });
    }
    if (b.action === "diag-revoke") {
      revokeDiagToken(String(b.id ?? ""));
      log("diag-revoke");
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
