/**
 * 예약 실행기 (서버 전용). 앱이 켜질 때 instrumentation.ts 에서 한 번 시작해 1분마다 시계를 봅니다.
 *
 * 저녁 계산: 평일 한국 시간 설정 시각(기본 18:00) 이후, 그날 아직 안 했으면 한 번.
 *   - NAS 가 꺼져 있다가 저녁 늦게 켜져도 그날 자정 전이면 실행합니다. 자정이 지나면 그날 몫은 건너뜁니다.
 *   - 시세를 못 받는 등 모두 실패하면 10분 뒤 다시, 하루 3번까지.
 *   - 실행 기록은 {설정 폴더}/auto-state.json 에 남겨 재시작해도 같은 날 두 번 돌지 않습니다.
 *
 * 아침 주문(lib/auto/morning.ts): 평일 주문 시각(기본 08:40) ~ 마감 시각(기본 10:00) 사이.
 *   주문 시각에 한 번 주문하고, 09:00 이후 3분마다 체결 확인, 마감 시각에 남은 주문 취소 후 결과 알림.
 *
 * 장중 실시간 매도(lib/auto/intraday.ts): 평일 09:00~15:20 동안 15초마다 현재가를 보고 매도 가격에 닿으면 시장가 매도.
 */
import fs from "fs";
import path from "path";
import { configDir, loadSettings } from "../settings/store";
import { getUser, listUsers, type User } from "../settings/users";
import { getClient } from "../kis/client";
import { tradeCredentialsFor } from "../kis/access";
import { getBalance } from "../kis/trading";
import { formatReport, runEvening, type EveningReport } from "./evening";
import { appendLog, loadPlan, savePlan } from "./store";
import { autoLimitFor, kisEnvFor } from "../kis/userkeys";
import { tradeEnv } from "../kis/config";
import { addPoint, loadPerf, perfFor, savePerf } from "./perf";
import { notify } from "./telegram";
import { cleanHm, isWeekday, kst } from "./time";
import { formatDay, loadDay, morningFollow, morningStart, saveDay, type MorningLimits } from "./morning";
import { brokerFor } from "./broker";
import { addUsage, usedToday } from "../kis/limits";
import { orderLimitFor } from "../kis/userkeys";
import { loadLog } from "./store";
import { intradayCheck, intradayStart, loadIntradayDay, saveIntradayDay } from "./intraday";
import { clockOf, krSession, planMarket, US_SESSION, type Market, type Session } from "./session";

type Env = Record<string, string | undefined>;

export interface SchedState { evening?: { date: string; attempts: number; lastTry: number; done: boolean } }

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

/** 그 시장의 하루 일정 (한국은 관리자가 정한 시각) */
export const sessionFor = (m: Market, e: Env = process.env): Session => (m === "US" ? US_SESSION : krSession(morningTimes(e)));
/** 그 사람이 운용하는 시장 (운용이 없으면 한국) */
const marketOfUser = (u: User, e: Env): Market => { const p = loadPlan(u.id, e); return p ? planMarket(p) : "KR"; };

const limitsFor = (u: User, e: Env): MorningLimits => ({
  orderLimit: orderLimitFor(u.id, e),
  realCap: autoLimitFor(u.id, e).realBudget,
  usedToday: () => usedToday(e, Date.now(), u.id),
  addUsage: (a) => { addUsage(a, e, Date.now(), u.id); },
});

/** 한 사람의 아침 일: 시작 또는 이어 하기. 알림까지 */
export async function morningFor(u: User, now: number, e: Env = process.env): Promise<void> {
  const market = marketOfUser(u, e);
  const k = clockOf(market, now);
  if (!isWeekday(k)) return;
  const ses = sessionFor(market, e);
  const cutoff = ses.cutoff;
  if (k.hm < ses.orderAt || k.hm > ses.close) return;
  const mk = market === "US" ? { market } : {};
  let d = loadDay(k.date, u.id, e);
  if (!d) {
    if (k.hm >= cutoff) return;
    const plan = loadPlan(u.id, e);
    if (!plan || !plan.enabled) return;
    const b = brokerFor(u, e, market);
    // 먼저 "시작함"을 적어 두어 같은 날 두 번 주문하지 않게
    saveDay({ date: k.date, label: plan.label, env: b.env, ...mk, phase: "placed", items: [], log: [`${k.hm} 시작`] }, u.id, e);
    try { d = await morningStart(plan, loadLog(u.id, e), b, now, limitsFor(u, e), market); }
    catch (err) { d = { date: k.date, label: plan.label, env: b.env, ...mk, phase: "skipped", items: [], reason: `시작 실패: ${(err as Error).message}`, log: [`${k.hm} 시작 실패: ${(err as Error).message}`] }; }
    saveDay(d, u.id, e);
    if (d.items.some((x) => x.orderNo) || (d.phase === "skipped" && !/꺼져/.test(d.reason ?? ""))) {
      await notify(u.id, formatDay(d, false), e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
    }
    if (d.phase === "done" || d.phase === "skipped") { d.notified = true; saveDay(d, u.id, e); }
    console.log(`[auto] ${k.date} 아침 주문 ${u.id}: ${d.phase} ${d.items.length}건 ${d.reason ?? ""}`);
    return;
  }
  if ((d.market ?? "KR") !== market) return; // 그날 기록이 다른 시장 것이면 건드리지 않음
  if ((d.phase === "placed" || d.phase === "buying") && k.hm >= ses.followFrom && (k.hm >= cutoff || now - (d.lastCheck ?? 0) >= FOLLOW_MS)) {
    d = await morningFollow(d, brokerFor(u, e, market), now, cutoff, limitsFor(u, e));
    saveDay(d, u.id, e);
  }
  if ((d.phase === "done" || d.phase === "stopped") && !d.notified && d.items.length) {
    d.notified = true;
    saveDay(d, u.id, e);
    await notify(u.id, formatDay(d, true), e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
  }
}

let morningRunning = false;

export async function morningTick(now = Date.now(), e: Env = process.env): Promise<void> {
  // 시장마다 시간이 달라(한국 아침, 미국은 한국 밤) 요일·시각은 사람별로 morningFor 가 봄
  if (morningRunning) return;
  morningRunning = true;
  try {
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      try { await morningFor(getUser(u.id, e) ?? u, now, e); }
      catch (err) { console.error(`[auto] ${u.id} 아침 주문 오류: ${(err as Error).message}`); }
    }
  } finally { morningRunning = false; }
}

/** "15:30" 에 n 분 더한 시각 */
const minutesAfter = (hm: string, n: number) => {
  const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) + n;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** 한 사람의 장중 감시 한 번 */
export async function intradayFor(u: User, now: number, e: Env = process.env): Promise<void> {
  const market = marketOfUser(u, e);
  const k = clockOf(market, now);
  const ses = sessionFor(market, e);
  if (!isWeekday(k) || k.hm < ses.watchFrom || k.hm > minutesAfter(ses.close, 10)) return;
  let d = loadIntradayDay(k.date, u.id, e);
  const plan = loadPlan(u.id, e);
  if (!d) {
    if (!plan) return;
    d = await intradayStart(plan, loadLog(u.id, e), brokerFor(u, e, market), now, market);
    saveIntradayDay(d, u.id, e);
    console.log(`[auto] ${k.date} 장중 감시 ${u.id}: ${d.done ? d.reason : `${d.levels.length}개 가격`}`);
  }
  if (d.done || (d.market ?? "KR") !== market) return;
  // 운용을 끄거나 긴급 정지하면 그날 감시도 멈춤 (이미 낸 주문의 체결 확인은 계속)
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
      try { await intradayFor(getUser(u.id, e) ?? u, now, e); }
      catch (err) { console.error(`[auto] ${u.id} 장중 감시 오류: ${(err as Error).message}`); }
    }
  } finally { intradayRunning = false; }
}

/** 지금 저녁 계산을 해야 하는지 */
export function eveningDue(now: number, st: SchedState, time: string): boolean {
  const k = kst(now);
  if (!isWeekday(k) || k.hm < time) return false;
  const ev = st.evening;
  if (!ev || ev.date !== k.date) return true;
  if (ev.done || ev.attempts >= MAX_ATTEMPTS) return false;
  return now - ev.lastTry >= RETRY_MS;
}

/** 계좌 보유 읽기 (그 사람의 주문용 앱키·계좌). 미국 운용이면 해외 잔고와 원화로 합친 총자산 */
export const accountHoldings = (u: User, market: Market = "KR", e: Env = process.env) => async () => {
  if (market === "US") {
    const b = await brokerFor(u, e, "US").balance();
    return { env: b.env, holdings: b.holdings, ...(b.totalValue > 0 ? { total: b.totalValue } : {}) };
  }
  const b = await getBalance(getClient(tradeCredentialsFor(u)));
  return { env: b.env, holdings: b.holdings, total: b.totalValue, cash: b.cash, stock: b.stockValue };
};

/** 한 사람의 저녁 계산 + 기록 + 알림 */
export async function eveningFor(u: User, trigger: EveningReport["trigger"], opts: { notify?: boolean; e?: Env } = {}): Promise<EveningReport | null> {
  const e = opts.e ?? process.env;
  const plan = loadPlan(u.id, e);
  if (!plan) return null;
  if (trigger === "schedule" && !plan.enabled) return null;
  const perf = perfFor(loadPerf(u.id, e), plan, tradeEnv(kisEnvFor(u, e)));
  const market = planMarket(plan);
  // 미국: 지난 정상 계산 뒤로 새 시세가 없으면(미국 휴장) 건너뜀. 직접 "지금 계산해 보기"는 그대로 계산
  const prevDataDate = market === "US" && trigger === "schedule" ? loadLog(u.id, e).find((x) => x.status === "ok" && x.label === plan.label && x.market === "US" && !(plan.updatedAt && plan.updatedAt > x.ranAt))?.dataDate : undefined;
  const r = await runEvening(plan, trigger, { holdings: accountHoldings(u, market, e), env: e, maxLoss: autoLimitFor(u.id, e).maxLoss, accountBase: perf.base?.total, prevDataDate });
  appendLog(r, u.id, e);
  // 매일 성과 기록: 계좌 평가액과 전략 평가액 (첫날의 계좌 평가액이 기준이 됨)
  if (r.status === "ok" && r.equity != null) {
    try { savePerf(addPoint(perf, { date: r.runDate, total: r.accountTotal, cash: r.accountCash, stock: r.accountStock, strategy: r.equity }), u.id, e); }
    catch (err) { console.error(`[auto] ${u.id} 성과 기록 실패: ${(err as Error).message}`); }
  }
  // 손실 한도에 닿으면 운용을 끔 (다시 켜는 건 사람이)
  if (r.lossStop && plan.enabled) savePlan({ ...plan, enabled: false, updatedAt: new Date().toISOString() }, u.id, e);
  // 휴장일은 조용히 넘어감 (기록만)
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
      try {
        const r = await eveningFor(getUser(u.id, e) ?? u, "schedule", { e });
        if (!r) continue;
        if (r.status === "error") fail++; else ok++;
        console.log(`[auto] ${k.date} 저녁 계산 ${u.id}: ${r.status}${r.error ? ` ${r.error}` : ""} 주문 ${r.orders.length}건`);
      } catch (err) { fail++; console.error(`[auto] ${u.id} 저녁 계산 오류: ${(err as Error).message}`); }
    }
    const cur = loadState(e);
    const attempts = cur.evening?.attempts ?? 1;
    // 모두 실패했으면 다시 시도할 수 있게 done=false 로 둠
    saveState({ ...cur, evening: { date: k.date, attempts, lastTry: now, done: !(fail > 0 && ok === 0) } }, e);
  } finally { running = false; }
}

let timer: ReturnType<typeof setInterval> | null = null;
let fastTimer: ReturnType<typeof setInterval> | null = null;
/** 장중 감시 간격 */
export const INTRADAY_MS = 15_000;

export function startScheduler(e: Env = process.env) {
  if (timer) return;
  const m = morningTimes(e);
  console.log(`[auto] 예약 실행기 시작 (평일 아침 주문 ${m.morning}~${m.cutoff}, 장중 매도 감시 09:00~15:20, 저녁 계산 ${eveningTime(e)} 이후)`);
  const run = () => {
    tick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`));
    morningTick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`));
  };
  timer = setInterval(run, 60_000);
  timer.unref?.();
  fastTimer = setInterval(() => intradayTick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`)), INTRADAY_MS);
  fastTimer.unref?.();
  setTimeout(run, 15_000).unref?.();
}
