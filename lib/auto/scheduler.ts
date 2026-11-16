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
import { autoLimitFor } from "../kis/userkeys";
import { notify } from "./telegram";
import { cleanHm, isWeekday, kst } from "./time";
import { formatDay, loadDay, morningFollow, morningStart, saveDay, type MorningLimits } from "./morning";
import { brokerFor } from "./broker";
import { addUsage, usedToday } from "../kis/limits";
import { orderLimitFor } from "../kis/userkeys";
import { loadLog } from "./store";

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

const limitsFor = (u: User, e: Env): MorningLimits => ({
  orderLimit: orderLimitFor(u.id, e),
  realCap: autoLimitFor(u.id, e).realBudget,
  usedToday: () => usedToday(e, Date.now(), u.id),
  addUsage: (a) => { addUsage(a, e, Date.now(), u.id); },
});

/** 한 사람의 아침 일: 시작 또는 이어 하기. 알림까지 */
export async function morningFor(u: User, now: number, e: Env = process.env): Promise<void> {
  const k = kst(now);
  const { morning, cutoff } = morningTimes(e);
  let d = loadDay(k.date, u.id, e);
  if (!d) {
    if (k.hm < morning || k.hm >= cutoff) return;
    const plan = loadPlan(u.id, e);
    if (!plan || !plan.enabled) return;
    const b = brokerFor(u, e);
    // 먼저 "시작함"을 적어 두어 같은 날 두 번 주문하지 않게
    saveDay({ date: k.date, label: plan.label, env: b.env, phase: "placed", items: [], log: [`${k.hm} 시작`] }, u.id, e);
    try { d = await morningStart(plan, loadLog(u.id, e), b, now, limitsFor(u, e)); }
    catch (err) { d = { date: k.date, label: plan.label, env: b.env, phase: "skipped", items: [], reason: `시작 실패: ${(err as Error).message}`, log: [`${k.hm} 시작 실패: ${(err as Error).message}`] }; }
    saveDay(d, u.id, e);
    if (d.items.some((x) => x.orderNo) || (d.phase === "skipped" && !/꺼져/.test(d.reason ?? ""))) {
      await notify(u.id, formatDay(d, false), e).catch((err) => console.error(`[auto] ${u.id} 알림 실패: ${(err as Error).message}`));
    }
    if (d.phase === "done" || d.phase === "skipped") { d.notified = true; saveDay(d, u.id, e); }
    console.log(`[auto] ${k.date} 아침 주문 ${u.id}: ${d.phase} ${d.items.length}건 ${d.reason ?? ""}`);
    return;
  }
  if ((d.phase === "placed" || d.phase === "buying") && k.hm >= "09:00" && (k.hm >= cutoff || now - (d.lastCheck ?? 0) >= FOLLOW_MS)) {
    d = await morningFollow(d, brokerFor(u, e), now, cutoff, limitsFor(u, e));
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
  const k = kst(now);
  if (!isWeekday(k) || morningRunning) return;
  const { morning } = morningTimes(e);
  if (k.hm < morning || k.hm > "15:30") return;
  morningRunning = true;
  try {
    for (const u of listUsers(e)) {
      if (u.disabled) continue;
      try { await morningFor(getUser(u.id, e) ?? u, now, e); }
      catch (err) { console.error(`[auto] ${u.id} 아침 주문 오류: ${(err as Error).message}`); }
    }
  } finally { morningRunning = false; }
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

/** 계좌 보유 읽기 (그 사람의 주문용 앱키·계좌) */
export const accountHoldings = (u: User) => async () => {
  const b = await getBalance(getClient(tradeCredentialsFor(u)));
  return { env: b.env, holdings: b.holdings };
};

/** 한 사람의 저녁 계산 + 기록 + 알림 */
export async function eveningFor(u: User, trigger: EveningReport["trigger"], opts: { notify?: boolean; e?: Env } = {}): Promise<EveningReport | null> {
  const e = opts.e ?? process.env;
  const plan = loadPlan(u.id, e);
  if (!plan) return null;
  if (trigger === "schedule" && !plan.enabled) return null;
  const r = await runEvening(plan, trigger, { holdings: accountHoldings(u), env: e, maxLoss: autoLimitFor(u.id, e).maxLoss });
  appendLog(r, u.id, e);
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

export function startScheduler(e: Env = process.env) {
  if (timer) return;
  const m = morningTimes(e);
  console.log(`[auto] 예약 실행기 시작 (평일 아침 주문 ${m.morning}~${m.cutoff}, 저녁 계산 ${eveningTime(e)} 이후)`);
  const run = () => {
    tick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`));
    morningTick(Date.now(), e).catch((err) => console.error(`[auto] ${(err as Error).message}`));
  };
  timer = setInterval(run, 60_000);
  timer.unref?.();
  setTimeout(run, 15_000).unref?.();
}
