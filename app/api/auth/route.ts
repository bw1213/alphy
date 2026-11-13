import { NextResponse } from "next/server";
import {
  checkPassword, checkTotp, clientIp, cookieHeader, isLoggedIn, issueSession, loginBlockedFor, MIN_PASSWORD,
  passwordConfigured, recordFail, resetFails, setPassword, totpEnabled,
} from "@/lib/settings/auth";
import { recordLogin } from "@/lib/settings/loginlog";
import { ensureSetupCode, envPassword, loadSettings } from "@/lib/settings/store";
import { timingSafeEqual, createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sha = (s: string) => createHash("sha256").update(s).digest();

/** 로그인 상태. setupNeeded 면 처음 설정 코드가 로그·파일에 만들어짐 */
export async function GET(req: Request) {
  const configured = passwordConfigured();
  if (!configured) ensureSetupCode();
  return NextResponse.json({
    setupNeeded: !configured,
    loggedIn: configured && isLoggedIn(req),
    passwordFromEnv: !!envPassword(),
    minPassword: MIN_PASSWORD,
    otpRequired: configured && totpEnabled(),
  });
}

function loggedInResponse(req: Request, body: unknown) {
  const s = issueSession();
  const res = NextResponse.json(body);
  res.headers.set("set-cookie", cookieHeader(req, s.value, s.maxAge));
  return res;
}

/**
 * { action: "login", password, otp? }           otp: 2단계 인증을 켰을 때 인증 앱의 6자리 코드
 * { action: "setup", code, password }            처음 한 번: 설정 코드 + 새 비밀번호
 * { action: "change", current, password }        비밀번호 바꾸기 (다른 기기 로그인은 풀림)
 */
export async function POST(req: Request) {
  let b: Record<string, string>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const ip = clientIp(req);
  const wait = loginBlockedFor(ip);
  if (wait > 0) { recordLogin(req, ip, "locked"); return NextResponse.json({ error: `비밀번호를 여러 번 틀려서 잠겼습니다. ${Math.ceil(wait / 60000)}분 뒤에 다시 하세요.` }, { status: 429 }); }
  const pw = String(b.password ?? "");
  try {
    if (b.action === "setup") {
      if (passwordConfigured()) return NextResponse.json({ error: "이미 비밀번호가 있습니다. 로그인하세요." }, { status: 409 });
      const want = ensureSetupCode() ?? loadSettings().auth.setupCode ?? "";
      const got = String(b.code ?? "").trim().toUpperCase();
      if (!want || !timingSafeEqual(sha(got), sha(want))) { recordFail(ip); recordLogin(req, ip, "fail"); return NextResponse.json({ error: "설정 코드가 틀렸습니다." }, { status: 401 }); }
      setPassword(pw);
      resetFails(ip);
      recordLogin(req, ip, "setup");
      return loggedInResponse(req, { ok: true });
    }
    if (b.action === "change") {
      if (envPassword()) return NextResponse.json({ error: "비밀번호가 환경변수(ADMIN_PASSWORD)로 고정돼 있어 화면에서 바꿀 수 없습니다." }, { status: 409 });
      if (!isLoggedIn(req)) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
      if (!checkPassword(String(b.current ?? ""))) { recordFail(ip); recordLogin(req, ip, "fail"); return NextResponse.json({ error: "현재 비밀번호가 틀렸습니다." }, { status: 401 }); }
      setPassword(pw);
      resetFails(ip);
      recordLogin(req, ip, "change");
      return loggedInResponse(req, { ok: true });
    }
    // login
    if (!passwordConfigured()) return NextResponse.json({ error: "관리자 비밀번호를 먼저 만드세요." }, { status: 403 });
    if (!checkPassword(pw)) { recordFail(ip); recordLogin(req, ip, "fail"); return NextResponse.json({ error: "비밀번호가 틀렸습니다." }, { status: 401 }); }
    // 비밀번호가 맞아도 2단계 코드가 틀리면 똑같이 실패 횟수에 넣음
    if (!checkTotp(String(b.otp ?? ""))) {
      recordFail(ip); recordLogin(req, ip, "otp-fail");
      return NextResponse.json({ error: "인증 앱 코드가 틀렸습니다. 휴대폰의 6자리 숫자를 넣으세요." }, { status: 401 });
    }
    resetFails(ip);
    recordLogin(req, ip, "login");
    return loggedInResponse(req, { ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const res = NextResponse.json({ ok: true });
  res.headers.set("set-cookie", cookieHeader(req, "", 0));
  return res;
}
