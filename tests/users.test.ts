import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPassword, checkTotp, hashPassword, issueSession, loginBlockedFor, loginId, logoutUser, recordFail, requireAdminUser, requireOwner,
  requireUser, resetFails, sessionUser, setPassword, totpEnabled, verifySession, SESSION_COOKIE,
} from "@/lib/settings/auth";
import { loadSettings, updateSettings } from "@/lib/settings/store";
import { newTotpSecret, totpNow } from "@/lib/settings/totp";
import {
  acceptInvite, checkInvite, createInvite, deleteUser, getUser, listInvites, listUsers, resetTotp, revokeInvite, setDisabled, updateUser, usersPath, userView, INVITE_DAYS,
} from "@/lib/settings/users";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-acct-")); env = { ALPHY_CONFIG_DIR: dir }; resetFails(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const req = (cookie?: string) => new Request("http://x/", { headers: cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {} });
const join = (id: string, role: "admin" | "member" = "member", pw = "member-password") => {
  const { code } = createInvite(id, role, "owner", env);
  return acceptInvite(code, id, id, hashPassword(pw), env);
};

describe("예전 단일 관리자 → owner 계정", () => {
  it("settings.json 의 비밀번호·2단계 인증을 owner 로 옮기고 원래 자리에서는 지움", () => {
    const secret = newTotpSecret();
    updateSettings((s) => { s.auth.passwordHash = hashPassword("old-password"); s.auth.totpSecret = secret; s.auth.totpLastCounter = 5; }, env);
    expect(checkPassword("old-password", env)).toBe(true);
    const o = getUser("owner", env)!;
    expect(o.role).toBe("admin");
    expect(o.totpSecret).toBe(secret);
    expect(totpEnabled(env)).toBe(true);
    expect(loadSettings(env).auth.passwordHash).toBeUndefined();
    expect(loadSettings(env).auth.totpSecret).toBeUndefined();
    expect(statSync(usersPath(env)).mode & 0o777).toBe(0o600);
  });
  it("처음 설치(비밀번호 없음)에는 계정이 없고, 비밀번호를 정하면 owner 가 생김", () => {
    expect(listUsers(env)).toEqual([]);
    setPassword("long-password", env);
    expect(listUsers(env).map((u) => u.id)).toEqual(["owner"]);
    expect(loginId("")).toBe("owner");
    expect(loginId(" Mom ")).toBe("mom");
  });
});

describe("초대와 가입", () => {
  beforeEach(() => setPassword("owner-password", env));

  it("초대는 한 번만 쓸 수 있고 기간이 지나면 막힘", () => {
    const { code, view } = createInvite("엄마", "member", "owner", env, 1000);
    expect(JSON.stringify(listInvites(env, 1000))).not.toContain(code);
    expect(checkInvite(code, env, 1000)?.name).toBe("엄마");
    expect(checkInvite(code + "x", env, 1000)).toBeNull();
    expect(checkInvite(code, env, 1000 + INVITE_DAYS * 864e5 + 1)).toBeNull();
    const u = acceptInvite(code, "Mom", "", hashPassword("mom-password"), env, 2000);
    expect(u.id).toBe("mom");
    expect(u.name).toBe("엄마");
    expect(u.role).toBe("member");
    expect(() => acceptInvite(code, "mom2", "", hashPassword("x".repeat(8)), env, 3000)).toThrow(/초대/);
    expect(listInvites(env, 3000).find((i) => i.id === view.id)).toBeUndefined();
  });
  it("이미 있는 아이디·이상한 아이디는 안 되고 초대는 남음", () => {
    const { code } = createInvite("a", "member", "owner", env);
    expect(() => acceptInvite(code, "owner", "", "h", env)).toThrow(/이미/);
    expect(() => acceptInvite(code, "../x", "", "h", env)).toThrow(/아이디/);
    expect(checkInvite(code, env)).not.toBeNull();
    revokeInvite(listInvites(env)[0].id, env);
    expect(checkInvite(code, env)).toBeNull();
  });
  it("보기에는 비밀값이 없음", () => {
    const u = join("mom");
    expect(JSON.stringify(listUsers(env).map(userView))).not.toContain(u.passwordHash!);
    expect(JSON.stringify(listUsers(env).map(userView))).not.toContain(u.sessionVersion);
  });
});

describe("사람별 로그인", () => {
  beforeEach(() => { setPassword("owner-password", env); join("mom"); join("dad", "admin"); });

  it("비밀번호는 사람마다 따로", () => {
    expect(checkPassword("member-password", env, "mom")).toBe(true);
    expect(checkPassword("owner-password", env, "mom")).toBe(false);
    expect(checkPassword("member-password", env)).toBe(false);
    expect(checkPassword("member-password", env, "nobody")).toBe(false);
  });
  it("쿠키에는 누구인지가 들어가고, 남의 쿠키로 바꿔치기할 수 없음", () => {
    const mom = issueSession(env, Date.now(), "mom").value;
    expect(sessionUser(mom, env)?.id).toBe("mom");
    const forged = mom.replace(/^mom\./, "owner.");
    expect(sessionUser(forged, env)).toBeNull();
    expect(() => issueSession(env, Date.now(), "nobody")).toThrow();
  });
  it("역할: 일반은 관리·증권 기능 불가, 관리자는 관리만, owner 는 모두", () => {
    const c = (id: string) => req(issueSession(env, Date.now(), id).value);
    expect(requireUser(c("mom"), env).user?.id).toBe("mom");
    expect(requireAdminUser(c("mom"), env).denied?.[0]).toBe(403);
    expect(requireOwner(c("mom"), env).denied?.[0]).toBe(403);
    expect(requireAdminUser(c("dad"), env).user?.id).toBe("dad");
    expect(requireOwner(c("dad"), env).denied?.[0]).toBe(403);
    expect(requireOwner(c("owner"), env).user?.id).toBe("owner");
    expect(requireUser(req(), env).denied?.[0]).toBe(401);
  });
  it("비밀번호 변경·모든 기기 로그아웃은 그 사람 로그인만 끊음", () => {
    const mom = issueSession(env, Date.now(), "mom").value;
    const owner = issueSession(env).value;
    setPassword("mom-new-password", env, "mom");
    expect(verifySession(mom, env)).toBe(false);
    expect(verifySession(owner, env)).toBe(true);
    const mom2 = issueSession(env, Date.now(), "mom").value;
    logoutUser("owner", env);
    expect(verifySession(owner, env)).toBe(false);
    expect(verifySession(mom2, env)).toBe(true);
  });
  it("정지하면 바로 로그아웃되고 로그인도 안 됨, 삭제도 마찬가지", () => {
    const mom = issueSession(env, Date.now(), "mom").value;
    setDisabled("mom", true, "owner", env);
    expect(verifySession(mom, env)).toBe(false);
    expect(checkPassword("member-password", env, "mom")).toBe(false);
    setDisabled("mom", false, "owner", env);
    expect(checkPassword("member-password", env, "mom")).toBe(true);
    const again = issueSession(env, Date.now(), "mom").value;
    deleteUser("mom", "owner", env);
    expect(verifySession(again, env)).toBe(false);
    expect(() => deleteUser("owner", "dad", env)).toThrow(/owner/);
    expect(() => setDisabled("owner", true, "dad", env)).toThrow(/owner/);
    expect(() => deleteUser("dad", "dad", env)).toThrow(/자기/);
  });
  it("2단계 인증은 사람마다 따로, 관리자가 초기화 가능", () => {
    const secret = newTotpSecret();
    updateUser("mom", (u) => { u.totpSecret = secret; }, env);
    const now = Date.now();
    expect(totpEnabled(env, "mom")).toBe(true);
    expect(totpEnabled(env)).toBe(false);
    expect(checkTotp("", env, now)).toBe(true);
    expect(checkTotp("", env, now, "mom")).toBe(false);
    expect(checkTotp(totpNow(secret, now), env, now, "mom")).toBe(true);
    resetTotp("mom", env);
    expect(totpEnabled(env, "mom")).toBe(false);
  });
  it("같은 아이디로 5번 틀리면 다른 주소에서도 잠김, 다른 아이디는 영향 없음", () => {
    const now = 1_000_000;
    for (let k = 0; k < 5; k++) recordFail(`9.9.9.${k}`, now, "mom");
    expect(loginBlockedFor("1.2.3.4", now, "mom")).toBeGreaterThan(0);
    expect(loginBlockedFor("1.2.3.4", now, "dad")).toBe(0);
    expect(loginBlockedFor("1.2.3.4", now + 11 * 60_000, "mom")).toBe(0);
  });
});
