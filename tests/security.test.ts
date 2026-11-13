import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUri, totpNow, verifyTotp } from "@/lib/settings/totp";
import { checkTotp, issueSession, logoutAll, setPassword, totpEnabled, verifySession, SESSION_COOKIE } from "@/lib/settings/auth";
import { loadSettings, updateSettings } from "@/lib/settings/store";
import { readLoginLog, recordLogin } from "@/lib/settings/loginlog";
import { middleware } from "@/middleware";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-sec-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 부록 B 의 SHA1 시험값 (키 "12345678901234567890", 8자리 중 끝 6자리)
  const rfcKey = base32Encode(Buffer.from("12345678901234567890"));
  it("RFC 시험값과 같음", () => {
    expect(totpNow(rfcKey, 59_000)).toBe("287082");
    expect(totpNow(rfcKey, 1111111109_000)).toBe("081804");
    expect(totpNow(rfcKey, 1234567890_000)).toBe("005924");
    expect(totpNow(rfcKey, 2000000000_000)).toBe("279037");
  });
  it("base32 왕복", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });
  it("앞뒤 30초 허용, 그 밖·재사용은 거부", () => {
    const s = newTotpSecret(), now = 1_700_000_000_000, t = Math.floor(now / 30000);
    expect(verifyTotp(s, hotp(s, t), now)).toBe(t);
    expect(verifyTotp(s, hotp(s, t - 1), now)).toBe(t - 1);
    expect(verifyTotp(s, hotp(s, t - 3), now)).toBeNull();
    expect(verifyTotp(s, hotp(s, t), now, t)).toBeNull(); // 이미 쓴 코드
    expect(verifyTotp(s, "12345", now)).toBeNull();
  });
  it("otpauth 주소", () => {
    expect(otpauthUri("ABC")).toContain("otpauth://totp/");
    expect(otpauthUri("ABC")).toContain("secret=ABC");
  });
});

describe("2단계 인증 로그인", () => {
  it("꺼져 있으면 통과, 켜면 코드 필요, 같은 코드 두 번은 안 됨", () => {
    expect(checkTotp(undefined, env)).toBe(true);
    const secret = newTotpSecret();
    updateSettings((s) => { s.auth.totpSecret = secret; }, env);
    const now = Date.now();
    expect(checkTotp("000000", env, now) && totpNow(secret, now) !== "000000").toBe(false);
    const code = totpNow(secret, now);
    expect(checkTotp(code, env, now)).toBe(true);
    expect(checkTotp(code, env, now)).toBe(false);
  });
  it("disable-2fa.txt 를 올리면 꺼지고 파일은 지워짐", () => {
    updateSettings((s) => { s.auth.totpSecret = newTotpSecret(); }, env);
    expect(totpEnabled(env)).toBe(true);
    writeFileSync(path.join(dir, "disable-2fa.txt"), "");
    expect(totpEnabled(env)).toBe(false);
    expect(existsSync(path.join(dir, "disable-2fa.txt"))).toBe(false);
    expect(loadSettings(env).auth.totpSecret).toBeUndefined();
  });
  it("모든 기기 로그아웃이면 기존 쿠키 무효", () => {
    setPassword("long-password", env);
    const s = issueSession(env);
    expect(verifySession(s.value, env)).toBe(true);
    logoutAll(env);
    expect(verifySession(s.value, env)).toBe(false);
  });
  it("로그인 기록은 최근 것부터, 100건까지", () => {
    const req = new Request("http://x/", { headers: { "user-agent": "UA" } });
    for (let k = 0; k < 105; k++) recordLogin(req, `1.1.1.${k}`, k % 2 ? "fail" : "login", env, 1000 + k);
    const log = readLoginLog(env);
    expect(log.length).toBe(100);
    expect(log[0].ip).toBe("1.1.1.104");
  });
});

describe("앱 전체 로그인 잠금 (middleware)", () => {
  const saved = process.env.ALPHY_CONFIG_DIR;
  beforeEach(() => { process.env.ALPHY_CONFIG_DIR = dir; });
  afterEach(() => { if (saved === undefined) delete process.env.ALPHY_CONFIG_DIR; else process.env.ALPHY_CONFIG_DIR = saved; });
  const req = (p: string, cookie?: string) => new NextRequest(`http://localhost:3000${p}`, { headers: cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {} });

  const isLogin = (r: Response) => new URL(r.headers.get("x-middleware-rewrite") ?? "http://x/none").pathname === "/login";
  it("로그인 전: 화면은 로그인 화면으로 바뀌고, API 는 401, 로그인·상태 확인은 열림", async () => {
    setPassword("long-password", env);
    expect(isLogin(middleware(req("/trade?x=1")))).toBe(true);
    const api = middleware(req("/api/data"));
    expect(api.status).toBe(401);
    for (const p of ["/login", "/api/auth", "/api/health", "/robots.txt"]) {
      expect(middleware(req(p)).headers.get("x-middleware-next")).toBe("1");
    }
  });
  it("비밀번호를 만들기 전에도 잠겨 있음", () => {
    expect(isLogin(middleware(req("/")))).toBe(true);
    expect(middleware(req("/api/settings")).status).toBe(401);
  });
  it("로그인하면 열림, 위조 쿠키는 안 됨", () => {
    setPassword("long-password", env);
    const s = issueSession(env);
    expect(middleware(req("/", s.value)).headers.get("x-middleware-next")).toBe("1");
    expect(middleware(req("/api/kis/order", s.value)).headers.get("x-middleware-next")).toBe("1");
    expect(isLogin(middleware(req("/", `${Date.now() + 1e9}.forged`)))).toBe(true);
  });
});
