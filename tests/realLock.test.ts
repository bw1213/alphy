import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSession, resetFails, setPassword, SESSION_COOKIE } from "@/lib/settings/auth";
import { loadSettings, runtimeEnv, serverRealLock, updateSettings } from "@/lib/settings/store";
import { updateUser } from "@/lib/settings/users";
import { newTotpSecret, totpNow } from "@/lib/settings/totp";
import { readLoginLog } from "@/lib/settings/loginlog";
import { tradeCredentials } from "@/lib/kis/config";
import { POST as lockPost } from "@/app/api/settings/real-lock/route";
import { PUT as settingsPut } from "@/app/api/settings/route";

let dir: string;
const saved = { dir: process.env.ALPHY_CONFIG_DIR, allow: process.env.KIS_ALLOW_REAL_ORDERS };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "alphy-real-"));
  process.env.ALPHY_CONFIG_DIR = dir;
  delete process.env.KIS_ALLOW_REAL_ORDERS;
  resetFails();
  setPassword("owner-password-1");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [["ALPHY_CONFIG_DIR", saved.dir], ["KIS_ALLOW_REAL_ORDERS", saved.allow]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const cookie = () => `${SESSION_COOKIE}=${encodeURIComponent(issueSession().value)}`;
const lock = (body: unknown) => lockPost(new Request("http://x/api/settings/real-lock", { method: "POST", headers: { "content-type": "application/json", cookie: cookie() }, body: JSON.stringify(body) }));
const put = (body: unknown) => settingsPut(new Request("http://x/api/settings", { method: "PUT", headers: { "content-type": "application/json", cookie: cookie() }, body: JSON.stringify(body) }));
const withTotp = () => { const s = newTotpSecret(); updateUser("owner", (u) => { u.totpSecret = s; }); return s; };

describe("서버 실전 주문 잠금 (화면)", () => {
  it("기본은 잠김, 2단계 인증이 꺼져 있으면 풀 수 없음", async () => {
    expect(serverRealLock().open).toBe(false);
    const r = await lock({ on: true, code: "123456" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/2단계 인증을 켜/);
    expect(loadSettings().kis.realUnlock).toBeUndefined();
  });

  it("코드가 틀리면 거부, 맞으면 풀림 → 주문 자격 증명이 실전으로", async () => {
    const secret = withTotp();
    const wrong = totpNow(secret) === "000000" ? "111111" : "000000";
    expect((await lock({ on: true, code: wrong })).status).toBe(400);
    expect(serverRealLock().open).toBe(false);
    const r = await lock({ on: true, code: totpNow(secret) });
    expect(r.status).toBe(200);
    expect(serverRealLock().open).toBe(true);
    updateSettings((s) => { s.kis.real = { appKey: "rk", appSecret: "rs", account: "12345678-01" }; s.kis.tradeEnv = "real"; });
    expect(tradeCredentials(runtimeEnv()).env).toBe("real");
    expect(readLoginLog().some((x) => x.event === "real-unlock")).toBe(true);
  });

  it("잠글 때는 코드 없이 바로", async () => {
    const secret = withTotp();
    await lock({ on: true, code: totpNow(secret) });
    expect((await lock({ on: false })).status).toBe(200);
    expect(serverRealLock().open).toBe(false);
  });

  it("owner 의 2단계 인증이 꺼지면 다시 잠김", async () => {
    const secret = withTotp();
    await lock({ on: true, code: totpNow(secret) });
    updateUser("owner", (u) => { delete u.totpSecret; });
    expect(serverRealLock().open).toBe(false);
    expect(runtimeEnv().KIS_ALLOW_REAL_ORDERS).toBeUndefined();
  });

  it("환경변수 yes 는 늘 풀림, no 는 화면에서도 못 풂", async () => {
    expect(serverRealLock({ ...process.env, KIS_ALLOW_REAL_ORDERS: "yes" }).open).toBe(true);
    const secret = withTotp();
    process.env.KIS_ALLOW_REAL_ORDERS = "no";
    expect((await lock({ on: true, code: totpNow(secret) })).status).toBe(409);
    updateSettings((s) => { s.kis.realUnlock = { at: 1 }; });
    expect(serverRealLock().open).toBe(false);
  });

  it("설정 저장(PUT)으로는 잠금을 풀 수 없음", async () => {
    withTotp();
    await put({ kis: { realUnlock: { at: 1 } } });
    expect(loadSettings().kis.realUnlock).toBeUndefined();
  });
});

describe("주문 대상을 실전으로", () => {
  it("2단계 인증 코드가 있어야 바뀌고, 모의로는 코드 없이", async () => {
    const secret = withTotp();
    const bad = await put({ kis: { tradeEnv: "real" } });
    expect(bad.status).toBe(400);
    expect(loadSettings().kis.tradeEnv).toBe("mock");
    expect((await put({ kis: { tradeEnv: "real" }, otp: totpNow(secret) })).status).toBe(200);
    expect(loadSettings().kis.tradeEnv).toBe("real");
    expect((await put({ kis: { tradeEnv: "mock" } })).status).toBe(200);
    expect(loadSettings().kis.tradeEnv).toBe("mock");
  });

  it("이미 실전이면 다른 항목 저장에 코드가 필요 없음", async () => {
    updateSettings((s) => { s.kis.tradeEnv = "real"; });
    expect((await put({ kis: { orderLimit: { perOrder: 500000 } } })).status).toBe(200);
  });
});
