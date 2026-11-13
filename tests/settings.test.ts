import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, runtimeEnv, saveSettings, updateSettings, ensureSetupCode, settingsPath } from "@/lib/settings/store";
import { checkPassword, hashPassword, issueSession, requireAdmin, setPassword, verifyHash, verifySession, SESSION_COOKIE } from "@/lib/settings/auth";
import { applyPatch, settingsView } from "@/lib/settings/view";
import { tradeCredentials, quoteCredentials } from "@/lib/kis/config";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const withCookie = (v?: string) => new Request("http://nas:3000/api/settings", { headers: v ? { cookie: `x=1; ${SESSION_COOKIE}=${encodeURIComponent(v)}` } : {} });

describe("settings store", () => {
  it("파일이 없으면 기본값, 저장하면 권한 600", () => {
    expect(loadSettings(env).kis.tradeEnv).toBe("mock");
    updateSettings((s) => { s.kis.mock.appKey = "mk"; }, env);
    expect(loadSettings(env).kis.mock.appKey).toBe("mk");
    expect(statSync(settingsPath(env)).mode & 0o777).toBe(0o600);
  });
  it("화면 값 위에 환경변수가 우선, 실전 잠금은 환경변수에서만", () => {
    updateSettings((s) => {
      s.kis.mock = { appKey: "file-key", appSecret: "file-secret", account: "50012345-01" };
      s.kis.tradeEnv = "real";
      (s as any).KIS_ALLOW_REAL_ORDERS = "yes"; // 파일에 넣어도 무시돼야 함
    }, env);
    const r = runtimeEnv(env);
    expect(r.KIS_MOCK_APP_KEY).toBe("file-key");
    expect(r.KIS_TRADE_ENV).toBe("real");
    expect(r.KIS_ALLOW_REAL_ORDERS).toBeUndefined();
    expect(runtimeEnv({ ...env, KIS_MOCK_APP_KEY: "env-key", KIS_TRADE_ENV: "mock" })).toMatchObject({ KIS_MOCK_APP_KEY: "env-key", KIS_TRADE_ENV: "mock" });
    // 빈 환경변수는 무시
    expect(runtimeEnv({ ...env, KIS_MOCK_APP_KEY: "" }).KIS_MOCK_APP_KEY).toBe("file-key");
  });
  it("화면에서 실전을 골라도 잠금 해제 환경변수 없이는 실전 주문 불가", () => {
    updateSettings((s) => {
      s.kis.real = { appKey: "rk", appSecret: "rs", account: "12345678-01" };
      s.kis.tradeEnv = "real";
    }, env);
    expect(() => tradeCredentials(runtimeEnv(env))).toThrow(/KIS_ALLOW_REAL_ORDERS/);
    expect(tradeCredentials(runtimeEnv({ ...env, KIS_ALLOW_REAL_ORDERS: "yes" })).env).toBe("real");
    expect(quoteCredentials(runtimeEnv(env))?.env).toBe("real");
  });
});

describe("settings view / patch", () => {
  it("보기에는 비밀값이 들어가지 않음", () => {
    updateSettings((s) => { s.kis.mock = { appKey: "PSabcdefgh1234", appSecret: "SUPERSECRET", account: "50012345-01" }; }, env);
    const v = settingsView(loadSettings(env), env);
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/SUPERSECRET|PSabcdefgh|50012345/);
    expect(v.kis.mock.appKey).toEqual({ set: true, fromEnv: false, hint: "…1234" });
    expect(v.kis.mock.account.hint).toBe("5001****-01");
    expect(v.kis.real.appKey.set).toBe(false);
    expect(settingsView(loadSettings(env), { ...env, KIS_REAL_APP_KEY: "zz99" }).kis.real.appKey).toMatchObject({ set: true, fromEnv: true });
  });
  it("보낸 항목만 바뀌고 빈 문자열은 지움, 잘못된 값은 거부", () => {
    const s0 = loadSettings(env);
    s0.kis.mock = { appKey: "a", appSecret: "b", account: "50012345-01" };
    const s1 = applyPatch(s0, { kis: { mock: { appSecret: "new" } } });
    expect(s1.kis.mock).toEqual({ appKey: "a", appSecret: "new", account: "50012345-01" });
    const s2 = applyPatch(s1, { kis: { mock: { appKey: "", appSecret: "", account: "" } } });
    expect(s2.kis.mock).toEqual({});
    expect(() => applyPatch(s0, { kis: { mock: { account: "123" } } })).toThrow(/계좌번호/);
    expect(() => applyPatch(s0, { kis: { tradeEnv: "prod" as any } })).toThrow();
    expect(() => applyPatch(s0, { backtest: { commission: -1 } })).toThrow(/수수료/);
    expect(applyPatch(s0, { backtest: { commission: 0.0140527, sellTax: null, source: "kis" } }).backtest).toMatchObject({ commission: 0.0140527, sellTax: null, source: "kis" });
    expect(s0.kis.mock.appSecret).toBe("b"); // 원본은 그대로
  });
});

describe("admin auth", () => {
  it("scrypt 해시", () => {
    const h = hashPassword("correct horse");
    expect(h).not.toContain("correct");
    expect(verifyHash("correct horse", h)).toBe(true);
    expect(verifyHash("wrong", h)).toBe(false);
  });
  it("처음엔 설정 코드가 생기고, 비밀번호를 만들면 사라짐", () => {
    expect(requireAdmin(withCookie(), env)?.[0]).toBe(403);
    const code = ensureSetupCode(env);
    expect(code).toMatch(/^[0-9A-F]{8}$/);
    expect(ensureSetupCode(env)).toBe(code); // 다시 불러도 같은 코드
    expect(readFileSync(path.join(dir, "setup-code.txt"), "utf8").trim()).toBe(code);
    expect(() => setPassword("short", env)).toThrow(/8자/);
    setPassword("long-password", env);
    expect(existsSync(path.join(dir, "setup-code.txt"))).toBe(false);
    expect(loadSettings(env).auth.setupCode).toBeUndefined();
    expect(checkPassword("long-password", env)).toBe(true);
    expect(checkPassword("nope-nope", env)).toBe(false);
  });
  it("세션 쿠키: 서명 확인, 만료, 비밀번호 바꾸면 무효", () => {
    setPassword("long-password", env);
    const s = issueSession(env);
    expect(requireAdmin(withCookie(s.value), env)).toBeNull();
    expect(requireAdmin(withCookie(), env)?.[0]).toBe(401);
    const [exp] = s.value.split(".");
    expect(verifySession(`${Number(exp) + 1000}.${s.value.split(".")[1]}`, env)).toBe(false); // 만료 시각 조작
    expect(verifySession(s.value, env, Number(exp) + 1)).toBe(false); // 만료
    setPassword("another-password", env);
    expect(verifySession(s.value, env)).toBe(false);
  });
  it("환경변수 ADMIN_PASSWORD(또는 예전 TRADE_API_TOKEN)가 있으면 그걸로", () => {
    const e2 = { ...env, TRADE_API_TOKEN: "legacy-token" };
    expect(ensureSetupCode(e2)).toBeNull();
    expect(checkPassword("legacy-token", e2)).toBe(true);
    expect(checkPassword("x", { ...env, ADMIN_PASSWORD: "admin-pass" })).toBe(false);
    expect(requireAdmin(withCookie(issueSession(e2).value), e2)).toBeNull();
  });
  it("깨진 설정 파일이면 기본값으로 동작", () => {
    saveSettings(loadSettings(env), env);
    require("fs").writeFileSync(settingsPath(env), "{not json");
    expect(loadSettings(env).kis.tradeEnv).toBe("mock");
  });
});

import { clientIp, loginBlockedFor, recordFail, resetFails } from "@/lib/settings/auth";
import { addUsage, checkOrderLimit, kstDate, usedToday } from "@/lib/kis/limits";

describe("로그인 잠금", () => {
  beforeEach(() => resetFails());
  it("틀린 주소만 잠기고 다른 주소는 로그인 가능", () => {
    const now = 1_000_000;
    for (let k = 0; k < 5; k++) recordFail("1.1.1.1", now + k);
    expect(loginBlockedFor("1.1.1.1", now + 10)).toBeGreaterThan(0);
    expect(loginBlockedFor("2.2.2.2", now + 10)).toBe(0);
    expect(loginBlockedFor("1.1.1.1", now + 11 * 60_000)).toBe(0); // 10분 뒤 풀림
  });
  it("주소를 바꿔 가며 틀려도 전체 30번이면 모두 잠김", () => {
    for (let k = 0; k < 30; k++) recordFail(`10.0.0.${k}`, 1000 + k);
    expect(loginBlockedFor("9.9.9.9", 2000)).toBeGreaterThan(0);
  });
  it("성공하면 그 주소 기록만 지움", () => {
    for (let k = 0; k < 5; k++) { recordFail("1.1.1.1", 1000); recordFail("2.2.2.2", 1000); }
    resetFails("1.1.1.1");
    expect(loginBlockedFor("1.1.1.1", 2000)).toBe(0);
    expect(loginBlockedFor("2.2.2.2", 2000)).toBeGreaterThan(0);
  });
  it("접속 주소: 프록시가 쓰는 x-real-ip, 없으면 x-forwarded-for 마지막 값 (앞쪽은 접속자가 속일 수 있음)", () => {
    expect(clientIp(new Request("http://nas/", { headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.7" } }))).toBe("203.0.113.7");
    expect(clientIp(new Request("http://nas/", { headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.7", "x-real-ip": "203.0.113.7" } }))).toBe("203.0.113.7");
    expect(clientIp(new Request("http://nas/"))).toBe("unknown");
  });
});

describe("실전 주문 금액 상한", () => {
  it("기본값이 있고 화면에서 바꿀 수 있음", () => {
    const s0 = loadSettings(env);
    expect(s0.kis.orderLimit).toEqual({ perOrder: 1_000_000, perDay: 5_000_000 });
    expect(applyPatch(s0, { kis: { orderLimit: { perOrder: 300000 } } }).kis.orderLimit).toEqual({ perOrder: 300000, perDay: 5_000_000 });
    expect(() => applyPatch(s0, { kis: { orderLimit: { perDay: -1 } } })).toThrow(/상한/);
    expect(settingsView(s0, env).orderLimit.perOrder).toBe(1_000_000);
  });
  it("1회·하루 상한을 넘으면 거부, 0 은 제한 없음", () => {
    const limit = { perOrder: 1_000_000, perDay: 2_000_000 };
    expect(() => checkOrderLimit(900_000, limit, 0)).not.toThrow();
    expect(() => checkOrderLimit(1_000_001, limit, 0)).toThrow(/1회 상한/);
    expect(() => checkOrderLimit(900_000, limit, 1_500_000)).toThrow(/하루 상한/);
    expect(() => checkOrderLimit(9e9, { perOrder: 0, perDay: 0 }, 9e9)).not.toThrow();
    expect(() => checkOrderLimit(0, limit, 0)).toThrow(/계산하지 못해/);
    expect(() => checkOrderLimit(NaN, limit, 0)).toThrow();
  });
  it("하루 합계는 한국 날짜가 바뀌면 0부터", () => {
    const t = Date.parse("2026-11-10T05:00:00Z"); // 한국 14시
    expect(kstDate(Date.parse("2026-11-10T15:30:00Z"))).toBe("2026-11-11");
    expect(addUsage(400_000, env, t)).toBe(400_000);
    expect(addUsage(100_000, env, t)).toBe(500_000);
    expect(usedToday(env, t)).toBe(500_000);
    expect(usedToday(env, t + 24 * 3600_000)).toBe(0);
  });
});
