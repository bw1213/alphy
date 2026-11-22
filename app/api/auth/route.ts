import { NextResponse } from "next/server";
import {
  checkPassword, checkTotp, clientIp, cookieHeader, currentUser, hashPassword, issueSession, loginBlockedFor, loginId, MIN_PASSWORD,
  passwordConfigured, recordFail, resetFails, setPassword, totpEnabled,
} from "@/lib/settings/auth";
import { recordLogin, type LoginEvent } from "@/lib/settings/loginlog";
import { ensureSetupCode, loadSettings } from "@/lib/settings/store";
import { OWNER_ID } from "@/lib/settings/userdir";
import { acceptInvite, checkInvite, getUser, listUsers } from "@/lib/settings/users";
import { timingSafeEqual, createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sha = (s: string) => createHash("sha256").update(s).digest();

/**
 * 로그인 상태. setupNeeded 면 처음 설정 코드가 로그·파일에 만들어짐.
 * ?invite=코드 를 붙이면 초대가 살아 있는지도 알려 줌 (가입 화면용)
 */
export async function GET(req: Request) {
  const configured = passwordConfigured();
  if (!configured) ensureSetupCode();
  const me = configured ? currentUser(req) : null;
  const users = configured ? listUsers() : [];
  const invite = new URL(req.url).searchParams.get("invite");
  return NextResponse.json({
    setupNeeded: !configured,
    loggedIn: !!me,
    minPassword: MIN_PASSWORD,
    // 혼자 쓸 때는 예전처럼 비밀번호만 물음. 2단계 인증 코드는 비밀번호가 맞은 뒤에 물음(POST 의 otpNeeded)
    multiUser: users.length > 1,
    otpRequired: configured && (users.length > 1 ? users.some((u) => u.totpSecret) : totpEnabled()),
    user: me ? { id: me.id, name: me.name, role: me.role, owner: me.id === OWNER_ID } : null,
    ...(invite !== null ? { invite: (() => { const v = checkInvite(invite); return v ? { name: v.name, expiresAt: v.expiresAt } : null; })() } : {}),
  }, { headers: { "Cache-Control": "no-store" } });
}

function loggedInResponse(req: Request, user: string, body: unknown) {
  const s = issueSession(process.env, Date.now(), user);
  const res = NextResponse.json(body);
  res.headers.set("set-cookie", cookieHeader(req, s.value, s.maxAge));
  return res;
}

/**
 * { action: "login", id?, password, otp? }      id 를 비우면 owner. 2단계 인증을 켠 사람이 otp 없이 보내면 401 { otpNeeded: true }
 * { action: "setup", code, password }            처음 한 번: 설정 코드 + 새 비밀번호 (owner 계정이 됨)
 * { action: "join", invite, id, name, password } 초대 링크로 가입
 * { action: "change", current, password }        내 비밀번호 바꾸기 (내 다른 기기 로그인은 풀림)
 */
export async function POST(req: Request) {
  let b: Record<string, string>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const ip = clientIp(req);
  const account = b.action === "login" ? loginId(b.id) : undefined;
  const log = (event: LoginEvent, user?: string) => recordLogin(req, ip, event, process.env, Date.now(), user);
  const wait = loginBlockedFor(ip, Date.now(), account);
  if (wait > 0) { log("locked", account); return NextResponse.json({ error: `여러 번 틀려서 잠겼습니다. ${Math.ceil(wait / 60000)}분 뒤에 다시 하세요.` }, { status: 429 }); }
  const pw = String(b.password ?? "");
  try {
    if (b.action === "setup") {
      if (passwordConfigured()) return NextResponse.json({ error: "이미 비밀번호가 있습니다. 로그인하세요." }, { status: 409 });
      const want = ensureSetupCode() ?? loadSettings().auth.setupCode ?? "";
      const got = String(b.code ?? "").trim().toUpperCase();
      if (!want || !timingSafeEqual(sha(got), sha(want))) { recordFail(ip); log("fail"); return NextResponse.json({ error: "설정 코드가 틀렸습니다." }, { status: 401 }); }
      setPassword(pw);
      resetFails(ip);
      log("setup", OWNER_ID);
      return loggedInResponse(req, OWNER_ID, { ok: true });
    }
    if (b.action === "join") {
      if (!passwordConfigured()) return NextResponse.json({ error: "아직 쓸 수 없습니다." }, { status: 403 });
      if (pw.length < MIN_PASSWORD) return NextResponse.json({ error: `비밀번호는 ${MIN_PASSWORD}자 이상으로 정하세요.` }, { status: 400 });
      const code = String(b.invite ?? "");
      if (!checkInvite(code)) { recordFail(ip); log("fail"); return NextResponse.json({ error: "초대 링크가 없거나 만료됐습니다. 관리자에게 새로 받아 주세요." }, { status: 401 }); }
      const u = acceptInvite(code, String(b.id ?? ""), String(b.name ?? ""), hashPassword(pw));
      resetFails(ip);
      log("join", u.id);
      return loggedInResponse(req, u.id, { ok: true });
    }
    if (b.action === "change") {
      const me = currentUser(req);
      if (!me) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
      if (!checkPassword(String(b.current ?? ""), process.env, me.id)) { recordFail(ip); log("fail", me.id); return NextResponse.json({ error: "현재 비밀번호가 틀렸습니다." }, { status: 401 }); }
      setPassword(pw, process.env, me.id);
      resetFails(ip);
      log("change", me.id);
      return loggedInResponse(req, me.id, { ok: true });
    }
    // login
    if (!passwordConfigured()) return NextResponse.json({ error: "관리자 비밀번호를 먼저 만드세요." }, { status: 403 });
    const id = account!;
    // 아이디가 있는지 알려 주지 않도록 같은 문구
    const bad = () => NextResponse.json({ error: listUsers().length > 1 ? "아이디 또는 비밀번호가 틀렸습니다." : "비밀번호가 틀렸습니다." }, { status: 401 });
    if (!checkPassword(pw, process.env, id)) { recordFail(ip, Date.now(), id); log("fail", id); return bad(); }
    const u = getUser(id);
    if (!u || u.disabled) { recordFail(ip, Date.now(), id); log("fail", id); return bad(); }
    // 2단계 인증을 켠 사람은 비밀번호가 맞은 뒤에 코드를 물음 (화면이 같은 비밀번호에 코드를 붙여 다시 보냄)
    const otp = String(b.otp ?? "").trim();
    if (!otp && totpEnabled(process.env, id)) return NextResponse.json({ otpNeeded: true }, { status: 401 });
    // 비밀번호가 맞아도 2단계 코드가 틀리면 똑같이 실패 횟수에 넣음
    if (!checkTotp(otp, process.env, Date.now(), id)) {
      recordFail(ip, Date.now(), id); log("otp-fail", id);
      return NextResponse.json({ error: "인증 앱 코드가 틀렸습니다. 휴대폰의 6자리 숫자를 넣으세요." }, { status: 401 });
    }
    resetFails(ip, id);
    log("login", id);
    return loggedInResponse(req, id, { ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const res = NextResponse.json({ ok: true });
  res.headers.set("set-cookie", cookieHeader(req, "", 0));
  return res;
}
