/**
 * 관리자 로그인 (서버 전용). 설정 화면과 주문·잔고 API를 보호합니다.
 * - 비밀번호: 환경변수 ADMIN_PASSWORD(선택) 또는 화면에서 만든 비밀번호(scrypt 해시로 저장)
 * - 로그인하면 서명된 httpOnly 쿠키(30일). 비밀번호를 바꾸면 모든 기기의 로그인이 풀림
 * - 연속 5번 틀리면 10분간 로그인 차단
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import { clearSetupCode, envPassword, loadSettings, updateSettings } from "./store";

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = "alphy_session";
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 8;

const sha = (s: string) => createHash("sha256").update(s).digest();
const sameString = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyHash(pw: string, stored: string): boolean {
  const [alg, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = scryptSync(pw, Buffer.from(salt, "base64"), want.length);
  return timingSafeEqual(got, want);
}

export function passwordConfigured(e: Env = process.env): boolean {
  return !!envPassword(e) || !!loadSettings(e).auth.passwordHash;
}

export function checkPassword(pw: string, e: Env = process.env): boolean {
  const fixed = envPassword(e);
  if (fixed) return sameString(pw, fixed);
  const h = loadSettings(e).auth.passwordHash;
  return !!h && verifyHash(pw, h);
}

let memSecret: string | null = null;
/** 쿠키 서명 키. 설정 파일에 저장(없으면 만듦). 파일에 못 쓰면 메모리에만 */
function sessionSecret(e: Env): string {
  const s = loadSettings(e).auth.sessionSecret;
  if (s) return s;
  const fresh = randomBytes(32).toString("base64");
  try { updateSettings((x) => { x.auth.sessionSecret ??= fresh; }, e); return loadSettings(e).auth.sessionSecret ?? fresh; }
  catch { return (memSecret ??= fresh); }
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function issueSession(e: Env = process.env, now = Date.now()): { value: string; maxAge: number } {
  const exp = String(now + SESSION_DAYS * 864e5);
  return { value: `${exp}.${sign(sessionSecret(e), exp)}`, maxAge: SESSION_DAYS * 86400 };
}

export function verifySession(value: string | undefined, e: Env = process.env, now = Date.now()): boolean {
  if (!value || !passwordConfigured(e)) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !(Number(exp) > now)) return false;
  return sameString(sig, sign(sessionSecret(e), exp));
}

export function readCookie(req: Request, name = SESSION_COOKIE): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function isLoggedIn(req: Request, e: Env = process.env): boolean {
  return verifySession(readCookie(req), e);
}

/** 통과하면 null, 아니면 [상태코드, 메시지] */
export function requireAdmin(req: Request, e: Env = process.env): [number, string] | null {
  if (!passwordConfigured(e)) return [403, "관리자 비밀번호가 아직 없습니다. 설정 화면(/settings)에서 먼저 만드세요."];
  if (!isLoggedIn(req, e)) return [401, "로그인이 필요합니다. 설정 화면(/settings)에서 관리자 비밀번호로 로그인하세요."];
  return null;
}

export function cookieHeader(req: Request, value: string, maxAge: number): string {
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

// ── 로그인 시도 제한 (프로세스 메모리) ──
// 접속 주소(IP)별로 5번 틀리면 10분 잠금. 남이 계속 틀려도 내 로그인은 막히지 않는다.
// IP 는 헤더로 속일 수 있으므로, 전체 합계가 30번을 넘으면 모두 잠근다(무차별 대입 방지).
const MAX_FAILS = 5, MAX_FAILS_TOTAL = 30, WINDOW_MS = 10 * 60_000;
let fails: { t: number; ip: string }[] = [];

/** 프록시가 넣어 준 접속 주소. 없으면 모두 같은 주소로 취급 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (xff || req.headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}

export function loginBlockedFor(ip = "unknown", now = Date.now()): number {
  fails = fails.filter((f) => now - f.t < WINDOW_MS);
  if (fails.length >= MAX_FAILS_TOTAL) return WINDOW_MS - (now - fails[fails.length - MAX_FAILS_TOTAL].t);
  const mine = fails.filter((f) => f.ip === ip);
  return mine.length >= MAX_FAILS ? WINDOW_MS - (now - mine[mine.length - MAX_FAILS].t) : 0;
}
export function recordFail(ip = "unknown", now = Date.now()) { fails.push({ t: now, ip }); }
/** 로그인 성공: 그 주소의 실패 기록만 지움 (ip 를 안 주면 전부) */
export function resetFails(ip?: string) { fails = ip === undefined ? [] : fails.filter((f) => f.ip !== ip); }

/** 비밀번호 저장 (처음 설정 또는 변경). 서명 키도 바꿔서 기존 로그인을 모두 끊음 */
export function setPassword(pw: string, e: Env = process.env) {
  if (pw.length < MIN_PASSWORD) throw new Error(`비밀번호는 ${MIN_PASSWORD}자 이상으로 정하세요.`);
  updateSettings((s) => {
    s.auth.passwordHash = hashPassword(pw);
    s.auth.sessionSecret = randomBytes(32).toString("base64");
    delete s.auth.setupCode;
  }, e);
  clearSetupCode(e);
}
