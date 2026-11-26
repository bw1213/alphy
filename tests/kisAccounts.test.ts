import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, setPassword } from "@/lib/settings/auth";
import { loadSettings, updateSettings } from "@/lib/settings/store";
import { acceptInvite, createInvite, getUser } from "@/lib/settings/users";
import { acctFile } from "@/lib/settings/userdir";
import { settingsView } from "@/lib/settings/view";
import { applyKisAccountOp } from "@/lib/kis/kisAccounts";
import { tradeCredentialsFor } from "@/lib/kis/access";
import { extraKisAccounts, kisAccountIds, kisEnvFor, loadUserKis, saveUserKis } from "@/lib/kis/userkeys";
import { loadPlan, savePlan, type AutoPlan } from "@/lib/auto/store";
import { loadDays, saveDay } from "@/lib/auto/morning";
import { hasKisAccount } from "@/lib/manual/kis";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "alphy-kisacct-")); env = { ALPHY_CONFIG_DIR: dir };
  setPassword("owner-password", env);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const primary = { real: { account: "11112222-01" }, mock: { account: "50011111-01" } };
const add = (list: any[], x: Record<string, string>) => applyKisAccountOp(list, { action: "add", appKey: "K-1234", appSecret: "S", ...x } as any, primary, () => false);

describe("계좌 더 붙이기", () => {
  it("이름·앱키·계좌번호를 검사하고 id 를 만든다", () => {
    const r = add([], { name: "연금저축", env: "mock", account: "50022222-01" });
    expect(r.list).toHaveLength(1);
    expect(r.id).toMatch(/^kis-[a-f0-9]{6}$/);
    expect(r.toReal).toBe(false);
    expect(() => add([], { name: "", account: "50022222-01" })).toThrow(/이름/);
    expect(() => add([], { name: "A", account: "123" })).toThrow(/형식/);
    expect(() => applyKisAccountOp([], { action: "add", name: "A", account: "50022222-01" }, primary, () => false)).toThrow(/앱키/);
  });
  it("이미 쓰는 계좌번호는 막는다 (기본 계좌 포함)", () => {
    expect(() => add([], { name: "A", account: "5001111101" })).toThrow(/이미/);
    const r = add([], { name: "A", account: "50022222-01" });
    expect(() => add(r.list, { name: "B", account: "50022222-01" })).toThrow(/이미/);
  });
  it("실전 계좌를 새로 넣거나 실전으로 바꾸면 toReal", () => {
    const r = add([], { name: "ISA", env: "real", account: "33334444-01" });
    expect(r.toReal).toBe(true);
    const m = add([], { name: "M", env: "mock", account: "50033333-01" });
    const e = applyKisAccountOp(m.list, { action: "edit", id: m.id, env: "real" }, primary, () => false);
    expect(e.toReal).toBe(true);
    expect(e.list[0].appKey).toBe("K-1234");
    const again = applyKisAccountOp(e.list, { action: "edit", id: m.id, name: "새 이름" }, primary, () => false);
    expect(again.toReal).toBe(false);
    expect(again.list[0].name).toBe("새 이름");
  });
  it("운용이 있는 계좌는 못 지운다", () => {
    const r = add([], { name: "A", account: "50022222-01" });
    expect(() => applyKisAccountOp(r.list, { action: "delete", id: r.id }, primary, () => true)).toThrow(/운용/);
    expect(applyKisAccountOp(r.list, { action: "delete", id: r.id }, primary, () => false).list).toHaveLength(0);
  });
});

describe("계좌별 자격 증명·파일", () => {
  const setup = () => {
    updateSettings((s) => {
      s.kis.mock = { appKey: "MAIN-MOCK", appSecret: "S0", account: "50011111-01" };
      s.kis.accounts = [
        { id: "kis-aaaa11", name: "연금저축", env: "mock", appKey: "PEN-MOCK", appSecret: "S1", account: "50022222-01" },
        { id: "kis-bbbb22", name: "ISA", env: "real", appKey: "ISA-REAL", appSecret: "S2", account: "33334444-01" },
      ];
    }, env);
    return getUser("owner", env)!;
  };
  it("설정 파일에 남고, 화면에는 가려서 보인다", () => {
    setup();
    expect(loadSettings(env).kis.accounts).toHaveLength(2);
    const v = settingsView(loadSettings(env), env);
    expect(v.kisAccounts[0]).toMatchObject({ id: "kis-aaaa11", name: "연금저축", env: "mock", appKey: { set: true, hint: "…MOCK" }, account: { set: true, hint: "5002****-01" } });
    expect(JSON.stringify(v)).not.toContain("PEN-MOCK");
  });
  it("계좌마다 자기 키·계좌번호로 주문, 실전 계좌는 잠금을 따른다", () => {
    const u = setup();
    expect(kisAccountIds("owner", env)).toEqual(["kis", "kis-aaaa11", "kis-bbbb22"]);
    expect(tradeCredentialsFor(u, env).appKey).toBe("MAIN-MOCK");
    expect(tradeCredentialsFor(u, env, "kis-aaaa11")).toMatchObject({ env: "mock", appKey: "PEN-MOCK", cano: "50022222" });
    expect(() => tradeCredentialsFor(u, env, "kis-bbbb22")).toThrow(/잠겨/);
    expect(kisEnvFor(u, env, "kis-bbbb22").KIS_TRADE_ENV).toBe("real");
    expect(() => kisEnvFor(u, env, "kis-zzzz99")).toThrow(/찾지 못했/);
    expect(hasKisAccount(u, env, "kis-aaaa11")).toBe(true);
    expect(hasKisAccount(u, env, "kis-zzzz99")).toBe(false);
  });
  it("운용·주문 기록은 계좌마다 다른 파일", () => {
    setup();
    const plan = { label: "P", tickers: ["069500"], budget: 1_000_000, startDate: "2026-11-01", enabled: true, updatedAt: "x", builtin: "buyhold" } as AutoPlan;
    savePlan(plan, "owner", env, "kis-aaaa11");
    expect(loadPlan("owner", env)).toBeNull();
    expect(loadPlan("owner", env, "kis-aaaa11")?.label).toBe("P");
    expect(existsSync(path.join(dir, "users", "owner", "auto.kis-aaaa11.json"))).toBe(true);
    saveDay({ date: "2026-11-26", label: "P", env: "mock", phase: "done", items: [], log: [] }, "owner", env, "kis-aaaa11");
    expect(Object.keys(loadDays("owner", env))).toHaveLength(0);
    expect(Object.keys(loadDays("owner", env, "kis-aaaa11"))).toEqual(["2026-11-26"]);
    expect(() => acctFile("auto.json", "../x")).toThrow();
  });
  it("다른 사용자 계좌는 암호화 파일에 따로", () => {
    const { code } = createInvite("mom", "member", "owner", env);
    acceptInvite(code, "mom", "엄마", hashPassword("mom-password"), env);
    saveUserKis("mom", { ...loadUserKis("mom", env), accounts: [{ id: "kis-cccc33", name: "엄마 연금", env: "mock", appKey: "MOM-PEN", appSecret: "S", account: "50055555-01" }] }, env);
    expect(extraKisAccounts("mom", env)[0].name).toBe("엄마 연금");
    expect(extraKisAccounts("owner", env)).toEqual([]);
    expect(readFileSync(path.join(dir, "users", "mom", "kis.json"), "utf8")).not.toContain("MOM-PEN");
    expect(tradeCredentialsFor(getUser("mom", env)!, env, "kis-cccc33").appKey).toBe("MOM-PEN");
  });
});

describe("앱키 하나로 여러 계좌", () => {
  it("같은 앱키여도 계좌번호는 부른 계좌 것을 쓰고 토큰은 함께 쓴다", async () => {
    const { getClient } = await import("@/lib/kis/client");
    const a = getClient({ env: "mock", appKey: "SAME-KEY-1", appSecret: "s", cano: "50011111", acntPrdtCd: "01" });
    const b = getClient({ env: "mock", appKey: "SAME-KEY-1", appSecret: "s", cano: "50022222", acntPrdtCd: "22" });
    expect(a.cred.cano).toBe("50011111");
    expect(b.cred).toMatchObject({ cano: "50022222", acntPrdtCd: "22", appKey: "SAME-KEY-1" });
    expect(b.env).toBe("mock");
    (b as any).token = { token: "t" };
    expect((a as any).token).toEqual({ token: "t" });
  });
});

describe("하루 실전 주문 합계", () => {
  it("계좌마다 따로 센다", async () => {
    const { addUsage, usedToday } = await import("@/lib/kis/limits");
    const now = Date.now();
    addUsage(300_000, env, now, "owner");
    addUsage(100_000, env, now, "owner", "kis-aaaa11");
    expect(usedToday(env, now, "owner")).toBe(300_000);
    expect(usedToday(env, now, "owner", "kis-aaaa11")).toBe(100_000);
    expect(usedToday(env, now, "owner", "kis-bbbb22")).toBe(0);
  });
});
