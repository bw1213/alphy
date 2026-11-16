import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, setPassword } from "@/lib/settings/auth";
import { open, seal, secretFromEnv } from "@/lib/settings/secretbox";
import { updateSettings } from "@/lib/settings/store";
import { acceptInvite, createInvite, getUser, setRealOrders, updateUser } from "@/lib/settings/users";
import { applyPatch, settingsView } from "@/lib/settings/view";
import { quoteCredentials, tradeCredentials } from "@/lib/kis/config";
import { realLockReason, tradeCredentialsFor } from "@/lib/kis/access";
import { deleteUserKis, kisEnvFor, loadUserKis, memberSettings, orderLimitFor, realLock, saveUserKis } from "@/lib/kis/userkeys";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "alphy-kis-")); env = { ALPHY_CONFIG_DIR: dir };
  setPassword("owner-password", env);
  const { code } = createInvite("mom", "member", "owner", env);
  acceptInvite(code, "mom", "엄마", hashPassword("mom-password"), env);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const momKeys = () => saveUserKis("mom", applyPatch(memberSettings("mom", env), {
  kis: { mock: { appKey: "MOM-MOCK-KEY-1234", appSecret: "MOM-MOCK-SECRET", account: "50011111-01" }, real: { appKey: "MOM-REAL-KEY-9876", appSecret: "MOM-REAL-SECRET", account: "11112222-01" } },
}).kis, env);

describe("비밀값 암호화", () => {
  it("파일 키로 암호화·복호화, 값마다 결과가 다름, 조작하면 실패", () => {
    const a = seal("hello", env), b = seal("hello", env);
    expect(a).not.toBe(b);
    expect(a).not.toContain("hello");
    expect(open(a, env)).toBe("hello");
    expect(statSync(path.join(dir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(() => open(a.slice(0, -2) + "xx", env)).toThrow();
    expect(secretFromEnv(env)).toBe(false);
  });
  it("환경변수 키를 나중에 넣어도 예전 값이 읽히고, 새 값은 환경변수 키로만 풀림", () => {
    const old = seal("old", env);
    const e2 = { ...env, ALPHY_SECRET_KEY: "my-long-secret" };
    expect(open(old, e2)).toBe("old");
    const fresh = seal("new", e2);
    expect(open(fresh, e2)).toBe("new");
    expect(() => open(fresh, env)).toThrow(/풀지 못했습니다/);
    expect(secretFromEnv(e2)).toBe(true);
  });
});

describe("사람별 한국투자증권 설정", () => {
  it("파일에는 암호화되어 저장되고 본인 것만 읽힘", () => {
    updateSettings((s) => { s.kis.mock = { appKey: "OWNER-MOCK-KEY", appSecret: "OWNER-SECRET", account: "99998888-01" }; }, env);
    momKeys();
    const f = path.join(dir, "users", "mom", "kis.json");
    const raw = readFileSync(f, "utf8");
    for (const secret of ["MOM-MOCK-KEY-1234", "MOM-MOCK-SECRET", "50011111", "MOM-REAL-SECRET", "11112222"]) expect(raw).not.toContain(secret);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadUserKis("mom", env).mock.appKey).toBe("MOM-MOCK-KEY-1234");

    const mom = getUser("mom", env)!, owner = getUser("owner", env)!;
    expect(kisEnvFor(mom, env).KIS_MOCK_APP_KEY).toBe("MOM-MOCK-KEY-1234");
    expect(kisEnvFor(owner, env).KIS_MOCK_APP_KEY).toBe("OWNER-MOCK-KEY");
    expect(tradeCredentialsFor(mom, env).cano).toBe("50011111");
    expect(tradeCredentialsFor(owner, env).cano).toBe("99998888");
    // 시세는 실전 키가 있으면 실전 키
    expect(quoteCredentials(kisEnvFor(mom, env))?.appKey).toBe("MOM-REAL-KEY-9876");
    expect(() => saveUserKis("owner", loadUserKis("mom", env), env)).toThrow();
  });
  it("키가 없는 사람은 owner 키를 대신 쓰지 않음", () => {
    updateSettings((s) => { s.kis.mock = { appKey: "OWNER-MOCK-KEY", appSecret: "OWNER-SECRET", account: "99998888-01" }; }, env);
    const mom = getUser("mom", env)!;
    expect(quoteCredentials(kisEnvFor(mom, env))).toBeNull();
    expect(() => tradeCredentialsFor(mom, env)).toThrow(/앱키/);
    // owner 환경변수 키도 다른 사람에게는 안 감
    const e2 = { ...env, KIS_MOCK_APP_KEY: "ENV-KEY", KIS_MOCK_APP_SECRET: "ENV-SECRET", KIS_MOCK_ACCOUNT: "12345678-01" };
    expect(quoteCredentials(kisEnvFor(mom, e2))).toBeNull();
    expect(quoteCredentials(kisEnvFor(getUser("owner", e2)!, e2))?.appKey).toBe("ENV-KEY");
  });
  it("보기에는 끝 4자리만, 환경변수 고정 표시는 없음", () => {
    momKeys();
    const v = settingsView(memberSettings("mom", env), {});
    expect(v.kis.mock.appKey).toEqual({ set: true, fromEnv: false, hint: "…1234" });
    expect(JSON.stringify(v)).not.toContain("MOM-MOCK-SECRET");
    expect(JSON.stringify(v)).not.toContain("50011111");
  });
  it("주문 상한은 사람마다 따로, 계정을 지우면 키 파일도 지움", () => {
    saveUserKis("mom", applyPatch(memberSettings("mom", env), { kis: { orderLimit: { perOrder: 200_000, perDay: 300_000 } } }).kis, env);
    expect(orderLimitFor("mom", env)).toEqual({ perOrder: 200_000, perDay: 300_000 });
    expect(orderLimitFor("owner", env).perOrder).toBe(1_000_000);
    deleteUserKis("mom", env);
    expect(existsSync(path.join(dir, "users", "mom", "kis.json"))).toBe(false);
    expect(loadUserKis("mom", env).mock).toEqual({});
  });
  it("암호화 키를 잃으면 조용히 빈 값이 되지 않고 에러", () => {
    momKeys();
    writeFileSync(path.join(dir, "secret.key"), "another-key\n");
    expect(() => loadUserKis("mom", env)).toThrow(/풀지 못했습니다/);
  });
});

describe("실전 주문 잠금 (owner 가 아닌 사람)", () => {
  const real = () => saveUserKis("mom", { ...loadUserKis("mom", env), tradeEnv: "real" }, env);
  const on = () => ({ ...env, KIS_ALLOW_REAL_ORDERS: "yes" });

  it("서버 잠금 + owner 허용 + 본인 2단계 인증이 모두 있어야 열림", () => {
    momKeys(); real();
    const mom = () => getUser("mom", env)!;
    expect(realLock(mom(), on())).toEqual({ server: true, granted: false, totp: false, open: false });
    expect(() => tradeCredentialsFor(mom(), on())).toThrow(/관리자\(owner\)의 실전 허용.*2단계 인증/);
    setRealOrders("mom", true, env);
    expect(() => tradeCredentialsFor(mom(), on())).toThrow(/2단계 인증/);
    updateUser("mom", (u) => { u.totpSecret = "JBSWY3DPEHPK3PXP"; }, env);
    expect(() => tradeCredentialsFor(mom(), env)).toThrow(/서버의 실전 주문 잠금/);
    expect(realLock(mom(), on()).open).toBe(true);
    expect(tradeCredentialsFor(mom(), on())).toMatchObject({ env: "real", cano: "11112222" });
    expect(realLockReason(mom(), on())).toBeUndefined();
    // 허용을 취소하거나 2단계 인증을 끄면 다시 잠김
    setRealOrders("mom", false, env);
    expect(() => tradeCredentialsFor(mom(), on())).toThrow(/실전 허용/);
    expect(() => setRealOrders("owner", true, env)).toThrow();
  });
  it("모의투자는 잠금과 상관없이 됨, owner 는 예전처럼 서버 잠금만", () => {
    momKeys();
    expect(tradeCredentialsFor(getUser("mom", env)!, env)).toMatchObject({ env: "mock", cano: "50011111" });
    updateSettings((s) => { s.kis.real = { appKey: "K", appSecret: "S", account: "12345678-01" }; s.kis.tradeEnv = "real"; }, env);
    const owner = getUser("owner", env)!;
    expect(() => tradeCredentialsFor(owner, env)).toThrow(/KIS_ALLOW_REAL_ORDERS/);
    expect(tradeCredentialsFor(owner, on()).env).toBe("real");
    expect(tradeCredentials).toBeTypeOf("function");
  });
});
