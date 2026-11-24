/**
 * 사용자별 저장 폴더 (서버 전용). 여러 사람이 쓰도록 바꾸는 1단계.
 *
 *   {설정 폴더}/settings.json            서버 공용 (로그인·쿠키 서명 키·KIS·백테스트 기본값 — 다음 단계에서 나눔)
 *   {설정 폴더}/users/<사용자>/...        사람마다 따로: strategies.json, last-state.json, order-usage.json
 *
 * 아직 계정이 하나(관리자)뿐이라 모든 요청은 OWNER_ID 폴더를 씁니다.
 * 예전 위치({설정 폴더}/strategies.json 등)에 파일이 있으면 처음 읽을 때 관리자 폴더로 옮기고,
 * 원본은 같은 자리에 "<이름>.moved" 로 남깁니다(문제가 생기면 이름만 되돌리면 복구).
 */
import fs from "fs";
import path from "path";
import { configDir } from "./store";

type Env = Record<string, string | undefined>;

export const OWNER_ID = "owner";

export const USER_FILES = ["strategies.json", "last-state.json", "order-usage.json"] as const;
export const NEW_USER_FILES = ["auto.json", "auto-log.json", "notify.json", "auto-orders.json", "auto-intraday.json", "auto-perf.json", "manual.json", "manual-log.json", "manual-trades.json", "manual-history.json", "account-ledger.json"] as const;
export type UserFileName = (typeof USER_FILES)[number] | (typeof NEW_USER_FILES)[number];
export type UserFile = (typeof USER_FILES)[number];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validUserId(id: string): boolean {
  return ID_RE.test(id);
}

export function userDir(user: string = OWNER_ID, e: Env = process.env): string {
  if (!validUserId(user)) throw new Error(`사용자 이름 형식이 아닙니다: ${JSON.stringify(user).slice(0, 40)}`);
  return path.join(configDir(e), "users", user);
}

export function ensureUserDir(user: string = OWNER_ID, e: Env = process.env): string {
  const dir = userDir(user, e);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 예전 위치의 파일을 관리자 폴더로 옮김. 이미 새 파일이 있으면 건드리지 않음 */
function migrateLegacy(name: UserFile, e: Env) {
  const legacy = path.join(configDir(e), name);
  const target = path.join(userDir(OWNER_ID, e), name);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    ensureUserDir(OWNER_ID, e);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.copyFileSync(legacy, tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
    fs.renameSync(legacy, `${legacy}.moved`);
    console.log(`[alphy] ${name} 을(를) 사용자별 폴더(users/${OWNER_ID}/)로 옮겼습니다.`);
  } catch (err) {
    console.error(`[alphy] ${name} 옮기기 실패(예전 파일은 그대로 둠): ${(err as Error).message}`);
  }
}

/** 사용자 파일 경로. 관리자라면 예전 위치 파일을 먼저 옮김 */
export function userFile(name: UserFileName, user: string = OWNER_ID, e: Env = process.env): string {
  if (user === OWNER_ID && (USER_FILES as readonly string[]).includes(name)) migrateLegacy(name as UserFile, e);
  return path.join(userDir(user, e), name);
}

export function writeUserFile(name: UserFileName, data: string, user: string = OWNER_ID, e: Env = process.env): void {
  const file = userFile(name, user, e);
  ensureUserDir(user, e);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
