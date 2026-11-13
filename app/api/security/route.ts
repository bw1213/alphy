import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { checkTotp, clientIp, cookieHeader, issueSession, logoutAll, requireAdmin, totpEnabled } from "@/lib/settings/auth";
import { readLoginLog, recordLogin } from "@/lib/settings/loginlog";
import { loadSettings, updateSettings } from "@/lib/settings/store";
import { newTotpSecret, otpauthUri, verifyTotp } from "@/lib/settings/totp";
import { createDiagToken, listDiagTokens, revokeDiagToken } from "@/lib/settings/diag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 보안 상태: 2단계 인증 여부, 최근 로그인 기록, 점검 키 목록(원문 없음) */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return NextResponse.json({ totpEnabled: totpEnabled(), log: readLoginLog().slice(0, 30), you: clientIp(req), diagTokens: listDiagTokens() });
}

/**
 * { action: "totp-begin" }            새 키를 만들고 QR 코드 반환 (아직 켜지지 않음)
 * { action: "totp-enable", code }     인증 앱 코드로 확인되면 켬
 * { action: "totp-disable", code }    지금 코드로 확인되면 끔
 * { action: "logout-all" }            모든 기기 로그아웃 (이 기기는 새로 로그인 유지, 점검 키도 폐기)
 * { action: "diag-create", name, days } 읽기 전용 점검 키 발급 (원문은 이 응답에만)
 * { action: "diag-revoke", id }       점검 키 폐기
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let b: Record<string, string>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const ip = clientIp(req);
  try {
    if (b.action === "totp-begin") {
      if (totpEnabled()) return NextResponse.json({ error: "이미 켜져 있습니다. 바꾸려면 먼저 끄세요." }, { status: 409 });
      const secret = newTotpSecret();
      updateSettings((s) => { s.auth.totpPending = secret; });
      const uri = otpauthUri(secret);
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
      return NextResponse.json({ secret, uri, qr });
    }
    if (b.action === "totp-enable") {
      const pending = loadSettings().auth.totpPending;
      if (!pending) return NextResponse.json({ error: "먼저 'QR 코드 만들기'를 누르세요." }, { status: 400 });
      const k = verifyTotp(pending, String(b.code ?? ""));
      if (k === null) return NextResponse.json({ error: "코드가 맞지 않습니다. 휴대폰 시간이 자동으로 맞춰져 있는지 확인하고 새 코드로 다시 하세요." }, { status: 400 });
      updateSettings((s) => { s.auth.totpSecret = pending; s.auth.totpLastCounter = k; delete s.auth.totpPending; });
      recordLogin(req, ip, "2fa-on");
      return NextResponse.json({ totpEnabled: true });
    }
    if (b.action === "totp-disable") {
      if (!totpEnabled()) return NextResponse.json({ totpEnabled: false });
      if (!checkTotp(String(b.code ?? ""))) return NextResponse.json({ error: "코드가 맞지 않습니다." }, { status: 400 });
      updateSettings((s) => { delete s.auth.totpSecret; delete s.auth.totpPending; delete s.auth.totpLastCounter; });
      recordLogin(req, ip, "2fa-off");
      return NextResponse.json({ totpEnabled: false });
    }
    if (b.action === "logout-all") {
      logoutAll();
      recordLogin(req, ip, "logout-all");
      const s = issueSession();
      const res = NextResponse.json({ ok: true });
      res.headers.set("set-cookie", cookieHeader(req, s.value, s.maxAge));
      return res;
    }
    if (b.action === "diag-create") {
      const { token, view } = createDiagToken(String(b.name ?? ""), Number(b.days));
      recordLogin(req, ip, "diag-create");
      return NextResponse.json({ token, view });
    }
    if (b.action === "diag-revoke") {
      revokeDiagToken(String(b.id ?? ""));
      recordLogin(req, ip, "diag-revoke");
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
