/**
 * 로그인 (서버 전용). 사람마다 계정(lib/settings/users.ts)이 있고, 로그인 쿠키에 누구인지가 서명돼 들어갑니다.
 * - 비밀번호: scrypt 해시
 * - 로그인하면 서명된 httpOnly 쿠키(30일): "사용자.세션버전.만료.서명"
 *   비밀번호를 바꾸거나 "모든 기기 로그아웃"을 누르면 그 사람의 세션버전만 바뀌어 그 사람 로그인만 풀림
 * - 같은 주소(IP)에서 5번, 또는 같은 아이디로 5번 틀리면 10분간 로그인 차단
 * - 2단계 인증(선택): 사람마다 따로 (lib/settings/totp.ts)
 * - 역할: admin(사용자 초대·점검 키·종목 목록) / member. owner 는 한국투자증권 키·서버 설정까지(3단계 전까지)
 * - 앱 전체가 로그인 뒤에 있음 (middleware.ts)
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import fs from "fs";
import path from "path";
import { clearSetupCode, configDir, loadSettings, updateSettings } from "./store";
import { verifyTotp } from "./totp";
import { OWNER_ID } from "./userdir";
import { ensureOwner, getUser, listUsers, rotateSession, updateUser, type User } from "./users";

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

/** 관리자(owner) 비밀번호가 정해졌는지. 아니면 처음 설치 상태 */
export function passwordConfigured(e: Env = process.env): boolean {
  return !!getUser(OWNER_ID, e)?.passwordHash;
}

/** 아이디 정리: 비우면 owner (예전처럼 비밀번호만 넣고 로그인) */
export const loginId = (v: unknown) => String(v ?? "").trim().toLowerCase() || OWNER_ID;

// 없는 아이디도 비슷한 시간이 걸리게 (아이디가 있는지 알아내기 어렵게)
const DUMMY_HASH = hashPassword(randomBytes(8).toString("hex"));

export function checkPassword(pw: string, e: Env = process.env, user: string = OWNER_ID): boolean {
  const u = getUser(user, e);
  if (!u?.passwordHash || u.disabled) { verifyHash(pw, DUMMY_HASH); return false; }
  return verifyHash(pw, u.passwordHash);
}

let memSecret: string | null = null;
/** 쿠키 서명 키(서버 공용). 설정 파일에 저장(없으면 만듦). 파일에 못 쓰면 메모리에만 */
function sessionSecret(e: Env): string {
  const s = loadSettings(e).auth.sessionSecret;
  if (s) return s;
  const fresh = randomBytes(32).toString("base64");
  try { updateSettings((x) => { x.auth.sessionSecret ??= fresh; }, e); return loadSettings(e).auth.sessionSecret ?? fresh; }
  catch { return (memSecret ??= fresh); }
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function issueSession(e: Env = process.env, now = Date.now(), user: string = OWNER_ID): { value: string; maxAge: number } {
  const u = getUser(user, e) ?? (user === OWNER_ID ? ensureOwner(e) : undefined);
  if (!u) throw new Error("없는 사용자입니다.");
  const payload = `${u.id}.${u.sessionVersion}.${now + SESSION_DAYS * 864e5}`;
  return { value: `${payload}.${sign(sessionSecret(e), payload)}`, maxAge: SESSION_DAYS * 86400 };
}

/** 쿠키 값 → 사용자 (서명·만료·세션버전·정지 여부 확인). 아니면 null */
export function sessionUser(value: string | undefined, e: Env = process.env, now = Date.now()): User | null {
  if (!value || !passwordConfigured(e)) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!(Number(exp) > now)) return null;
  if (!sameString(sig, sign(sessionSecret(e), `${id}.${ver}.${exp}`))) return null;
  const u = getUser(id, e);
  if (!u || u.disabled || !sameString(u.sessionVersion, ver)) return null;
  if (u.id !== OWNER_ID && !u.passwordHash) return null;
  return u;
}

export function verifySession(value: string | undefined, e: Env = process.env, now = Date.now()): boolean {
  return !!sessionUser(value, e, now);
}

export function readCookie(req: Request, name = SESSION_COOKIE): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function currentUser(req: Request, e: Env = process.env): User | null {
  return sessionUser(readCookie(req), e);
}

export function isLoggedIn(req: Request, e: Env = process.env): boolean {
  return !!currentUser(req, e);
}

type Denied = [number, string];
type Gate = { user: User; denied: null } | { user: null; denied: Denied };

function gate(req: Request, e: Env, allow: (u: User) => boolean, why: string): Gate {
  if (!passwordConfigured(e)) return { user: null, denied: [403, "관리자 비밀번호가 아직 없습니다. 설정 화면(/settings)에서 먼저 만드세요."] };
  const u = currentUser(req, e);
  if (!u) return { user: null, denied: [401, "로그인이 필요합니다. 다시 로그인하세요."] };
  if (!allow(u)) return { user: null, denied: [403, why] };
  return { user: u, denied: null };
}

/** 로그인한 누구나. 통과하면 user, 아니면 denied */
export const requireUser = (req: Request, e: Env = process.env) => gate(req, e, () => true, "");
/** 관리자 역할만 */
export const requireAdminUser = (req: Request, e: Env = process.env) => gate(req, e, (u) => u.role === "admin", "관리자만 할 수 있습니다.");
/** owner 계정만: 한국투자증권 키·계좌·주문과 서버 설정 (사람별 증권 계좌는 다음 단계) */
export const requireOwner = (req: Request, e: Env = process.env) =>
  gate(req, e, (u) => u.id === OWNER_ID, "한국투자증권 계좌·주문과 서버 설정은 아직 관리자(owner) 계정만 쓸 수 있습니다.");

/** 예전 이름: 관리자 역할 확인. 통과하면 null, 아니면 [상태코드, 메시지] */
export function requireAdmin(req: Request, e: Env = process.env): Denied | null {
  return requireAdminUser(req, e).denied;
}

export function cookieHeader(req: Request, value: string, maxAge: number): string {
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

// ── 로그인 시도 제한 (프로세스 메모리) ──
// 접속 주소(IP)별로, 또 아이디별로 5번 틀리면 10분 잠금. 남이 계속 틀려도 내 로그인은 막히지 않는다.
// IP 는 헤더로 속일 수 있으므로, 전체 합계가 30번을 넘으면 모두 잠근다(무차별 대입 방지).
const MAX_FAILS = 5, MAX_FAILS_TOTAL = 30, WINDOW_MS = 10 * 60_000;
let fails: { t: number; ip: string; account?: string }[] = [];

/**
 * 프록시(DSM 역방향 프록시)가 넣어 준 접속 주소. 없으면 모두 같은 주소로 취급.
 * x-forwarded-for 의 앞쪽 값은 접속자가 마음대로 써 보낼 수 있으므로,
 * 프록시가 덮어쓰는 x-real-ip 를 먼저 보고, 없으면 x-forwarded-for 의 마지막 값(프록시가 붙인 값)을 씁니다.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  const xff = req.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean).pop();
  return (real || xff || "unknown").slice(0, 64);
}

export function loginBlockedFor(ip = "unknown", now = Date.now(), account?: string): number {
  fails = fails.filter((f) => now - f.t < WINDOW_MS);
  if (fails.length >= MAX_FAILS_TOTAL) return WINDOW_MS - (now - fails[fails.length - MAX_FAILS_TOTAL].t);
  const left = (list: typeof fails) => (list.length >= MAX_FAILS ? WINDOW_MS - (now - list[list.length - MAX_FAILS].t) : 0);
  return Math.max(left(fails.filter((f) => f.ip === ip)), account ? left(fails.filter((f) => f.account === account)) : 0);
}
export function recordFail(ip = "unknown", now = Date.now(), account?: string) { fails.push({ t: now, ip, account }); }
/** 로그인 성공: 그 주소·아이디의 실패 기록만 지움 (ip 를 안 주면 전부) */
export function resetFails(ip?: string, account?: string) { fails = ip === undefined ? [] : fails.filter((f) => f.ip !== ip && (!account || f.account !== account)); }

/**
 * 비밀번호 저장 (처음 설정 또는 변경). 그 사람의 기존 로그인을 모두 끊음.
 * owner 면 점검 키도 모두 폐기 (예전과 같음)
 */
export function setPassword(pw: string, e: Env = process.env, user: string = OWNER_ID) {
  if (pw.length < MIN_PASSWORD) throw new Error(`비밀번호는 ${MIN_PASSWORD}자 이상으로 정하세요.`);
  if (user === OWNER_ID) ensureOwner(e);
  updateUser(user, (u) => { u.passwordHash = hashPassword(pw); u.sessionVersion = randomBytes(9).toString("base64url"); }, e);
  if (user === OWNER_ID) {
    updateSettings((s) => { delete s.auth.setupCode; delete s.auth.diagTokens; }, e);
    clearSetupCode(e);
  }
}

/** 그 사람의 모든 기기 로그아웃 (owner 면 점검 키도 폐기) */
export function logoutUser(user: string, e: Env = process.env) {
  rotateSession(user, e);
  if (user === OWNER_ID) updateSettings((s) => { delete s.auth.diagTokens; }, e);
}

/** 모든 사람 모든 기기 로그아웃: 쿠키 서명 키를 바꿔서 지금까지 발급한 로그인을 모두 무효로. 점검 키도 모두 폐기 */
export function logoutAll(e: Env = process.env) {
  updateSettings((s) => { s.auth.sessionSecret = randomBytes(32).toString("base64"); delete s.auth.diagTokens; }, e);
}

// ── 2단계 인증 ──

/**
 * 휴대폰을 잃어버렸을 때: NAS 의 설정 폴더(nas/cache/config)에 disable-2fa 또는 disable-2fa.txt 파일을
 * 올리면 다음 접속 때 2단계 인증이 꺼지고 파일은 지워집니다. (NAS 파일에 손댈 수 있는 사람만 가능)
 */
const DISABLE_FILES = ["disable-2fa", "disable-2fa.txt"];
function consumeDisableFile(e: Env) {
  for (const name of DISABLE_FILES) {
    const f = path.join(configDir(e), name);
    if (!fs.existsSync(f)) continue;
    try {
      if (getUser(OWNER_ID, e)) updateUser(OWNER_ID, (u) => { delete u.totpSecret; delete u.totpPending; delete u.totpLastCounter; }, e);
      fs.unlinkSync(f);
      console.log(`[alphy] ${name} 파일이 있어서 owner 계정의 2단계 인증을 껐습니다.`);
    } catch (err) {
      console.error(`[alphy] 2단계 인증 끄기 실패: ${(err as Error).message}`);
    }
  }
}

export function totpEnabled(e: Env = process.env, user: string = OWNER_ID): boolean {
  if (user === OWNER_ID) consumeDisableFile(e);
  return !!getUser(user, e)?.totpSecret;
}

/** 2단계 인증 코드 확인 (꺼져 있으면 항상 통과). 맞으면 같은 코드를 다시 못 쓰게 기록 */
export function checkTotp(code: string | undefined, e: Env = process.env, now = Date.now(), user: string = OWNER_ID): boolean {
  if (!totpEnabled(e, user)) return true;
  const u = getUser(user, e)!;
  const k = verifyTotp(u.totpSecret!, code ?? "", now, u.totpLastCounter ?? -1);
  if (k === null) return false;
  updateUser(user, (x) => { x.totpLastCounter = k; }, e);
  return true;
}

/** 관리자 화면용: 2단계 인증을 켠 사람 수 */
export const totpCount = (e: Env = process.env) => listUsers(e).filter((u) => u.totpSecret).length;
