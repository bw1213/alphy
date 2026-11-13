/**
 * 로그인 기록 (최근 100건). 설정 화면의 "보안" 칸에서 보여 줍니다.
 * 내가 아닌 접속이 있었는지 확인하는 용도. 저장: {설정 폴더}/login-log.json
 */
import fs from "fs";
import path from "path";
import { configDir } from "./store";

type Env = Record<string, string | undefined>;

export type LoginEvent = "login" | "fail" | "otp-fail" | "setup" | "change" | "locked" | "logout-all" | "2fa-on" | "2fa-off" | "diag-create" | "diag-revoke";
export interface LoginRecord { t: number; ip: string; event: LoginEvent; ua?: string }

const MAX = 100;
const file = (e: Env) => path.join(configDir(e), "login-log.json");

export function readLoginLog(e: Env = process.env): LoginRecord[] {
  try {
    const v = JSON.parse(fs.readFileSync(file(e), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function recordLogin(req: Request, ip: string, event: LoginEvent, e: Env = process.env, now = Date.now()) {
  const ua = req.headers.get("user-agent")?.slice(0, 160) || undefined;
  const list = [{ t: now, ip, event, ua }, ...readLoginLog(e)].slice(0, MAX);
  try {
    fs.mkdirSync(configDir(e), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(e), JSON.stringify(list), { mode: 0o600 });
  } catch { /* 기록 실패는 로그인에 영향 없게 */ }
  if (event !== "login") console.log(`[auth] ${event} ${ip}`);
}
