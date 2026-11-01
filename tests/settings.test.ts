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
