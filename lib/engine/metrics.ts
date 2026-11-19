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
  /** 최장 손실 구간: 전 고점 아래에 머문 가장 긴 기간 (달력 일수, 끝까지 회복 못 했으면 마지막 날까지) */
  lossDays: number;
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
  /** 받은 배당금·분배금 (세후 합계, 세금 합계, 건수). 배당 데이터를 안 썼으면 hasDividendData = false */
  dividendsNet: number;
  dividendTax: number;
  nDividends: number;
  hasDividendData: boolean;
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
  const nan = { totalReturn: NaN, cagr: NaN, mdd: NaN, volatility: NaN, sharpe: NaN, sortino: NaN, calmar: NaN, lossDays: NaN };
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
    lossDays: longestLoss(dates, values),
  };
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/** 최장 손실 구간 (달력 일수): 고점에서 내려가 그 고점을 다시 넘기까지 가장 긴 기간. 회복 못 한 구간은 마지막 날까지 */
export function longestLoss(dates: string[], values: number[]): number {
  let peak = -Infinity, peakAt = 0, under = false, worst = 0;
  for (let k = 0; k < values.length; k++) {
    if (values[k] >= peak) {
      if (under) worst = Math.max(worst, dayDiff(dates[peakAt], dates[k]));
      peak = values[k]; peakAt = k; under = false;
    } else under = true;
  }
  if (under) worst = Math.max(worst, dayDiff(dates[peakAt], dates[values.length - 1]));
  return worst;
}

/** 비교 지수 원본 (원화 환산된 종가) */
export interface IndexBars { key: string; name: string; bars: { date: string; close: number }[] }

/** 백테스트 기간에 맞춘 지수 비교 */
export interface IndexCompare {
  key: string;
  name: string;
  /** 지수 값이 있는 첫 날 (보통 평가 시작일) */
  from: string;
  stats: Stats;
  /** 평가 날짜마다 지수 (from = 100). from 전은 null */
  values: (number | null)[];
  annual: Map<number, number>;
}

/**
 * 평가 날짜(dates)에 지수를 맞춰 성과를 계산. 그날 값이 없으면 직전 값.
 * 평가 시작보다 늦게 시작하는 지수는 시작한 날부터 계산. 겹치는 날이 2일 미만이면 뺌
 */
export function compareIndices(dates: string[], indices: IndexBars[]): IndexCompare[] {
  const out: IndexCompare[] = [];
  for (const ix of indices) {
    const bars = ix.bars.filter((b) => Number.isFinite(b.close) && b.close > 0);
    if (!bars.length || !dates.length) continue;
    let j = -1;
    const raw = dates.map((d) => {
      while (j + 1 < bars.length && bars[j + 1].date <= d) j++;
      return j >= 0 ? bars[j].close : null;
    });
    const k0 = raw.findIndex((v) => v != null);
    if (k0 < 0 || dates.length - k0 < 2) continue;
    const ds = dates.slice(k0), vs = raw.slice(k0) as number[];
    const base = vs[0];
    out.push({
      key: ix.key, name: ix.name, from: ds[0],
      stats: stats(ds, vs),
      values: raw.map((v, k) => (k < k0 || v == null ? null : (v / base) * 100)),
      annual: annual(ds, vs),
    });
  }
  return out;
}

/** 연도별 수익률 (해마다 마지막 값 기준) */
export function annual(dates: string[], values: number[]): Map<number, number> {
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
    dividendsNet: (res.dividends ?? []).reduce((a, x) => a + x.net, 0),
    dividendTax: (res.dividends ?? []).reduce((a, x) => a + x.tax, 0),
    nDividends: res.dividends?.length ?? 0,
    hasDividendData: !!res.dividends,
    exposure: res.equity.reduce((a, e) => a + (e.equity ? e.invested / e.equity : 0), 0) / res.equity.length,
    annual: annualRows,
    yearsHitTarget: annualRows.filter((r) => r.ret >= target).length,
    meetsTarget: s.cagr >= target,
    withinDrawdown: s.mdd >= -maxDrawdown,
    target, maxDrawdown,
    bench: hasBench ? stats(dates, bVals as number[]) : null,
  };
}
