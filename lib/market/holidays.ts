/**
 * 한국·미국 증시 휴장일.
 * 한국: 한국투자증권 국내휴장일조회(CTCA0903R, 실전 앱키) 결과를 하루 한 번 받아 파일에 두고, 없으면 규칙표로 대신함.
 * 미국: NYSE 휴장·조기 마감 규칙. 임시 휴장은 자동 매매 화면에서 관리자가 직접 넣음.
 */
import fs from "fs";
import path from "path";
import { configDir, loadSettings, runtimeEnv } from "../settings/store";
import { listUsers } from "../settings/users";
import { credentialsFor, quoteCredentials, type KisCredentials } from "../kis/config";
import { kisQuote } from "../kis/market";
import { getClient } from "../kis/client";
import { kisEnvFor } from "../kis/userkeys";
import type { KisClient } from "../kis/client";

type Env = Record<string, string | undefined>;
export type Market = "KR" | "US";

export interface DayInfo {
  date: string;
  open: boolean;
  /** kis: 증권사 휴장일 조회, rule: 규칙표, manual: 직접 넣은 휴장일, weekend: 주말 */
  source: "kis" | "rule" | "manual" | "weekend";
  name?: string;
  /** 평소와 다른 장 시작 시각 (그 시장 시간) */
  openAt?: string;
  /** 평소보다 일찍 끝나면 마감 시각 (그 시장 시간) */
  closeAt?: string;
}

interface CalendarFile {
  kr?: Record<string, boolean>;
  /** 09:01 에 아직 거래가 없어 늦게 연다고 본 날 */
  krLate?: Record<string, string>;
  krFetchedAt?: string;
  krError?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dowOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const isWeekend = (date: string) => { const w = dowOf(date); return w === 0 || w === 6; };

function nthWeekday(y: number, m: number, dow: number, n: number): string {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y: number, m: number, dow: number): string {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const w = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return iso(y, m, lastDay - ((w - dow + 7) % 7));
}
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return iso(y, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
}
const observed = (date: string) => { const w = dowOf(date); return w === 6 ? addDays(date, -1) : w === 0 ? addDays(date, 1) : date; };

const usCache = new Map<number, Map<string, string>>();
function usHolidays(y: number): Map<string, string> {
  const hit = usCache.get(y);
  if (hit) return hit;
  const m = new Map<string, string>();
  const ny = iso(y, 1, 1);
  if (dowOf(ny) !== 6) m.set(observed(ny), "New Year's Day");
  m.set(nthWeekday(y, 1, 1, 3), "Martin Luther King Jr. Day");
  m.set(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  m.set(addDays(easter(y), -2), "Good Friday");
  m.set(lastWeekday(y, 5, 1), "Memorial Day");
  if (y >= 2022) m.set(observed(iso(y, 6, 19)), "Juneteenth");
  m.set(observed(iso(y, 7, 4)), "Independence Day");
  m.set(nthWeekday(y, 9, 1, 1), "Labor Day");
  m.set(nthWeekday(y, 11, 4, 4), "Thanksgiving Day");
  m.set(observed(iso(y, 12, 25)), "Christmas Day");
  usCache.set(y, m);
  return m;
}

function usEarlyClose(date: string): boolean {
  const y = Number(date.slice(0, 4));
  const h = usHolidays(y);
  if (isWeekend(date) || h.has(date)) return false;
  if (date === addDays(nthWeekday(y, 11, 4, 4), 1)) return true;
  return date === iso(y, 7, 3) || date === iso(y, 12, 24);
}

// 음력 공휴일 (설날·추석은 당일, 앞뒤 하루씩 함께 쉼)
const LUNAR: Record<number, { seollal: string; chuseok: string; buddha: string }> = {
  2025: { seollal: "2025-01-29", chuseok: "2025-10-06", buddha: "2025-05-05" },
  2026: { seollal: "2026-02-17", chuseok: "2026-09-25", buddha: "2026-05-24" },
  2027: { seollal: "2027-02-07", chuseok: "2027-09-15", buddha: "2027-05-13" },
  2028: { seollal: "2028-01-27", chuseok: "2028-10-03", buddha: "2028-05-02" },
  2029: { seollal: "2029-02-13", chuseok: "2029-09-22", buddha: "2029-05-20" },
  2030: { seollal: "2030-02-03", chuseok: "2030-09-12", buddha: "2030-05-09" },
};
const KR_EXTRA: Record<string, string> = {
  "2025-01-27": "임시공휴일", "2025-06-03": "대통령 선거", "2025-10-10": "임시공휴일",
  "2026-06-03": "지방선거", "2028-04-12": "국회의원 선거",
};

const krCache = new Map<number, Map<string, string>>();
function krHolidays(y: number): Map<string, string> {
  const hit = krCache.get(y);
  if (hit) return hit;
  const m = new Map<string, string>();
  const subs: { date: string; name: string; sat: boolean }[] = [];
  const add = (date: string, name: string, sub?: "satsun" | "sun") => {
    const clash = m.has(date);
    if (!clash) m.set(date, name);
    if (!sub) return;
    const w = dowOf(date);
    if (clash || w === 0 || (sub === "satsun" && w === 6)) subs.push({ date, name, sat: sub === "satsun" });
  };
  add(iso(y, 1, 1), "신정");
  add(iso(y, 3, 1), "삼일절", "satsun");
  add(iso(y, 5, 1), "근로자의 날");
  add(iso(y, 5, 5), "어린이날", "satsun");
  add(iso(y, 6, 6), "현충일");
  add(iso(y, 8, 15), "광복절", "satsun");
  add(iso(y, 10, 3), "개천절", "satsun");
  add(iso(y, 10, 9), "한글날", "satsun");
  add(iso(y, 12, 25), "성탄절", "satsun");
  const l = LUNAR[y];
  if (l) {
    for (const n of [-1, 0, 1]) add(addDays(l.seollal, n), "설날", "sun");
    for (const n of [-1, 0, 1]) add(addDays(l.chuseok, n), "추석", "sun");
    add(l.buddha, "부처님오신날", "satsun");
  }
  for (const [d, n] of Object.entries(KR_EXTRA)) if (d.startsWith(`${y}-`)) add(d, n);
  for (const s of subs) {
    let d = addDays(s.date, 1);
    while (isWeekend(d) || m.has(d)) d = addDays(d, 1);
    m.set(d, `${s.name} 대체휴일`);
  }
  const ye = iso(y, 12, 31);
  if (!isWeekend(ye)) m.set(ye, "연말 휴장");
  krCache.set(y, m);
  return m;
}

const calPath = (e: Env) => path.join(configDir(e), "market-calendar.json");
let fileCache: { file: string; mtimeMs: number; value: CalendarFile } | null = null;

export function loadCalendar(e: Env = process.env): CalendarFile {
  const file = calPath(e);
  try {
    const st = fs.statSync(file);
    if (fileCache && fileCache.file === file && fileCache.mtimeMs === st.mtimeMs) return fileCache.value;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
    fileCache = { file, mtimeMs: st.mtimeMs, value };
    return value;
  } catch { return {}; }
}

function saveCalendar(c: CalendarFile, e: Env) {
  const p = calPath(e);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  fs.renameSync(tmp, p);
  fileCache = null;
}

export const cleanDates = (v: unknown): string[] =>
  [...new Set(String(Array.isArray(v) ? v.join(",") : v ?? "").split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))))].sort();

export const lateOpenDays = (e: Env = process.env): string[] => cleanDates(loadSettings(e).auto.lateOpen);

export function extraClosed(e: Env = process.env): Record<Market, string[]> {
  const x = loadSettings(e).auto.extraClosed ?? {};
  return { KR: cleanDates(x.KR), US: cleanDates(x.US) };
}

function closedInfo(market: Market, date: string, e: Env): DayInfo | null {
  if (isWeekend(date)) return { date, open: false, source: "weekend" };
  if (extraClosed(e)[market].includes(date)) return { date, open: false, source: "manual", name: "임시 휴장" };
  const y = Number(date.slice(0, 4));
  if (market === "US") {
    const n = usHolidays(y).get(date);
    return n ? { date, open: false, source: "rule", name: n } : null;
  }
  const kis = loadCalendar(e).kr?.[date];
  const n = krHolidays(y).get(date);
  if (kis === false) return { date, open: false, source: "kis", name: n };
  if (kis === true) return null;
  return n ? { date, open: false, source: "rule", name: n } : null;
}

export const LATE_OPEN = "10:00", LATE_CLOSE = "16:30";

/** 그 시장이 그날 열리는지 (날짜는 그 시장 날짜) */
export function tradingDay(market: Market, date: string, e: Env = process.env): DayInfo {
  const closed = closedInfo(market, date, e);
  if (closed) return closed;
  const src: DayInfo["source"] = market === "KR" && loadCalendar(e).kr?.[date] === true ? "kis" : "rule";
  if (market === "US" && usEarlyClose(date)) return { date, open: true, source: src, closeAt: "13:00", name: "조기 마감" };
  if (market === "KR" && (lateOpenDays(e).includes(date) || loadCalendar(e).krLate?.[date])) {
    return { date, open: true, source: lateOpenDays(e).includes(date) ? "manual" : src, openAt: LATE_OPEN, closeAt: LATE_CLOSE, name: "늦은 개장" };
  }
  if (market === "KR" && isFirstOfYear(date, e)) return { date, open: true, source: src, openAt: "10:00", name: "새해 첫 거래일" };
  return { date, open: true, source: src };
}

function isFirstOfYear(date: string, e: Env): boolean {
  for (let d = addDays(date, -1); d.slice(0, 4) === date.slice(0, 4); d = addDays(d, -1)) if (!closedInfo("KR", d, e)) return false;
  return true;
}

/** date 앞쪽 n번째 거래일 */
export function prevTradingDay(market: Market, date: string, n = 1, e: Env = process.env): string {
  let d = date;
  for (let i = 0; i < n; i++) {
    let guard = 0;
    do { d = addDays(d, -1); } while (!tradingDay(market, d, e).open && ++guard < 30);
  }
  return d;
}

/** from 부터 days 일 안의 휴장일 (주말 빼고) */
export function upcomingClosed(market: Market, from: string, days: number, e: Env = process.env): DayInfo[] {
  const out: DayInfo[] = [];
  for (let i = 0; i < days; i++) {
    const t = tradingDay(market, addDays(from, i), e);
    if ((!t.open && t.source !== "weekend") || t.closeAt || t.openAt) out.push(t);
  }
  return out;
}

const ymd = (d: string) => d.replace(/-/g, "");
const fromYmd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** KIS 국내휴장일조회 (실전 앱키만 됨). 기준일부터 증권사가 주는 만큼 */
export async function fetchKrDays(client: KisClient, from: string, pages = 3): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  let nk = "", fk = "", cont = "";
  for (let p = 0; p < pages; p++) {
    const { body, trCont } = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/quotations/chk-holiday",
      trId: "CTCA0903R",
      query: { BASS_DT: ymd(from), CTX_AREA_NK: nk, CTX_AREA_FK: fk },
      trCont: cont,
    });
    for (const r of ((body.output as any[]) ?? [])) {
      const d = String(r?.bass_dt ?? "");
      if (/^\d{8}$/.test(d)) out[fromYmd(d)] = String(r.opnd_yn).toUpperCase() === "Y";
    }
    if (trCont !== "M" && trCont !== "F") break;
    nk = String(body.ctx_area_nk ?? "").trim(); fk = String(body.ctx_area_fk ?? "").trim(); cont = "N";
    if (!nk && !fk) break;
  }
  return out;
}

function realCredentials(e: Env): KisCredentials | null {
  const own = credentialsFor("real", runtimeEnv(e));
  if (own) return own;
  for (const u of listUsers(e)) {
    if (u.disabled) continue;
    const c = credentialsFor("real", kisEnvFor(u, e));
    if (c) return c;
  }
  return null;
}

const kstDate = (now: number) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
const RETRY_MS = 30 * 60_000;
let lastTry = 0;
let inflight: Promise<CalendarFile> | null = null;

/** 한국 휴장일을 하루 한 번 증권사에서 받아 둠. 실패해도 규칙표로 계속 돌아감 */
export async function refreshKrCalendar(e: Env = process.env, opts: { now?: number; force?: boolean; client?: KisClient } = {}): Promise<CalendarFile> {
  const now = opts.now ?? Date.now();
  const cur = loadCalendar(e);
  const today = kstDate(now);
  if (!opts.force && cur.krFetchedAt && kstDate(Date.parse(cur.krFetchedAt)) === today) return cur;
  if (!opts.force && now - lastTry < RETRY_MS) return cur;
  if (inflight) return inflight;
  lastTry = now;
  inflight = (async () => {
    try {
      const cred = opts.client ? null : realCredentials(e);
      const client = opts.client ?? (cred ? getClient(cred) : null);
      if (!client) {
        const next = { ...cur, krError: "실전 앱키가 없어 규칙표로 판단합니다." };
        saveCalendar(next, e);
        return next;
      }
      const days = await fetchKrDays(client, today);
      if (!Object.keys(days).length) throw new Error("빈 응답");
      const keepFrom = addDays(today, -400);
      const kr = Object.fromEntries(Object.entries({ ...(cur.kr ?? {}), ...days }).filter(([d]) => d >= keepFrom).sort(([a], [b]) => a.localeCompare(b)));
      const next: CalendarFile = { ...loadCalendar(e), kr, krFetchedAt: new Date(now).toISOString(), krError: undefined };
      saveCalendar(next, e);
      return next;
    } catch (err) {
      const next = { ...cur, krError: `휴장일 조회 실패: ${(err as Error).message}` };
      try { saveCalendar(next, e); } catch { }
      return next;
    } finally { inflight = null; }
  })();
  return inflight;
}

export function resetCalendarRetry() { lastTry = 0; }

const PROBE = "005930";
const probeDone = new Set<string>();
let started: { date: string; at: number; v: boolean } | null = null;

async function krVolume(e: Env, client?: KisClient): Promise<number | null> {
  const c = client ?? (() => { const q = quoteCredentials(runtimeEnv(e)) ?? realCredentials(e); return q ? getClient(q) : null; })();
  if (!c) return null;
  return (await kisQuote(c, PROBE)).volume;
}

/** 한국 장 시작 1분 뒤에도 거래가 없으면(수능일·전산 장애) 그날은 늦게 연다고 적어 둠 */
export async function detectLateOpen(e: Env = process.env, opts: { now?: number; client?: KisClient } = {}): Promise<boolean | null> {
  const now = opts.now ?? Date.now();
  const k = new Date(now + 9 * 3600_000).toISOString();
  const date = k.slice(0, 10), hm = k.slice(11, 16);
  if (hm < "09:01" || hm >= "09:30" || probeDone.has(date)) return null;
  const t = tradingDay("KR", date, e);
  if (!t.open || t.openAt) { probeDone.add(date); return null; }
  const vol = await krVolume(e, opts.client).catch(() => null);
  if (vol == null) return null;
  probeDone.add(date);
  if (vol > 0) return false;
  const cur = loadCalendar(e);
  saveCalendar({ ...cur, krLate: { ...Object.fromEntries(Object.entries(cur.krLate ?? {}).filter(([d]) => d >= addDays(date, -400))), [date]: LATE_OPEN } }, e);
  return true;
}

/** 오늘 한국 장에서 거래가 시작됐는지 (1분 동안 기억). 모르면 null */
export async function krTradingStarted(e: Env = process.env, opts: { now?: number; client?: KisClient } = {}): Promise<boolean | null> {
  const now = opts.now ?? Date.now();
  const date = kstDate(now);
  if (started && started.date === date && (started.v || now - started.at < 60_000)) return started.v;
  const vol = await krVolume(e, opts.client).catch(() => null);
  if (vol == null) return null;
  started = { date, at: now, v: vol > 0 };
  return started.v;
}

export function resetProbe() { probeDone.clear(); started = null; }
