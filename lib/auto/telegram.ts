/**
 * 텔레그램 알림 (서버 전용).
 *
 * - 봇 토큰은 관리자(owner)가 운용 화면에서 한 번 넣습니다 (settings.json 의 auto.telegramToken).
 * - 각 사람은 "연결 코드"를 봇에게 보내 자기 대화방을 연결합니다 (users/<사용자>/notify.json 에 대화방 번호만 저장).
 *   봇에게 온 메시지는 getUpdates 로 읽어 코드를 찾습니다(웹훅·열린 포트 필요 없음).
 */
import { randomBytes } from "crypto";
import fs from "fs";
import { loadSettings, updateSettings } from "../settings/store";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export interface NotifyFile {
  chatId?: number;
  chatName?: string;
  /** 연결 중인 코드와 만든 시각 */
  code?: string;
  codeAt?: number;
}

const API = "https://api.telegram.org";
const CODE_MINUTES = 30;

export function loadNotify(user: string = OWNER_ID, e: Env = process.env): NotifyFile {
  try { return JSON.parse(fs.readFileSync(userFile("notify.json", user, e), "utf8")) ?? {}; } catch { return {}; }
}
export function saveNotify(n: NotifyFile, user: string = OWNER_ID, e: Env = process.env) {
  writeUserFile("notify.json", JSON.stringify(n), user, e);
}

export const botToken = (e: Env = process.env) => loadSettings(e).auto.telegramToken?.trim() || "";

/** 봇 토큰 형식: 숫자:영문 */
export const validToken = (t: string) => /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(t);

async function call<T>(token: string, method: string, body: unknown, f: Fetch = fetch): Promise<T> {
  const r = await f(`${API}/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  let j: any = null;
  try { j = await r.json(); } catch { /* 아래에서 처리 */ }
  if (!j?.ok) throw new Error(`텔레그램 ${method} 실패: ${j?.description ?? `HTTP ${r.status}`}`);
  return j.result as T;
}

/** 관리자가 봇 토큰을 넣음: getMe 로 확인 후 저장 */
export async function setBotToken(token: string, e: Env = process.env, f: Fetch = fetch): Promise<string> {
  const t = token.trim();
  if (!t) { updateSettings((s) => { delete s.auto.telegramToken; delete s.auto.telegramBot; }, e); return ""; }
  if (!validToken(t)) throw new Error("봇 토큰 형식이 아닙니다. BotFather 가 준 '숫자:영문' 전체를 넣으세요.");
  const me = await call<{ username: string }>(t, "getMe", {}, f);
  updateSettings((s) => { s.auto.telegramToken = t; s.auto.telegramBot = me.username; }, e);
  return me.username;
}

/** 연결 코드 만들기 (30분 유효) */
export function newLinkCode(user: string, e: Env = process.env, now = Date.now()): string {
  const code = `alphy-${randomBytes(4).toString("hex")}`;
  saveNotify({ ...loadNotify(user, e), code, codeAt: now }, user, e);
  return code;
}

/** 봇에게 온 메시지에서 코드를 찾아 대화방 연결 */
export async function verifyLink(user: string, e: Env = process.env, f: Fetch = fetch, now = Date.now()): Promise<NotifyFile> {
  const token = botToken(e);
  if (!token) throw new Error("관리자가 아직 텔레그램 봇을 연결하지 않았습니다.");
  const n = loadNotify(user, e);
  if (!n.code || !n.codeAt || now - n.codeAt > CODE_MINUTES * 60_000) throw new Error("연결 코드가 없거나 30분이 지났습니다. 코드를 새로 만드세요.");
  const ups = await call<any[]>(token, "getUpdates", { allowed_updates: ["message"], timeout: 0 }, f);
  const hit = [...ups].reverse().find((u) => typeof u?.message?.text === "string" && u.message.text.includes(n.code!));
  if (!hit) throw new Error(`봇에게서 코드를 아직 못 찾았습니다. 텔레그램에서 봇에게 "${n.code}" 를 보낸 뒤 다시 눌러 주세요.`);
  const chat = hit.message.chat;
  const next: NotifyFile = { chatId: Number(chat.id), chatName: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || chat.title || "" };
  saveNotify(next, user, e);
  await call(token, "sendMessage", { chat_id: next.chatId, text: "알피 알림이 연결되었습니다." }, f).catch(() => null);
  return next;
}

export function unlink(user: string, e: Env = process.env) { saveNotify({}, user, e); }

/** 그 사람에게 알림. 봇·대화방이 없으면 false (오류 아님) */
export async function notify(user: string, text: string, e: Env = process.env, f: Fetch = fetch): Promise<boolean> {
  const token = botToken(e);
  const n = loadNotify(user, e);
  if (!token || !n.chatId) return false;
  // 텔레그램 한 메시지 최대 4096자
  await call(token, "sendMessage", { chat_id: n.chatId, text: text.length > 4000 ? `${text.slice(0, 4000)}\n…(생략)` : text, disable_web_page_preview: true }, f);
  return true;
}

/** 여러 계좌 결과를 한 번에: 4000자 안에서 묶어 되도록 한 메시지로 보냄 */
export function packMessages(parts: string[], head = "", max = 4000): string[] {
  const out: string[] = [];
  let cur = head;
  for (const p of parts) {
    const piece = p.length > max ? `${p.slice(0, max - 10)}\n…(생략)` : p;
    const next = cur ? `${cur}\n\n────────\n\n${piece}` : piece;
    if (next.length > max && cur) { out.push(cur); cur = piece; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

export async function notifyMany(user: string, parts: string[], head = "", e: Env = process.env, f: Fetch = fetch): Promise<boolean> {
  if (!parts.length) return false;
  let sent = false;
  for (const m of packMessages(parts, head)) sent = (await notify(user, m, e, f)) || sent;
  return sent;
}
