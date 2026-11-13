import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createDiagToken, findDiagToken, listDiagTokens, revokeDiagToken, MAX_DIAG_TOKENS } from "@/lib/settings/diag";
import { logoutAll, setPassword, issueSession, SESSION_COOKIE } from "@/lib/settings/auth";
import { loadSettings, updateSettings } from "@/lib/settings/store";
import { middleware } from "@/middleware";
import { GET as diagGet } from "@/app/api/diag/route";
import { backtestReport, barsReport, dataReport, overview, prepareStrategy } from "@/lib/diag/report";
import { syntheticData } from "@/lib/data/synthetic";
import { defaultCycleSpec } from "@/lib/strategies/cycle";
import type { DataRequest } from "@/lib/data/server";

let dir: string;
let env: Record<string, string | undefined>;
const saved = process.env.ALPHY_CONFIG_DIR;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-diag-")); env = { ALPHY_CONFIG_DIR: dir }; process.env.ALPHY_CONFIG_DIR = dir; });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ALPHY_CONFIG_DIR; else process.env.ALPHY_CONFIG_DIR = saved;
});

describe("점검 키", () => {
  it("원문은 한 번만, 저장은 해시만", () => {
    const { token, view } = createDiagToken("Claude", 7, env);
    expect(token).toMatch(/^alphy_diag_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(loadSettings(env))).not.toContain(token);
    expect(findDiagToken(token, env)?.id).toBe(view.id);
    expect(findDiagToken(token + "x", env)).toBeNull();
    expect(JSON.stringify(listDiagTokens(env))).not.toContain("hash");
  });
  it("만료·폐기되면 안 됨", () => {
    const now = 1_700_000_000_000;
    const a = createDiagToken("a", 1, env, now);
    expect(findDiagToken(a.token, env, now + 864e5 - 1)).not.toBeNull();
    expect(findDiagToken(a.token, env, now + 864e5 + 1)).toBeNull();
    const b = createDiagToken("b", 7, env);
    revokeDiagToken(b.view.id, env);
    expect(findDiagToken(b.token, env)).toBeNull();
  });
  it("기간은 1·7·30일만, 개수 제한", () => {
    expect(() => createDiagToken("x", 365, env)).toThrow();
    for (let i = 0; i < MAX_DIAG_TOKENS; i++) createDiagToken(`k${i}`, 1, env);
    expect(() => createDiagToken("over", 1, env)).toThrow(/까지/);
  });
  it("비밀번호 변경·모든 기기 로그아웃 때 모두 폐기", () => {
    setPassword("long-password", env);
    const a = createDiagToken("a", 7, env);
    logoutAll(env);
    expect(findDiagToken(a.token, env)).toBeNull();
    const b = createDiagToken("b", 7, env);
    setPassword("another-password", env);
    expect(findDiagToken(b.token, env)).toBeNull();
  });
});

describe("점검 키는 점검 API 에서만 통함 (middleware)", () => {
  const req = (p: string, token?: string) => new NextRequest(`https://alphy.example${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";
  it("점검 API 는 열리고 나머지는 그대로 잠김", () => {
    setPassword("long-password", env);
    const { token } = createDiagToken("c", 1, env);
    expect(passes(middleware(req("/api/diag", token)))).toBe(true);
    expect(passes(middleware(req("/api/diag/data?tickers=069500", token)))).toBe(true);
    expect(passes(middleware(req("/api/diag/backtest", token)))).toBe(true);
    for (const p of ["/", "/settings", "/api/settings", "/api/security", "/api/kis/order", "/api/kis/balance", "/api/strategies", "/api/data", "/api/diagx"]) {
      expect(passes(middleware(req(p, token)))).toBe(false);
    }
    expect(middleware(req("/api/diag")).status).toBe(401);
    expect(middleware(req("/api/diag", "alphy_diag_wrong")).status).toBe(401);
  });
  it("쿠키로 보내도 로그인으로 인정하지 않음", () => {
    setPassword("long-password", env);
    const { token } = createDiagToken("c", 1, env);
    const r = new NextRequest("https://alphy.example/api/settings", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(middleware(r).status).toBe(401);
  });
  it("라우트도 다시 확인: 키 있으면 200, 없으면 401, 로그인 쿠키도 됨", async () => {
    setPassword("long-password", env);
    const { token, view } = createDiagToken("c", 1, env);
    const ok = diagGet(new Request("https://alphy.example/api/diag", { headers: { authorization: `Bearer ${token}`, "x-real-ip": "1.2.3.4" } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).access).toMatchObject({ via: "token", id: view.id });
    expect(listDiagTokens(env)[0]).toMatchObject({ lastIp: "1.2.3.4" });
    expect(diagGet(new Request("https://alphy.example/api/diag")).status).toBe(401);
    const s = issueSession(env);
    expect(diagGet(new Request("https://alphy.example/api/diag", { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(s.value)}` } })).status).toBe(200);
  });
});

describe("점검 내용", () => {
  it("개요에 비밀값이 없음", () => {
    setPassword("long-password", env);
    const { token } = createDiagToken("c", 1, env);
    updateSettings((s) => {
      s.kis.real = { appKey: "REALKEY-SECRET-1234", appSecret: "REALSECRET-abcdef", account: "12345678-01" };
      s.auth.totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    }, env);
    const o = overview(env);
    const text = JSON.stringify(o);
    const st = loadSettings(env);
    for (const secret of ["REALKEY-SECRET-1234", "REALSECRET-abcdef", "12345678", token, st.auth.passwordHash!, st.auth.sessionSecret!, st.auth.totpSecret!, st.auth.diagTokens![0].hash]) {
      expect(text).not.toContain(secret);
    }
    expect(o.settings.kis.real).toEqual({ appKey: true, appSecret: true, account: true });
    expect(o.settings.totpEnabled).toBe(true);
  });

  it("직접 작성한 코드 전략은 서버에서 실행하지 않음", () => {
    writeFileSync(path.join(dir, "strategies.json"), JSON.stringify([
      { name: "내코드", code: "return {};", params: "{}", rebalance: "M", stopLoss: "", takeProfit: "", warmup: 0 },
      { name: "적립", code: "return lib.cycle(ctx, p);", params: "{}", rebalance: "D", stopLoss: "", takeProfit: "", warmup: 2, cycle: defaultCycleSpec() },
    ]));
    expect(() => prepareStrategy({ strategy: "내코드" }, env)).toThrow(/서버에서 실행하지 않습니다/);
    expect(prepareStrategy({ strategy: "적립" }, env).kind).toBe("cycle");
    expect(prepareStrategy({ strategy: "momentum" }, env).kind).toBe("builtin");
    expect(() => prepareStrategy({ strategy: "없는거" }, env)).toThrow();
    expect(overview(env).strategies.map((s) => [s.name, s.runnableOnServer])).toEqual([["내코드", false], ["적립", true]]);
  });

  const fakeLoad = async (r: DataRequest) => {
    const n = r.tickers?.length || 3;
    const d = syntheticData(n, r.start, r.end);
    // 종목코드를 요청한 코드로 바꿈
    const codes = Object.keys(d.data);
    const data: typeof d.data = {}, names: Record<string, string> = {};
    codes.forEach((c, i) => { const t = r.tickers?.[i] ?? c; data[t] = d.data[c]; names[t] = t; });
    return { data, names, benchmark: d.benchmark, warnings: [] };
  };

  it("백테스트 재현: 적립·분할 매도", async () => {
    const out = await backtestReport({ cycle: defaultCycleSpec(), tickers: ["069500"], start: "2023-01-02", end: "2024-12-30", source: "synthetic" }, env, fakeLoad);
    expect(out.request.kind).toBe("cycle");
    expect(out.summary.nTrades).toBeGreaterThan(0);
    expect(out.cycleStatus[0].ticker).toBe("069500");
    expect(out.monthlyEquity.length).toBeGreaterThan(20);
    await expect(backtestReport({ cycle: defaultCycleSpec(), start: "2023-01-02", end: "2024-12-30" }, env, fakeLoad)).rejects.toThrow(/tickers/);
  });

  it("시세 범위·빈 구간", async () => {
    const bars = [
      { date: "2025-11-17", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { date: "2025-11-18", open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { date: "2025-12-01", open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const r = barsReport(bars);
    expect(r).toMatchObject({ count: 3, first: "2025-11-17", last: "2025-12-01", zeroVolume: 1 });
    expect(r.gaps).toEqual([{ from: "2025-11-18", to: "2025-12-01", days: 13 }]);
    const d = await dataReport({ tickers: "069500, bad", start: "2024-01-01", end: "2024-06-30", source: "synthetic" }, fakeLoad);
    expect(d.request.tickers).toEqual(["069500"]);
    expect(d.tickers["069500"]).toMatchObject({ first: expect.any(String) });
    await expect(dataReport({ tickers: "" }, fakeLoad)).rejects.toThrow();
  });
});
