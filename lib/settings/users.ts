/**
 * 사용자 계정과 초대 (서버 전용). 여러 사람이 쓰도록 바꾸는 2단계.
 *
 * 저장: {설정 폴더}/users.json (권한 600)
 *   users   계정 목록. 비밀번호는 scrypt 해시, 2단계 인증 키는 사람마다 따로
 *   invites 초대 링크. 원문은 만들 때 한 번만 보여 주고 SHA-256 해시만 저장
 *
 * 처음 한 번: 예전 settings.json 의 관리자 비밀번호·2단계 인증을 "owner" 계정(관리자)으로 옮깁니다.
 * owner 는 지금까지 쓰던 그 계정이라 한국투자증권 키·서버 설정을 혼자 다룹니다(3단계에서 사람별로 나눔).
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { configDir, envPassword, loadSettings, updateSettings } from "./store";
import { OWNER_ID, validUserId } from "./userdir";

type Env = Record<string, string | undefined>;

export type Role = "admin" | "member";

export interface User {
  id: string;
  name: string;
  role: Role;
  passwordHash?: string;
  /** 바꾸면 그 사람의 기존 로그인이 모두 풀림 */
  sessionVersion: string;
  totpSecret?: string;
  totpPending?: string;
  totpLastCounter?: number;
  disabled?: boolean;
  createdAt: number;
}

export interface Invite {
  id: string;
  /** 초대 원문의 SHA-256 (hex) */
  hash: string;
  /** 받는 사람 이름(메모) */
  name: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
}

interface UsersFile { version: 1; users: User[]; invites: Invite[] }

/** 화면에 보여 주는 모양 (비밀값 없음) */
export interface UserView { id: string; name: string; role: Role; totpEnabled: boolean; disabled: boolean; createdAt: number; owner: boolean }
export type InviteView = Omit<Invite, "hash">;

export const INVITE_PREFIX = "alphy_inv_";
export const INVITE_DAYS = 3;
export const MAX_USERS = 20;
export const MAX_INVITES = 10;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newVersion = () => randomBytes(9).toString("base64url");

export const usersPath = (e: Env = process.env) => path.join(configDir(e), "users.json");

function readFile(e: Env): UsersFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(usersPath(e), "utf8"));
    if (!j || !Array.isArray(j.users)) return null;
    return { version: 1, users: j.users, invites: Array.isArray(j.invites) ? j.invites : [] };
  } catch { return null; }
}

function writeFile(f: UsersFile, e: Env) {
  const file = usersPath(e);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 예전 단일 관리자 설정 → owner 계정. 비밀번호가 아직 없으면(처음 설치) 아무것도 만들지 않음.
 * 옮긴 뒤 settings.json 에서 비밀번호·2단계 인증 항목은 지움(쿠키 서명 키·점검 키는 서버 공용이라 남김).
 */
function migrate(e: Env): UsersFile | null {
  const a = loadSettings(e).auth;
  if (!a.passwordHash && !envPassword(e)) return null;
  const owner: User = {
    id: OWNER_ID, name: "관리자", role: "admin", sessionVersion: newVersion(), createdAt: Date.now(),
    ...(a.passwordHash ? { passwordHash: a.passwordHash } : {}),
    ...(a.totpSecret ? { totpSecret: a.totpSecret, totpLastCounter: a.totpLastCounter } : {}),
  };
  const f: UsersFile = { version: 1, users: [owner], invites: [] };
  writeFile(f, e);
  try {
    updateSettings((s) => { delete s.auth.passwordHash; delete s.auth.totpSecret; delete s.auth.totpPending; delete s.auth.totpLastCounter; }, e);
  } catch { /* 지우기 실패해도 users.json 이 우선 */ }
  console.log("[alphy] 관리자 계정을 users.json 의 owner 로 옮겼습니다.");
  return f;
}

function load(e: Env): UsersFile {
  return readFile(e) ?? migrate(e) ?? { version: 1, users: [], invites: [] };
}

function update<T>(fn: (f: UsersFile) => T, e: Env): T {
  const f = load(e);
  const out = fn(f);
  writeFile(f, e);
  return out;
}

export function listUsers(e: Env = process.env): User[] {
  return load(e).users;
}

export function getUser(id: string, e: Env = process.env): User | undefined {
  return load(e).users.find((u) => u.id === id);
}

export function updateUser(id: string, fn: (u: User) => void, e: Env = process.env): User {
  return update((f) => {
    const u = f.users.find((x) => x.id === id);
    if (!u) throw new Error("없는 사용자입니다.");
    fn(u);
    return u;
  }, e);
}

/** owner 계정 만들기 (처음 설치 때 설정 코드로 비밀번호를 정하면) */
export function ensureOwner(e: Env = process.env): User {
  const have = getUser(OWNER_ID, e);
  if (have) return have;
  return update((f) => {
    const u: User = { id: OWNER_ID, name: "관리자", role: "admin", sessionVersion: newVersion(), createdAt: Date.now() };
    f.users.unshift(u);
    return u;
  }, e);
}

export function rotateSession(id: string, e: Env = process.env) {
  updateUser(id, (u) => { u.sessionVersion = newVersion(); }, e);
}

export const userView = (u: User): UserView => ({
  id: u.id, name: u.name, role: u.role, totpEnabled: !!u.totpSecret, disabled: !!u.disabled, createdAt: u.createdAt, owner: u.id === OWNER_ID,
});

const activeAdmins = (f: UsersFile) => f.users.filter((u) => u.role === "admin" && !u.disabled);

/** 정지·해제 (owner 와 자기 자신은 못 함) */
export function setDisabled(id: string, disabled: boolean, by: string, e: Env = process.env) {
  if (id === OWNER_ID) throw new Error("owner 계정은 정지할 수 없습니다.");
  if (id === by) throw new Error("자기 계정은 정지할 수 없습니다.");
  update((f) => {
    const u = f.users.find((x) => x.id === id);
    if (!u) throw new Error("없는 사용자입니다.");
    u.disabled = disabled;
    u.sessionVersion = newVersion();
    if (!activeAdmins(f).length) throw new Error("관리자가 한 명은 있어야 합니다.");
  }, e);
}

/** 계정 삭제. 그 사람의 저장 폴더(users/<id>/)는 지우지 않고 남김 */
export function deleteUser(id: string, by: string, e: Env = process.env) {
  if (id === OWNER_ID) throw new Error("owner 계정은 지울 수 없습니다.");
  if (id === by) throw new Error("자기 계정은 지울 수 없습니다.");
  update((f) => {
    const before = f.users.length;
    f.users = f.users.filter((u) => u.id !== id);
    if (f.users.length === before) throw new Error("없는 사용자입니다.");
    if (!activeAdmins(f).length) throw new Error("관리자가 한 명은 있어야 합니다.");
  }, e);
}

/** 휴대폰을 잃어버린 사람의 2단계 인증 끄기 (관리자가) */
export function resetTotp(id: string, e: Env = process.env) {
  updateUser(id, (u) => { delete u.totpSecret; delete u.totpPending; delete u.totpLastCounter; u.sessionVersion = newVersion(); }, e);
}

// ── 초대 ──

const liveInvites = (f: UsersFile, now: number) => f.invites.filter((i) => i.expiresAt > now);

export function listInvites(e: Env = process.env, now = Date.now()): InviteView[] {
  return liveInvites(load(e), now).map(({ hash: _h, ...rest }) => rest);
}

/** 초대 링크용 코드 만들기. 원문은 이 반환값에만 있음 */
export function createInvite(name: string, role: Role, by: string, e: Env = process.env, now = Date.now()): { code: string; view: InviteView } {
  const memo = name.trim().slice(0, 30) || "이름 없음";
  if (role !== "admin" && role !== "member") throw new Error("역할은 admin 또는 member 입니다.");
  const code = INVITE_PREFIX + randomBytes(18).toString("base64url");
  const inv: Invite = { id: randomBytes(6).toString("hex"), hash: sha(code), name: memo, role, createdAt: now, expiresAt: now + INVITE_DAYS * 864e5, createdBy: by };
  update((f) => {
    f.invites = liveInvites(f, now);
    if (f.invites.length >= MAX_INVITES) throw new Error(`아직 안 쓴 초대가 ${MAX_INVITES}개입니다. 안 쓸 것을 먼저 취소하세요.`);
    if (f.users.length + f.invites.length >= MAX_USERS) throw new Error(`사용자는 ${MAX_USERS}명까지입니다.`);
    f.invites.push(inv);
  }, e);
  const { hash: _h, ...view } = inv;
  return { code, view };
}

export function revokeInvite(id: string, e: Env = process.env) {
  update((f) => { f.invites = f.invites.filter((i) => i.id !== id); }, e);
}

function matchInvite(f: UsersFile, code: string, now: number): Invite | undefined {
  if (!code.startsWith(INVITE_PREFIX)) return undefined;
  const h = Buffer.from(sha(code), "hex");
  return liveInvites(f, now).find((i) => timingSafeEqual(Buffer.from(i.hash, "hex"), h));
}

/** 초대 링크가 살아 있는지 (가입 화면에서 이름 보여 주기용) */
export function checkInvite(code: string, e: Env = process.env, now = Date.now()): InviteView | null {
  const i = matchInvite(load(e), code, now);
  if (!i) return null;
  const { hash: _h, ...view } = i;
  return view;
}

/** 초대로 가입. 초대는 한 번 쓰면 사라짐 */
export function acceptInvite(code: string, id: string, name: string, passwordHash: string, e: Env = process.env, now = Date.now()): User {
  const uid = id.trim().toLowerCase();
  if (!validUserId(uid)) throw new Error("아이디는 영문 소문자·숫자·-·_ 로 32자까지 정하세요 (첫 글자는 영문 소문자나 숫자).");
  return update((f) => {
    const inv = matchInvite(f, code, now);
    if (!inv) throw new Error("초대 링크가 없거나 만료됐습니다. 관리자에게 새로 받아 주세요.");
    if (f.users.some((u) => u.id === uid)) throw new Error("이미 있는 아이디입니다. 다른 아이디를 고르세요.");
    const u: User = { id: uid, name: name.trim().slice(0, 30) || inv.name, role: inv.role, passwordHash, sessionVersion: newVersion(), createdAt: now };
    f.users.push(u);
    f.invites = f.invites.filter((i) => i.id !== inv.id);
    return u;
  }, e);
}
