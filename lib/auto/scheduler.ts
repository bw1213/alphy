import fs from "fs";
import path from "path";
import { configDir, loadSettings } from "../settings/store";
import { getUser, listUsers, type User } from "../settings/users";
import type { Holding } from "../kis/trading";
import { formatReport, runEvening, type EveningReport } from "./evening";
import { appendLog, loadPlan, savePlan } from "./store";
import { autoLimitFor, kisEnvFor } from "../kis/userkeys";
import { tradeEnv } from "../kis/config";
import { addPoint, loadPerf, perfFor, savePerf } from "./perf";
import { notify } from "./telegram";
import { cleanHm, isWeekday, kst } from "./time";
import { HOLIDAY, formatDay, loadDay, loadDays, morningFollow, morningStart, saveDay, unfinishedItems, type MorningDay, type MorningLimits } from "./morning";
import { brokerFor } from "./broker";
import { addUsage, usedToday } from "../kis/limits";
import { orderLimitFor } from "../kis/userkeys";
import { loadLog } from "./store";
import { intradayCheck, intradayStart, loadIntradayDay, saveIntradayDay } from "./intraday";
import { manualEveningFor } from "../manual/evening";
import { loadAccounts } from "../manual/store";
import { KIS_ID, kisViewOf, loadHistory, refreshHistory, saveHistory, type KisView } from "../manual/value";
import { hasKisAccount, kisReader } from "../manual/kis";
import { clockOf, isMixed, krSession, planMarket, planMarkets, US_SESSION, type Market, type Session } from "./session";
import { withCode } from "../strategies/universe";
import { sessionOn } from "./calendar";
import { refreshKrCalendar } from "../market/holidays";

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
const marketsOfUser = (u: User, e: Env): Market[] => { const p = loadPlan(u.id, e); return p ? planMarkets(p) : ["KR"]; };

const limitsFor = (u: User, e: Env): MorningLimits => ({
  orderLimit: orderLimitFor(u.id, e),
  realCap: autoLimitFor(u.id, e).realBudget,
  usedToday: () => usedToday(e, Date.now(), u.id),
  addUsage: (a) => { addUsage(a, e, Date.now(), u.id); },
});

export async function morningFor(u: User, now: number, e: Env = process.env, market: Market = "KR"): Promise<void> {
  const k = clockOf(market, now);
  if (!isWeekday(k)) return;
  const ses = sessionFor(market, e, k.date);
  const cutoff = ses.cutoff;
  if (k.hm < ses.orderAt || k.hm > ses.close) return;
  const mk = market === "US" ? { market } : {};
  let d = loadDay(k.date, u.id, e, market);
  if (!d) {
    if (k.hm >= cutoff) return;
    const plan = loadPlan(u.id, e);
    if (!plan || !plan.enabled) return;
    const b = brokerFor(u, e, market);
    // 먼저 "시작함"을 적어 두어 같은 날 두 번 주문하지 않게
    saveDay({ date: k.date, label: plan.label, env: b.env, ...mk, phase: "placed", items: [], log: [`${k.hm} 시작`] }, u.id, e);
    try { d = await morningStart(plan, loadLog(u.id, e), b, now, limitsFor(u, e), market, Object.values(loadDays(u.id, e))); }
    catch (err) { d = { date: k.date, label: plan.label, env: b.env, ...mk, phase: "skipped", items: [], reason: `시작 실패: ${(err as Error).message}`, log: [`${k.hm} 시작 실패: ${(err as Error).message}`] }; }
    saveDay(d, u.id, e);
    if (d.items.some((x) => x.orderNo) || (d.phase === "skipped" && !/꺼져/.test(d.reason ?? "") && d.reason !== HOLIDAY)) {
      await notify(u.id, formatDay(d, false), e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
    }
    if (d.phase === "done" || d.phase === "skipped") { d.notified = true; saveDay(d, u.id, e); }
    console.log(`[auto] ${k.date} 아침 주문 ${u.id}: ${d.phase} ${d.items.length}건 ${d.reason ?? ""}`);
    return;
  }
  if ((d.market ?? "KR") !== market) return;
  if ((d.phase === "placed" || d.phase === "buying") && k.hm >= ses.followFrom && (k.hm >= cutoff || now - (d.lastCheck ?? 0) >= FOLLOW_MS)) {
    const before = new Map(d.items.map((it, i) => [i, it.filledQty]));
    d = await morningFollow(d, brokerFor(u, e, market), now, cutoff, limitsFor(u, e));
    saveDay(d, u.id, e);
    const fills = fillMessages(d, before);
    if (fills) await notify(u.id, fills, e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
  }
  if ((d.phase === "done" || d.phase === "stopped") && !d.notified && d.items.length) {
    d.notified = true;
    saveDay(d, u.id, e);
    await notify(u.id, formatDay(d, true), e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
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
      for (const m of marketsOfUser(user, e)) {
        try { await morningFor(user, now, e, m); }
        catch (err) { console.error(`[auto] ${u.id} ${m} 주문 오류: ${(err as Error).message}`); }
      }
    }
  } finally { morningRunning = false; }
}

const minutesAfter = (hm: string, n: number) => {
  const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) + n;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

export async function intradayFor(u: User, now: number, e: Env = process.env, market: Market = "KR"): Promise<void> {
  const k = clockOf(market, now);
  const ses = sessionFor(market, e, k.date);
  if (!isWeekday(k) || k.hm < ses.watchFrom || k.hm > minutesAfter(ses.close, 10)) return;
  let d = loadIntradayDay(k.date, u.id, e, market);
  const plan = loadPlan(u.id, e);
  if (!d) {
    if (!plan) return;
    d = await intradayStart(plan, loadLog(u.id, e), brokerFor(u, e, market), now, market);
    saveIntradayDay(d, u.id, e);
    console.log(`[auto] ${k.date} 장중 감시 ${u.id}: ${d.done ? d.reason : `${d.levels.length}개 가격`}`);
  }
  if (d.done || (d.market ?? "KR") !== market) return;
  if (!plan?.enabled && !d.sells.some((s) => s.orderNo && !s.told)) {
    d = { ...d, done: true, reason: "운용이 꺼져 감시를 멈췄습니다.", log: [...d.log, `${k.hm} 운용이 꺼져 감시를 멈춤`] };
    saveIntradayDay(d, u.id, e);
    return;
  }
  const b = brokerFor(u, e, market);
  const { day, messages } = await intradayCheck(plan?.enabled ? d : { ...d, levels: [] }, b, now, limitsFor(u, e));
  saveIntradayDay(day, u.id, e);
  for (const m of messages) await notify(u.id, m, e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
}

let intradayRunning = false;

export async function intradayTick(now = Date.now(), e: Env = process.env): Promise<void> {
  if (intradayRunning) return;
  intradayRunning = true;
  try {
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      const user = getUser(u.id, e) ?? u;
      for (const m of marketsOfUser(user, e)) {
        try { await intradayFor(user, now, e, m); }
        catch (err) { console.error(`[auto] ${u.id} ${m} 장중 감시 오류: ${(err as Error).message}`); }
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

// 섞은 운용: 미국 장 마감 뒤 한국 아침에 계산 (월~토, 미국 장 시작 전까지 다시 시도)
export function mixDue(now: number, st: SchedState): boolean {
  const k = kst(now);
  if (k.dow === 0 || k.hm < MIX_TIME || k.hm >= MIX_UNTIL) return false;
  return slotDue(now, st.mix);
}

function slotDue(now: number, ev: Slot | undefined): boolean {
  const k = kst(now);
  if (!ev || ev.date !== k.date) return true;
  if (ev.done || ev.attempts >= MAX_ATTEMPTS) return false;
  return now - ev.lastTry >= RETRY_MS;
}

export async function accountSnapshot(u: User, market: Market | Market[] = "KR", e: Env = process.env, now = Date.now()) {
  const ms = Array.isArray(market) ? market : [market];
  const raw = await kisReader(u, e)();
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

export async function eveningFor(u: User, trigger: EveningReport["trigger"], opts: { notify?: boolean; e?: Env; mixed?: boolean } = {}): Promise<EveningReport | null> {
  const e = opts.e ?? process.env;
  const plan = loadPlan(u.id, e);
  if (!plan) return null;
  if (trigger === "schedule" && (!plan.enabled || isMixed(plan) !== !!opts.mixed)) return null;
  const perf = perfFor(loadPerf(u.id, e), plan, tradeEnv(kisEnvFor(u, e)));
  const market = planMarket(plan);
  const markets = planMarkets(plan);
  const mixed = markets.length > 1;
  const prevDataDate = (market === "US" || mixed) && trigger === "schedule"
    ? loadLog(u.id, e).find((x) => x.status === "ok" && x.label === plan.label && (mixed ? (x.markets?.length ?? 0) > 1 : x.market === "US") && !(plan.updatedAt && plan.updatedAt > x.ranAt))?.dataDate : undefined;
  const days = Object.values(loadDays(u.id, e));
  const unfinished = markets.flatMap((m) => unfinishedItems(days, plan.label, m, clockOf(m).date));
  let seen: KisView | undefined;
  const holdings = async () => { const s = await accountSnapshot(u, markets, e); seen = s.view; return s; };
  const r = await runEvening(plan, trigger, { holdings, env: e, maxLoss: autoLimitFor(u.id, e).maxLoss, accountBase: perf.base?.total, prevDataDate, unfinished });
  appendLog(r, u.id, e);
  if (seen) { try { saveHistory({ ...loadHistory(u.id, e), kis: seen }, u.id, e); } catch { } }
  if (r.status === "ok" && r.equity != null) {
    try { savePerf(addPoint(perf, { date: r.runDate, total: r.accountTotal, cash: r.accountCash, stock: r.accountStock, strategy: r.equity }), u.id, e); }
    catch (err) { console.error(`[auto] ${u.id} 성과 기록 실패: ${(err as Error).message}`); }
  }
  if (r.lossStop && plan.enabled) savePlan({ ...plan, enabled: false, updatedAt: new Date().toISOString() }, u.id, e);
  if (opts.notify !== false && r.status !== "holiday") {
    try { await notify(u.id, formatReport(r), e); } catch (err) { console.error(`[auto] ${u.id} 텔레그램 알림 실패: ${(err as Error).message}`); }
  }
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
      try {
        const r = await eveningFor(user, "schedule", { e });
        if (r) {
          if (r.status === "error") fail++; else ok++;
          if (r.status === "ok") strategy[KIS_ID] = r.equity;
          console.log(`[auto] ${k.date} 저녁 계산 ${u.id}: ${r.status}${r.error ? ` ${r.error}` : ""} 주문 ${r.orders.length}건`);
        } else {
          const p = loadPlan(u.id, e);
          if (p?.enabled && isMixed(p)) strategy[KIS_ID] = loadLog(u.id, e).find((x) => x.status === "ok" && x.label === p.label)?.equity;
        }
      } catch (err) { fail++; console.error(`[auto] ${u.id} 저녁 계산 오류: ${(err as Error).message}`); }
      try {
        const m = await manualEveningFor(u.id, "schedule", { e });
        ok += m.ok; fail += m.fail;
        for (const [id, r] of Object.entries(m.reports)) if (r.status === "ok") strategy[id] = r.equity;
        if (m.ok + m.fail) console.log(`[manual] ${k.date} 저녁 계산 ${u.id}: ${m.ok + m.fail}개 계좌 (실패 ${m.fail})`);
      } catch (err) { fail++; console.error(`[manual] ${u.id} 저녁 계산 오류: ${(err as Error).message}`); }
      try {
        if (loadAccounts(u.id, e).length || hasKisAccount(user, e)) {
          const h = await refreshHistory(u.id, { e, strategy, kis: hasKisAccount(user, e) ? kisReader(user, e) : undefined });
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
  if (!mixDue(now, st)) return;
  mixRunning = true;
  const k = kst(now);
  const prev = st.mix?.date === k.date ? st.mix : undefined;
  saveState({ ...st, mix: { date: k.date, attempts: (prev?.attempts ?? 0) + 1, lastTry: now, done: false } }, e);
  try {
    let ok = 0, fail = 0;
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      try {
        const r = await eveningFor(getUser(u.id, e) ?? u, "schedule", { e, mixed: true });
        if (!r) continue;
        if (r.status === "error") fail++; else ok++;
        console.log(`[auto] ${k.date} 섞은 운용 계산 ${u.id}: ${r.status}${r.error ? ` ${r.error}` : ""} 주문 ${r.orders.length}건`);
      } catch (err) { fail++; console.error(`[auto] ${u.id} 섞은 운용 계산 오류: ${(err as Error).message}`); }
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
