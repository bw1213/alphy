/**
 * 매일 성과 기록 (서버 전용): 저녁 계산 때 실제 계좌 평가액과 전략(백테스트) 평가액을 나란히 남긴다.
 *
 * 계좌에는 운용 금액 말고 다른 돈도 있을 수 있어, "운용을 시작한 날의 계좌 총평가액"을 기준(base)으로 잡고
 * 그 뒤 늘거나 준 금액에서 입금·출금(전체 계좌 화면의 입출금 기록)을 뺀 것을 자동 매매의 손익으로 본다.
 * 운용 전략(이름·시작일·운용 금액)이나 주문 계좌(모의↔실전)가 바뀌면 기록을 새로 시작한다.
 *
 * 저장: users/<사용자>/auto-perf.json
 */
import fs from "fs";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import type { AutoPlan } from "./store";

type Env = Record<string, string | undefined>;

export interface PerfPoint {
  date: string;
  /** 계좌 총평가액 (못 읽은 날은 없음) */
  total?: number;
  cash?: number;
  stock?: number;
  /** 자동 매매 손익 = 총평가액 − 기준 */
  pnl?: number;
  /** 전략(백테스트) 평가액. 운용 금액에서 출발 */
  strategy: number;
}

export interface PerfFile {
  /** 어떤 운용의 기록인지 (바뀌면 새로 시작) */
  key: string;
  env?: "real" | "mock";
  budget: number;
  /** 기준: 운용을 시작한 날 저녁의 계좌 총평가액 */
  base?: { date: string; total: number };
  points: PerfPoint[];
}

export const MAX_POINTS = 20_000;
export const perfKey = (p: Pick<AutoPlan, "label" | "startDate" | "budget">, env?: "real" | "mock") => `${p.label}|${p.startDate}|${p.budget}|${env ?? "?"}`;

export function loadPerf(user: string = OWNER_ID, e: Env = process.env): PerfFile | null {
  try { const j = JSON.parse(fs.readFileSync(userFile("auto-perf.json", user, e), "utf8")); return j && Array.isArray(j.points) ? j : null; } catch { return null; }
}
export function savePerf(f: PerfFile | null, user: string = OWNER_ID, e: Env = process.env) {
  writeUserFile("auto-perf.json", JSON.stringify(f ?? {}), user, e);
}

/** 이 운용의 기록 (운용이 바뀌었으면 빈 기록) */
export function perfFor(prev: PerfFile | null, plan: AutoPlan, env?: "real" | "mock"): PerfFile {
  const key = perfKey(plan, env);
  if (prev && prev.key === key) return prev;
  return { key, env, budget: plan.budget, points: [] };
}

/** 기준일 뒤 입금(+)·출금(−) 합: 손익에서 뺀다 */
export function flowsAfter(base: PerfFile["base"], flows: { date: string; amount: number }[]): number {
  return base ? flows.filter((f) => f.date > base.date).reduce((a, f) => a + f.amount, 0) : 0;
}

/** 그날 기록을 더함 (같은 날이면 바꿈). 기준이 없으면 오늘 계좌 평가액을 기준으로. flow = 기준 뒤 입출금 합 */
export function addPoint(f: PerfFile, p: { date: string; total?: number; cash?: number; stock?: number; strategy: number; flow?: number }): PerfFile {
  const base = f.base ?? (p.total != null ? { date: p.date, total: p.total } : undefined);
  const pt: PerfPoint = { date: p.date, strategy: Math.round(p.strategy),
    ...(p.total != null ? { total: Math.round(p.total), cash: Math.round(p.cash ?? 0), stock: Math.round(p.stock ?? 0), ...(base ? { pnl: Math.round(p.total - base.total - (f.base ? p.flow ?? 0 : 0)) } : {}) } : {}) };
  const points = [...f.points.filter((x) => x.date !== p.date), pt].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_POINTS);
  return { ...f, base, points };
}

/** 지금 계좌 손익 % (운용 금액 대비). 기준이 없으면 null */
export function accountLoss(f: PerfFile | null, total: number | undefined, budget: number): number | null {
  if (!f?.base || total == null || !(budget > 0)) return null;
  return ((f.base.total - total) / budget) * 100;
}

/**
 * 기준 다시 잡기: 입금·출금 뒤에 누름. 마지막 기록의 손익은 그대로 두고, 지금 계좌 평가액에 맞춰 기준을 옮긴다.
 * (지금 평가액 − 새 기준 = 마지막으로 기록한 손익)
 */
export function rebase(f: PerfFile, totalNow: number, date: string): PerfFile {
  const last = [...f.points].reverse().find((x) => x.pnl != null);
  return { ...f, base: { date, total: Math.round(totalNow - (last?.pnl ?? 0)) } };
}

/**
 * 손익 처음부터: 계좌 평가액을 잘못 읽은 기록이 섞였을 때. 지금 평가액을 새 기준(손익 0)으로 잡고
 * 예전 기록의 계좌 손익은 지움 (전략 계산값과 평가액 자체는 남김).
 */
export function resetBase(f: PerfFile, totalNow: number, date: string): PerfFile {
  return { ...f, base: { date, total: Math.round(totalNow) }, points: f.points.map(({ pnl: _p, ...x }) => x) };
}

export interface PerfSummary {
  days: number;
  /** 계좌 손익(원·%) / 전략 손익(원·%) / 차이(%p) */
  pnl?: number; pnlPct?: number;
  strategyPnl: number; strategyPct: number;
  gap?: number;
}
export function summarize(f: PerfFile | null): PerfSummary | null {
  const last = f?.points.at(-1);
  if (!f || !last) return null;
  const b = f.budget || 1;
  const strategyPnl = last.strategy - f.budget;
  const acct = [...f.points].reverse().find((x) => x.pnl != null);
  return { days: f.points.length, strategyPnl, strategyPct: (strategyPnl / b) * 100,
    ...(acct ? { pnl: acct.pnl!, pnlPct: (acct.pnl! / b) * 100, gap: ((acct.pnl! - (acct.strategy - f.budget)) / b) * 100 } : {}) };
}
