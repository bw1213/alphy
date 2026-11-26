import fs from "fs";
import path from "path";
import { configDir, loadSettings } from "../settings/store";
import { getUser, listUsers, type User } from "../settings/users";
import type { Holding } from "../kis/trading";
import { formatReport, runEvening, type EveningReport } from "./evening";
import { appendLog, loadPlan, savePlan } from "./store";
import { autoLimitFor, extraKisAccounts, kisAccountIds, kisAccountName, kisEnvFor } from "../kis/userkeys";
import { tradeEnv } from "../kis/config";
import { addPoint, flowsAfter, loadPerf, perfFor, savePerf } from "./perf";
import { notify, notifyMany } from "./telegram";
import { cleanHm, isWeekday, kst } from "./time";
import { HOLIDAY, formatDay, loadDay, loadDays, morningFollow, morningStart, saveDay, unfinishedItems, type MorningDay, type MorningLimits } from "./morning";
import { brokerFor } from "./broker";
import { addUsage, usedToday } from "../kis/limits";
import { orderLimitFor } from "../kis/userkeys";
import { loadLog } from "./store";
import { intradayCheck, intradayStart, loadIntradayDay, saveIntradayDay } from "./intraday";
import { formatManual, manualEveningFor } from "../manual/evening";
import { loadAccounts } from "../manual/store";
import { KIS_ID, kisViewOf, loadHistory, refreshHistory, saveHistory, withKisView, type KisRaw, type KisView } from "../manual/value";
import { hasKisAccount, kisReader } from "../manual/kis";
import { clockOf, isMixed, krSession, planMarket, planMarkets, US_SESSION, type Market, type Session } from "./session";
import { withCode } from "../strategies/universe";
import { sessionOn } from "./calendar";
import { addDays, detectLateOpen, krTradingStarted, refreshKrCalendar, tradingDay } from "../market/holidays";

type Env = Record<string, string | undefined>;

interface Slot { date: string; attempts: number; lastTry: number; done: boolean }
export interface SchedState { evening?: Slot; mix?: Slot }

const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;

const statePath = (e: Env) => path.join(configDir(e), "auto-state.json");
export function loadState(e: Env = process.env): SchedState {
  try { return JSON.parse(fs.readFileSync(statePath(e), "utf8")) ?? {}; } catch { return {}; }
}
function saveState(s: SchedState, e: Env) {
  const p = statePath(e);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export const eveningTime = (e: Env = process.env) => cleanHm(loadSettings(e).auto.eveningTime) ?? "18:00";
export const morningTimes = (e: Env = process.env) => {
  const a = loadSettings(e).auto;
  return { morning: cleanHm(a.morningTime) ?? "08:40", cutoff: cleanHm(a.cutoffTime) ?? "10:00" };
};

const FOLLOW_MS = 3 * 60_000;

export const sessionFor = (m: Market, e: Env = process.env, date?: string): Session => {
  const s = m === "US" ? US_SESSION : krSession(morningTimes(e));
  return date ? sessionOn(s, date, e) : s;
};
const marketsOf = (u: User, e: Env, acct: string): Market[] => { const p = loadPlan(u.id, e, acct); return p ? planMarkets(p) : ["KR"]; };

/** 운용이 있는 계좌만 (기본 계좌는 예전처럼 늘 봄) */
const planAccounts = (u: User, e: Env): string[] => kisAccountIds(u.id, e).filter((a) => a === KIS_ID || !!loadPlan(u.id, e, a));

/** 한국투자증권 계좌를 둘 이상 쓰면 알림 앞에 계좌 이름 */
export function tagFor(u: User, acct: string, e: Env = process.env): string {
  return extraKisAccounts(u.id, e).length ? `〔${kisAccountName(u.id, acct, e)}〕\n` : "";
}
const notifyAcct = (u: User, acct: string, text: string, e: Env) => notify(u.id, `${tagFor(u, acct, e)}${text}`, e)
  .catch((err) => { console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`); return false; });

/** 잔고를 읽을 수 있는 한국투자증권 계좌들의 잔고 읽기 */
export function kisReaders(u: User, e: Env = process.env): Record<string, () => Promise<KisRaw | null>> {
  const out: Record<string, () => Promise<KisRaw | null>> = {};
  for (const a of kisAccountIds(u.id, e)) if (hasKisAccount(u, e, a)) out[a] = kisReader(u, e, a);
  return out;
}

const limitsFor = (u: User, e: Env, acct: string): MorningLimits => ({
  orderLimit: orderLimitFor(u.id, e),
  realCap: autoLimitFor(u.id, e).realBudget,
  usedToday: () => usedToday(e, Date.now(), u.id, acct),
  addUsage: (a) => { addUsage(a, e, Date.now(), u.id, acct); },
});

export async function morningFor(u: User, now: number, e: Env = process.env, market: Market = "KR", acct: string = KIS_ID): Promise<void> {
  const k = clockOf(market, now);
  if (!isWeekday(k)) return;
  const ses = sessionFor(market, e, k.date);
  const cutoff = ses.cutoff;
  if (k.hm < ses.orderAt || k.hm > ses.close) return;
  const mk = market === "US" ? { market } : {};
  let d = loadDay(k.date, u.id, e, market, acct);
  if (!d) {
    if (k.hm >= cutoff) return;
    const plan = loadPlan(u.id, e, acct);
    if (!plan || !plan.enabled) return;
    const b = brokerFor(u, e, market, acct);
    // 먼저 "시작함"을 적어 두어 같은 날 두 번 주문하지 않게
    saveDay({ date: k.date, label: plan.label, env: b.env, ...mk, phase: "placed", items: [], log: [`${k.hm} 시작`] }, u.id, e, acct);
    try { d = await morningStart(plan, loadLog(u.id, e, acct), b, now, limitsFor(u, e, acct), market, Object.values(loadDays(u.id, e, acct))); }
    catch (err) { d = { date: k.date, label: plan.label, env: b.env, ...mk, phase: "skipped", items: [], reason: `시작 실패: ${(err as Error).message}`, log: [`${k.hm} 시작 실패: ${(err as Error).message}`] }; }
    saveDay(d, u.id, e, acct);
    if (d.items.some((x) => x.orderNo) || (d.phase === "skipped" && !/꺼져/.test(d.reason ?? "") && d.reason !== HOLIDAY)) {
      await notifyAcct(u, acct, formatDay(d, false), e);
    }
    if (d.phase === "done" || d.phase === "skipped") { d.notified = true; saveDay(d, u.id, e, acct); }
    console.log(`[auto] ${k.date} 아침 주문 ${u.id}/${acct}: ${d.phase} ${d.items.length}건 ${d.reason ?? ""}`);
    return;
  }
  if ((d.market ?? "KR") !== market) return;
  if ((d.phase === "placed" || d.phase === "buying") && k.hm >= ses.followFrom && (k.hm >= cutoff || now - (d.lastCheck ?? 0) >= FOLLOW_MS)) {
    // 장이 아직 안 열렸으면 미체결 취소를 미룸
    if (market === "KR" && k.hm >= cutoff && k.hm < "12:00" && (await krTradingStarted(e, { now })) === false) return;
    const before = new Map(d.items.map((it, i) => [i, it.filledQty]));
    d = await morningFollow(d, brokerFor(u, e, market, acct), now, cutoff, limitsFor(u, e, acct));
    saveDay(d, u.id, e, acct);
    const fills = fillMessages(d, before);
    if (fills) await notifyAcct(u, acct, fills, e);
  }
  if ((d.phase === "done" || d.phase === "stopped") && !d.notified && d.items.length) {
    d.notified = true;
    saveDay(d, u.id, e, acct);
    await notifyAcct(u, acct, formatDay(d, true), e);
  }
}

export function fillMessages(d: MorningDay, before: Map<number, number>): string {
  const lines: string[] = [];
  d.items.forEach((it, i) => {
    const prev = before.get(i) ?? 0;
    if (it.filledQty <= prev) return;
    const px = d.market === "US" ? `$${it.avgPrice.toFixed(2)}` : `${Math.round(it.avgPrice).toLocaleString("ko-KR")}원`;
    lines.push(`- ${it.side === "buy" ? "매수" : "매도"} ${withCode(it.name, it.ticker)} ${it.filledQty - prev}주 체결 (누적 ${it.filledQty}/${it.qty}주, 평균 ${px})`);
  });
  return lines.length ? [`[알피] ${d.date} 체결 · ${d.label} (${d.env === "real" ? "실전" : "모의투자"})`, ...lines].join("\n") : "";
}

let morningRunning = false;

export async function morningTick(now = Date.now(), e: Env = process.env): Promise<void> {
  if (morningRunning) return;
  morningRunning = true;
  try {
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      const user = getUser(u.id, e) ?? u;
      for (const a of planAccounts(user, e)) {
        for (const m of marketsOf(user, e, a)) {
          try { await morningFor(user, now, e, m, a); }
          catch (err) { console.error(`[auto] ${u.id}/${a} ${m} 주문 오류: ${(err as Error).message}`); }
        }
      }
    }
  } finally { morningRunning = false; }
}

const minutesAfter = (hm: string, n: number) => {
  const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) + n;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

export async function intradayFor(u: User, now: number, e: Env = process.env, market: Market = "KR", acct: string = KIS_ID): Promise<void> {
  const k = clockOf(market, now);
  const ses = sessionFor(market, e, k.date);
  if (!isWeekday(k) || k.hm < ses.watchFrom || k.hm > minutesAfter(ses.close, 10)) return;
  let d = loadIntradayDay(k.date, u.id, e, market, acct);
  const plan = loadPlan(u.id, e, acct);
  if (!d) {
    if (!plan) return;
    d = await intradayStart(plan, loadLog(u.id, e, acct), brokerFor(u, e, market, acct), now, market);
    saveIntradayDay(d, u.id, e, acct);
    console.log(`[auto] ${k.date} 장중 감시 ${u.id}/${acct}: ${d.done ? d.reason : `${d.levels.length}개 가격`}`);
  }
  if (d.done || (d.market ?? "KR") !== market) return;
  if (!plan?.enabled && !d.sells.some((s) => s.orderNo && !s.told)) {
    d = { ...d, done: true, reason: "운용이 꺼져 감시를 멈췄습니다.", log: [...d.log, `${k.hm} 운용이 꺼져 감시를 멈춤`] };
    saveIntradayDay(d, u.id, e, acct);
    return;
  }
  const b = brokerFor(u, e, market, acct);
  const { day, messages } = await intradayCheck(plan?.enabled ? d : { ...d, levels: [] }, b, now, limitsFor(u, e, acct));
  saveIntradayDay(day, u.id, e, acct);
  for (const m of messages) await notifyAcct(u, acct, m, e);
}

let intradayRunning = false;

export async function intradayTick(now = Date.now(), e: Env = process.env): Promise<void> {
  if (intradayRunning) return;
  intradayRunning = true;
  try {
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      const user = getUser(u.id, e) ?? u;
      for (const a of planAccounts(user, e)) {
        for (const m of marketsOf(user, e, a)) {
          try { await intradayFor(user, now, e, m, a); }
          catch (err) { console.error(`[auto] ${u.id}/${a} ${m} 장중 감시 오류: ${(err as Error).message}`); }
        }
      }
    }
  } finally { intradayRunning = false; }
}

export function eveningDue(now: number, st: SchedState, time: string): boolean {
  const k = kst(now);
  if (!isWeekday(k) || k.hm < time) return false;
  return slotDue(now, st.evening);
}

export const MIX_TIME = "07:00";
const MIX_UNTIL = "22:00";

// 섞은 운용: 전날 어느 한 시장이라도 열렸으면 한국 아침에 계산 (미국 장 시작 전까지 다시 시도)
export function mixDue(now: number, st: SchedState, e: Env = process.env): boolean {
  const k = kst(now);
  if (k.hm < MIX_TIME || k.hm >= MIX_UNTIL) return false;
  const y = addDays(k.date, -1);
  if (!tradingDay("KR", y, e).open && !tradingDay("US", y, e).open) return false;
  return slotDue(now, st.mix);
}

function slotDue(now: number, ev: Slot | undefined): boolean {
  const k = kst(now);
  if (!ev || ev.date !== k.date) return true;
  if (ev.done || ev.attempts >= MAX_ATTEMPTS) return false;
  return now - ev.lastTry >= RETRY_MS;
}

export async function accountSnapshot(u: User, market: Market | Market[] = "KR", e: Env = process.env, now = Date.now(), acct: string = KIS_ID) {
  const ms = Array.isArray(market) ? market : [market];
  const raw = await kisReader(u, e, acct)();
  if (!raw) throw new Error("계좌번호가 설정되지 않았습니다");
  // 미국 잔고를 못 읽었으면 보유 0주로 보고 또 사지 않게 실패로
  if (ms.includes("US") && raw.note) throw new Error(raw.note);
  const prices = loadHistory(u.id, e).prices;
  const view = kisViewOf(raw, prices, now);
  const fx = raw.us?.fx && raw.us.fx > 0 ? raw.us.fx : prices?.fx ?? 0;
  const kr = raw.kr.holdings as Holding[], us = (raw.us?.holdings ?? []) as Holding[];
  const holdings: Holding[] = ms.length > 1
    ? [...kr, ...us.map((h) => ({ ...h, price: h.price * fx, avgPrice: h.avgPrice * fx, value: h.value * fx }))]
    : ms[0] === "US" ? us : kr;
  const count = raw.kr.holdings.length + (raw.us?.holdings.length ?? 0);
  // 평가액을 정확히 모르는 날은 손실 한도를 엉뚱한 값으로 판단하지 않게 비움
  const exact = !view.partial && view.positions.length === count;
  const stock = view.positions.reduce((a, p) => a + p.value, 0);
  return {
    env: raw.env, holdings, view,
    ...(exact ? { total: view.total, cash: view.cash, stock: Math.round(stock) } : {}),
    ...(view.note ? { note: view.note } : {}),
  };
}

export async function eveningFor(u: User, trigger: EveningReport["trigger"], opts: { notify?: boolean; e?: Env; mixed?: boolean; acct?: string } = {}): Promise<EveningReport | null> {
  const e = opts.e ?? process.env;
  const acct = opts.acct ?? KIS_ID;
  const plan = loadPlan(u.id, e, acct);
  if (!plan) return null;
  if (trigger === "schedule" && (!plan.enabled || isMixed(plan) !== !!opts.mixed)) return null;
  const perf = perfFor(loadPerf(u.id, e, acct), plan, tradeEnv(kisEnvFor(u, e, acct)));
  const market = planMarket(plan);
  const markets = planMarkets(plan);
  const mixed = markets.length > 1;
  const prevDataDate = (market === "US" || mixed) && trigger === "schedule"
    ? loadLog(u.id, e, acct).find((x) => x.status === "ok" && x.label === plan.label && (mixed ? (x.markets?.length ?? 0) > 1 : x.market === "US") && !(plan.updatedAt && plan.updatedAt > x.ranAt))?.dataDate : undefined;
  const days = Object.values(loadDays(u.id, e, acct));
  const unfinished = markets.flatMap((m) => unfinishedItems(days, plan.label, m, clockOf(m).date));
  let seen: KisView | undefined;
  const holdings = async () => { const s = await accountSnapshot(u, markets, e, Date.now(), acct); seen = s.view; return s; };
  const flow = flowsAfter(perf.base, loadHistory(u.id, e).flows?.[acct] ?? []);
  const r = await runEvening(plan, trigger, { user: u.id, holdings, env: e, maxLoss: autoLimitFor(u.id, e).maxLoss, accountBase: perf.base ? perf.base.total + flow : undefined, prevDataDate, unfinished });
  appendLog(r, u.id, e, acct);
  if (seen) { try { saveHistory(withKisView(loadHistory(u.id, e), acct, seen), u.id, e); } catch { } }
  if (r.status === "ok" && r.equity != null) {
    try { savePerf(addPoint(perf, { date: r.runDate, total: r.accountTotal, cash: r.accountCash, stock: r.accountStock, strategy: r.equity, flow }), u.id, e, acct); }
    catch (err) { console.error(`[auto] ${u.id}/${acct} 성과 기록 실패: ${(err as Error).message}`); }
  }
  if (r.lossStop && plan.enabled) savePlan({ ...plan, enabled: false, updatedAt: new Date().toISOString() }, u.id, e, acct);
  if (opts.notify !== false && r.status !== "holiday") await notifyAcct(u, acct, formatReport(r), e);
  return r;
}

let running = false;

export async function tick(now = Date.now(), e: Env = process.env): Promise<void> {
  if (running) return;
  const st = loadState(e);
  if (!eveningDue(now, st, eveningTime(e))) return;
  running = true;
  const k = kst(now);
  const prev = st.evening?.date === k.date ? st.evening : undefined;
  saveState({ ...st, evening: { date: k.date, attempts: (prev?.attempts ?? 0) + 1, lastTry: now, done: false } }, e);
  try {
    let ok = 0, fail = 0;
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      const user = getUser(u.id, e) ?? u;
      const strategy: Record<string, number | undefined> = {};
      const parts: string[] = [];
      for (const a of planAccounts(user, e)) {
        try {
          const r = await eveningFor(user, "schedule", { e, notify: false, acct: a });
          if (r && r.status !== "holiday") parts.push(`${tagFor(user, a, e)}${formatReport(r)}`);
          if (r) {
            if (r.status === "error") fail++; else ok++;
            if (r.status === "ok") strategy[a] = r.equity;
            console.log(`[auto] ${k.date} 저녁 계산 ${u.id}/${a}: ${r.status}${r.error ? ` ${r.error}` : ""} 주문 ${r.orders.length}건`);
          } else {
            const p = loadPlan(u.id, e, a);
            if (p?.enabled && isMixed(p)) strategy[a] = loadLog(u.id, e, a).find((x) => x.status === "ok" && x.label === p.label)?.equity;
          }
        } catch (err) { fail++; console.error(`[auto] ${u.id}/${a} 저녁 계산 오류: ${(err as Error).message}`); }
      }
      try {
        const m = await manualEveningFor(u.id, "schedule", { e, notify: false });
        ok += m.ok; fail += m.fail;
        const accts = loadAccounts(u.id, e);
        for (const [id, r] of Object.entries(m.reports)) {
          const a = accts.find((x) => x.id === id);
          if (a && r.status !== "holiday") parts.push(formatManual(a, r));
        }
        for (const [id, r] of Object.entries(m.reports)) if (r.status === "ok") strategy[id] = r.equity;
        if (m.ok + m.fail) console.log(`[manual] ${k.date} 저녁 계산 ${u.id}: ${m.ok + m.fail}개 계좌 (실패 ${m.fail})`);
      } catch (err) { fail++; console.error(`[manual] ${u.id} 저녁 계산 오류: ${(err as Error).message}`); }
      try { await notifyMany(u.id, parts, parts.length > 1 ? `저녁 계산 ${k.date} · 계좌 ${parts.length}개` : "", e); }
      catch (err) { console.error(`[auto] ${u.id} 텔레그램 알림 실패: ${(err as Error).message}`); }
      try {
        const kis = kisReaders(user, e);
        if (loadAccounts(u.id, e).length || Object.keys(kis).length) {
          const h = await refreshHistory(u.id, { e, strategy, kis });
          for (const w of h.warnings) console.log(`[dashboard] ${u.id}: ${w}`);
        }
      } catch (err) { console.error(`[dashboard] ${u.id} 기록 오류: ${(err as Error).message}`); }
    }
    const cur = loadState(e);
    const attempts = cur.evening?.attempts ?? 1;
    saveState({ ...cur, evening: { date: k.date, attempts, lastTry: now, done: !(fail > 0 && ok === 0) } }, e);
  } finally { running = false; }
}

let mixRunning = false;

export async function mixTick(now = Date.now(), e: Env = process.env): Promise<void> {
  if (mixRunning) return;
  const st = loadState(e);
  if (!mixDue(now, st, e)) return;
  mixRunning = true;
  const k = kst(now);
  const prev = st.mix?.date === k.date ? st.mix : undefined;
  saveState({ ...st, mix: { date: k.date, attempts: (prev?.attempts ?? 0) + 1, lastTry: now, done: false } }, e);
  try {
    let ok = 0, fail = 0;
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      const user = getUser(u.id, e) ?? u;
      for (const a of planAccounts(user, e)) {
        try {
          const r = await eveningFor(user, "schedule", { e, mixed: true, acct: a });
          if (!r) continue;
          if (r.status === "error") fail++; else ok++;
          console.log(`[auto] ${k.date} 섞은 운용 계산 ${u.id}/${a}: ${r.status}${r.error ? ` ${r.error}` : ""} 주문 ${r.orders.length}건`);
        } catch (err) { fail++; console.error(`[auto] ${u.id}/${a} 섞은 운용 계산 오류: ${(err as Error).message}`); }
      }
    }
    const cur = loadState(e);
    saveState({ ...cur, mix: { date: k.date, attempts: cur.mix?.attempts ?? 1, lastTry: now, done: !(fail > 0 && ok === 0) } }, e);
  } finally { mixRunning = false; }
}

let timer: ReturnType<typeof setInterval> | null = null;
let fastTimer: ReturnType<typeof setInterval> | null = null;
export const INTRADAY_MS = 15_000;

export function startScheduler(e: Env = process.env) {
  if (timer) return;
  const m = morningTimes(e);
  console.log(`[auto] 예약 실행기 시작 (평일 아침 주문 ${m.morning}~${m.cutoff}, 장중 매도 감시 09:00~15:20, 저녁 계산 ${eveningTime(e)} 이후)`);
  const run = () => {
    refreshKrCalendar(e).catch(() => undefined);
    detectLateOpen(e).then((late) => { if (late) console.log("[auto] 한국 장이 아직 열리지 않아 오늘은 10:00 개장으로 봅니다."); }).catch(() => undefined);
    tick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`));
    mixTick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`));
    morningTick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`));
  };
  timer = setInterval(run, 60_000);
  timer.unref?.();
  fastTimer = setInterval(() => intradayTick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`)), INTRADAY_MS);
  fastTimer.unref?.();
  setTimeout(run, 15_000).unref?.();
}
