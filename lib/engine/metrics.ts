import type { BacktestResult, EquityPoint } from "./types";

/** 수익률·낙폭 계산에 쓰는 값: 추가 입금 효과를 뺀 nav (없으면 평가액) */
export const perf = (e: EquityPoint) => e.nav ?? e.equity;

/** 기본 목표: 연 15%, 최대 낙폭 -25% (설정 화면에서 바꿈) */
export const TARGET_CAGR = 0.15;
export const MAX_DRAWDOWN = 0.25;

export interface Stats {
  totalReturn: number;
  cagr: number;
  mdd: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  calmar: number;
}

export interface Summary extends Stats {
  start: string;
  end: string;
  initial: number;
  final: number;
  /** 평가 기간 동안 추가로 넣은 돈 합계 */
  deposits: number;
  /** 넣은 돈 합계 (평가 시작 시점 자산 + 추가 입금) */
  contributed: number;
  nTrades: number;
  nSells: number;
  winRate: number;
  avgTradeRet: number;
  totalFees: number;
  exposure: number;
  annual: { year: number; ret: number; bench: number | null }[];
  yearsHitTarget: number;
  meetsTarget: boolean;
  /** 최대 낙폭이 기준 안쪽인지 */
  withinDrawdown: boolean;
  /** 판정에 쓴 기준 (0.15 = 연 15%, 0.25 = -25%) */
  target: number;
  maxDrawdown: number;
  bench: Stats | null;
}

const years = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (365.25 * 864e5);

export function stats(dates: string[], values: number[], rf = 0.03): Stats {
  const n = values.length;
  const nan = { totalReturn: NaN, cagr: NaN, mdd: NaN, volatility: NaN, sharpe: NaN, sortino: NaN, calmar: NaN };
  if (n < 2) return nan;
  const r: number[] = [];
  for (let k = 1; k < n; k++) r.push(values[k] / values[k - 1] - 1);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  const neg = r.filter((x) => x < 0);
  const dsd = neg.length > 1 ? Math.sqrt(neg.reduce((a, b) => a + b * b, 0) / neg.length) : NaN;
  let peak = -Infinity, mdd = 0;
  for (const v of values) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const y = years(dates[0], dates[n - 1]);
  const total = values[n - 1] / values[0] - 1;
  const cagr = y > 0 ? (1 + total) ** (1 / y) - 1 : NaN;
  const vol = sd * Math.sqrt(252);
  return {
    totalReturn: total, cagr, mdd, volatility: vol,
    sharpe: vol > 0 ? (mean * 252 - rf) / vol : NaN,
    sortino: dsd > 0 ? (mean * 252 - rf) / (dsd * Math.sqrt(252)) : NaN,
    calmar: mdd < 0 ? cagr / Math.abs(mdd) : NaN,
  };
}

function annual(dates: string[], values: number[]): Map<number, number> {
  const out = new Map<number, number>();
  let prev = values[0];
  for (let k = 0; k < dates.length; k++) {
    const y = Number(dates[k].slice(0, 4));
    const last = k === dates.length - 1 || dates[k + 1].slice(0, 4) !== dates[k].slice(0, 4);
    if (last) { out.set(y, values[k] / prev - 1); prev = values[k]; }
  }
  return out;
}

export function drawdown(values: number[]): number[] {
  let peak = -Infinity;
  return values.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
}

export function summarize(res: BacktestResult, target = TARGET_CAGR, maxDrawdown = MAX_DRAWDOWN): Summary {
  const dates = res.equity.map((e) => e.date);
  const vals = res.equity.map(perf);
  const s = stats(dates, vals);
  const sells = res.trades.filter((t) => t.side === "SELL");
  const ar = annual(dates, vals);
  const bVals = res.equity.map((e) => e.benchmark);
  const hasBench = bVals.every((v) => v != null && Number.isFinite(v));
  const br = hasBench ? annual(dates, bVals as number[]) : null;
  const annualRows = [...ar.entries()].map(([year, ret]) => ({ year, ret, bench: br?.get(year) ?? null }));
  return {
    ...s,
    start: dates[0], end: dates[dates.length - 1],
    initial: res.equity[0]?.equity ?? NaN, final: res.equity.at(-1)?.equity ?? NaN,
    deposits: (res.equity.at(-1)?.contributed ?? 0) - (res.equity[0]?.contributed ?? 0),
    contributed: (res.equity[0]?.equity ?? NaN) + ((res.equity.at(-1)?.contributed ?? 0) - (res.equity[0]?.contributed ?? 0)),
    nTrades: res.trades.length, nSells: sells.length,
    winRate: sells.length ? sells.filter((t) => (t.pnl ?? 0) > 0).length / sells.length : NaN,
    avgTradeRet: sells.length ? sells.reduce((a, t) => a + (t.ret ?? 0), 0) / sells.length : NaN,
    totalFees: res.trades.reduce((a, t) => a + t.fee, 0),
    exposure: res.equity.reduce((a, e) => a + (e.equity ? e.invested / e.equity : 0), 0) / res.equity.length,
    annual: annualRows,
    yearsHitTarget: annualRows.filter((r) => r.ret >= target).length,
    meetsTarget: s.cagr >= target,
    withinDrawdown: s.mdd >= -maxDrawdown,
    target, maxDrawdown,
    bench: hasBench ? stats(dates, bVals as number[]) : null,
  };
}
