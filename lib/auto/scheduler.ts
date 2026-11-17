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
import type { Holding } from "../kis/trading";
import { formatReport, runEvening, type EveningReport } from "./evening";
import { appendLog, loadPlan, savePlan } from "./store";
import { autoLimitFor, kisEnvFor } from "../kis/userkeys";
import { tradeEnv } from "../kis/config";
import { addPoint, loadPerf, perfFor, savePerf } from "./perf";
import { notify } from "./telegram";
import { cleanHm, isWeekday, kst } from "./time";
import { formatDay, loadDay, morningFollow, morningStart, saveDay, type MorningDay, type MorningLimits } from "./morning";
import { brokerFor } from "./broker";
import { addUsage, usedToday } from "../kis/limits";
import { orderLimitFor } from "../kis/userkeys";
import { loadLog } from "./store";
import { intradayCheck, intradayStart, loadIntradayDay, saveIntradayDay } from "./intraday";
import { manualEveningFor } from "../manual/evening";
import { loadAccounts } from "../manual/store";
import { KIS_ID, kisViewOf, loadHistory, refreshHistory, saveHistory, type KisView } from "../manual/value";
import { hasKisAccount, kisReader } from "../manual/kis";
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
  let d = loadDay(k.date, u.id, e, market);
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
    const before = new Map(d.items.map((it, i) => [i, it.filledQty]));
    d = await morningFollow(d, brokerFor(u, e, market), now, cutoff, limitsFor(u, e));
    saveDay(d, u.id, e);
    // 새로 체결된 만큼 바로 알림 (끝난 뒤 결과 알림은 따로)
    const fills = fillMessages(d, before);
    if (fills) await notify(u.id, fills, e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
  }
  if ((d.phase === "done" || d.phase === "stopped") && !d.notified && d.items.length) {
    d.notified = true;
    saveDay(d, u.id, e);
    await notify(u.id, formatDay(d, true), e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
  }
}

/** 아침 주문 중 지난번 확인 뒤 새로 체결된 것 (없으면 빈 글) */
export function fillMessages(d: MorningDay, before: Map<number, number>): string {
  const lines: string[] = [];
  d.items.forEach((it, i) => {
    const prev = before.get(i) ?? 0;
    if (it.filledQty <= prev) return;
    const px = d.market === "US" ? `$${it.avgPrice.toFixed(2)}` : `${Math.round(it.avgPrice).toLocaleString("ko-KR")}원`;
    lines.push(`- ${it.side === "buy" ? "매수" : "매도"} ${it.name} ${it.filledQty - prev}주 체결 (누적 ${it.filledQty}/${it.qty}주, 평균 ${px})`);
  });
  return lines.length ? [`[알피] ${d.date} 체결 · ${d.label} (${d.env === "real" ? "실전" : "모의투자"})`, ...lines].join("\n") : "";
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
  let d = loadIntradayDay(k.date, u.id, e, market);
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

/**
 * 자동 매매 계좌 읽기 (그 사람의 주문용 계좌, 조회만).
 *   holdings  주문 수량 계산용: 운용하는 시장(국내 또는 미국)의 보유
 *   total     계좌 평가액: 국내+미국 주식과 원화·달러 예수금을 원화로 합친 값 (대시보드와 같은 계산)
 * 평가액을 정확히 모르면(미국 종목을 원화로 못 바꿈) total 을 비워 손실 한도가 엉뚱한 값으로 판단하지 않게 함.
 */
export async function accountSnapshot(u: User, market: Market = "KR", e: Env = process.env, now = Date.now()) {
  const raw = await kisReader(u, e)();
  if (!raw) throw new Error("계좌번호가 설정되지 않았습니다");
  // 미국 운용인데 미국 잔고를 못 읽었으면 보유 0주로 보고 또 사지 않게 실패로
  if (market === "US" && raw.note) throw new Error(raw.note);
  const view = kisViewOf(raw, loadHistory(u.id, e).prices, now);
  const holdings = (market === "US" ? raw.us?.holdings ?? [] : raw.kr.holdings) as Holding[];
  const count = raw.kr.holdings.length + (raw.us?.holdings.length ?? 0);
  // 총자산을 못 읽어 달러 예수금이 빠진 날, 미국 종목을 원화로 못 바꾼 날은 손익 계산에 쓰지 않음
  const exact = !view.partial && (view.positions.length === count || !!raw.us?.totalAsset);
  const stock = view.positions.reduce((a, p) => a + p.value, 0);
  return {
    env: raw.env, holdings, view,
    ...(exact ? { total: view.total, cash: view.cash, stock: Math.round(stock) } : {}),
    ...(view.note ? { note: view.note } : {}),
  };
}

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
  // 읽은 계좌는 자동 매매·대시보드 화면의 "지금 계좌"에도 남김
  let seen: KisView | undefined;
  const holdings = async () => { const s = await accountSnapshot(u, market, e); seen = s.view; return s; };
  const r = await runEvening(plan, trigger, { holdings, env: e, maxLoss: autoLimitFor(u.id, e).maxLoss, accountBase: perf.base?.total, prevDataDate });
  appendLog(r, u.id, e);
  if (seen) { try { saveHistory({ ...loadHistory(u.id, e), kis: seen }, u.id, e); } catch { /* 화면용이라 무시 */ } }
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
      const user = getUser(u.id, e) ?? u;
      const strategy: Record<string, number | undefined> = {};
      try {
        const r = await eveningFor(user, "schedule", { e });
        if (r) {
          if (r.status === "error") fail++; else ok++;
          if (r.status === "ok") strategy[KIS_ID] = r.equity;
          console.log(`[auto] ${k.date} 저녁 계산 ${u.id}: ${r.status}${r.error ? ` ${r.error}` : ""} 주문 ${r.orders.length}건`);
        }
      } catch (err) { fail++; console.error(`[auto] ${u.id} 저녁 계산 오류: ${(err as Error).message}`); }
      // 수동 계좌 (토스·미래에셋 등): 계산·안내만
      try {
        const m = await manualEveningFor(u.id, "schedule", { e });
        ok += m.ok; fail += m.fail;
        for (const [id, r] of Object.entries(m.reports)) if (r.status === "ok") strategy[id] = r.equity;
        if (m.ok + m.fail) console.log(`[manual] ${k.date} 저녁 계산 ${u.id}: ${m.ok + m.fail}개 계좌 (실패 ${m.fail})`);
      } catch (err) { fail++; console.error(`[manual] ${u.id} 저녁 계산 오류: ${(err as Error).message}`); }
      // 대시보드 기록: 수동 계좌 평가액 + 한국투자증권 잔고 (하루 한 점)
      try {
        if (loadAccounts(u.id, e).length || hasKisAccount(user, e)) {
          const h = await refreshHistory(u.id, { e, strategy, kis: hasKisAccount(user, e) ? kisReader(user, e) : undefined });
          for (const w of h.warnings) console.log(`[dashboard] ${u.id}: ${w}`);
        }
      } catch (err) { console.error(`[dashboard] ${u.id} 기록 오류: ${(err as Error).message}`); }
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
