/**
 * 백테스트 전략 비교 (화면·서버 공용, 순수 계산).
 * 여러 전략을 같은 기간·자금·비용으로 돌린 결과를 "모두 값이 있는 같은 기간"으로 맞춰 수익 곡선·지표·연도별 수익률을 나란히 놓음.
 */
import { annual, compareIndices, drawdown, perf, stats, type IndexBars, type Stats } from "../engine/metrics";
import type { BacktestResult, Rebalance } from "../engine/types";
import { generate, normalizeSpec } from "../strategies/builder";
import { CYCLE_CODE, cycleParams, cycleWarmup, normalizeCycleSpec } from "../strategies/cycle";
import { compileStrategy, STRATEGIES, type Params } from "../strategies";
import type { SavedStrategy } from "../strategies/library";
import type { SavedUniverse } from "../strategies/universe";

/** 비교에 한 번에 넣을 수 있는 전략 수 (선이 너무 많으면 읽기 어려움) */
export const MAX_COMPARE = 6;

/** 비교 목록에서 쓰는 id: 기본 전략은 id, 내 전략은 "saved:이름" */
export const savedId = (name: string) => `saved:${name}`;

export interface CompareStrategy {
  id: string;
  name: string;
  fn: (ctx: any, p: Params) => any;
  p: Params;
  warmup: number;
  rebalance: Rebalance;
  stopLoss: number | null;
  takeProfit: number | null;
  intraday: boolean;
  /** 저장된 종목 (없으면 화면에 지금 넣은 종목) */
  universe?: SavedUniverse;
  /** 적립·분할 매도처럼 종목을 직접 정해야 하는 전략 */
  needsList: boolean;
}

const pctFrac = (t: string | undefined) => (!t || t.trim() === "" ? null : Number(t) / 100);

/**
 * 비교할 전략 하나를 실행할 수 있게 준비. 기본 전략은 화면의 지금 파라미터(params)를 씀.
 * 저장된 전략 코드는 이 함수를 부른 곳(브라우저)에서 실행됨.
 */
export function prepareCompare(id: string, saved: SavedStrategy[], params: Record<string, Params> = {}): CompareStrategy {
  const b = STRATEGIES.find((x) => x.id === id);
  if (b) {
    const p = { ...Object.fromEntries(b.params.map((x) => [x.key, x.default])), ...(params[b.id] ?? {}) };
    return { id, name: b.name, fn: b.targetWeights, p, warmup: b.warmup(p), rebalance: b.rebalance, stopLoss: b.stopLoss, takeProfit: b.takeProfit, intraday: false, needsList: false };
  }
  const s = saved.find((x) => savedId(x.name) === id);
  if (!s) throw new Error(`'${id.replace(/^saved:/, "")}' 전략을 찾지 못했습니다 (지워졌을 수 있어요).`);
  const common = { id, name: s.name, stopLoss: pctFrac(s.stopLoss), takeProfit: pctFrac(s.takeProfit), intraday: s.intraday === true, universe: s.universe };
  if (s.cycle) {
    const spec = normalizeCycleSpec(s.cycle);
    return { ...common, fn: compileStrategy(CYCLE_CODE), p: cycleParams(spec), warmup: cycleWarmup(spec), rebalance: "D", needsList: true };
  }
  if (s.builder) {
    const g = generate(normalizeSpec(s.builder));
    return { ...common, fn: compileStrategy(g.code), p: g.params, warmup: g.warmup, rebalance: s.rebalance, needsList: false };
  }
  let p: Params;
  try { p = JSON.parse(s.params || "{}"); } catch { throw new Error(`'${s.name}': 파라미터(JSON) 형식이 올바르지 않습니다.`); }
  let fn;
  try { fn = compileStrategy(s.code); } catch (e) { throw new Error(`'${s.name}': 전략 코드 문법 오류: ${(e as Error).message}`); }
  return { ...common, fn, p, warmup: s.warmup, rebalance: s.rebalance, needsList: false };
}

export interface CompareRun {
  id: string;
  name: string;
  /** 실행에 쓴 종목 설명 */
  universe: string;
  res?: BacktestResult;
  error?: string;
}

export interface CompareRow {
  id: string;
  name: string;
  universe: string;
  /** 지수면 sp500·kospi */
  index?: string;
  /** 자기 결과가 시작한 날 (같은 기간 맞추기 전) */
  ownStart?: string;
  stats: Stats;
  annual: Map<number, number>;
  /** 날짜(dates)마다 값, 시작 = 100. 값 없는 날은 null */
  values: (number | null)[];
  dd: (number | null)[];
}

export interface CompareReport {
  start: string;
  end: string;
  /** 같은 기간으로 맞추느라 시작이 늦어졌으면 그 원인이 된 전략 이름 */
  lateBy: string | null;
  dates: string[];
  rows: CompareRow[];
  indices: CompareRow[];
  errors: { name: string; error: string }[];
  years: number[];
}

/**
 * 결과들을 모두 값이 있는 같은 기간으로 맞춰 비교. 시작 = 모든 결과의 첫 날 중 가장 늦은 날, 끝 = 마지막 날 중 가장 이른 날.
 * 지수(S&P 500·KOSPI)도 같은 날짜로.
 */
export function buildCompare(runs: CompareRun[], indices: IndexBars[]): CompareReport | null {
  const ok = runs.filter((r) => r.res && r.res.equity.length >= 2);
  const errors = runs.filter((r) => !ok.includes(r)).map((r) => ({ name: r.name, error: r.error ?? "평가 구간 데이터가 부족합니다." }));
  if (!ok.length) return null;
  let start = "", end = "9999";
  for (const r of ok) {
    const f = r.res!.equity[0].date, l = r.res!.equity.at(-1)!.date;
    if (f > start) start = f;
    if (l < end) end = l;
  }
  // 시작이 다른 것보다 열흘 넘게 늦은 전략이 있으면 알려 줌 (한국·미국 첫 거래일 차이 정도는 무시)
  const first = ok.reduce((m, r) => (r.res!.equity[0].date < m ? r.res!.equity[0].date : m), start);
  const lateBy = Date.parse(start) - Date.parse(first) > 10 * 864e5 ? ok.find((r) => r.res!.equity[0].date === start)!.name : null;
  const dateSet = new Set<string>();
  for (const r of ok) for (const e of r.res!.equity) if (e.date >= start && e.date <= end) dateSet.add(e.date);
  const dates = [...dateSet].sort();
  if (dates.length < 2) return { start, end, lateBy, dates, rows: [], indices: [], errors: [...errors, ...ok.map((r) => ({ name: r.name, error: "다른 전략과 겹치는 기간이 없습니다." }))], years: [] };

  const rows: CompareRow[] = ok.map((r) => {
    const eq = r.res!.equity;
    // 그날 값이 없으면 직전 값 (시장 휴일이 다른 한국·미국 전략을 섞을 때)
    let j = -1;
    const raw = dates.map((d) => {
      while (j + 1 < eq.length && eq[j + 1].date <= d) j++;
      return j >= 0 ? perf(eq[j]) : null;
    });
    const base = raw[0] ?? raw.find((v) => v != null)!;
    const vs = raw.map((v) => (v == null ? base : v));
    const dd = drawdown(vs);
    return {
      id: r.id, name: r.name, universe: r.universe, ownStart: eq[0].date,
      stats: stats(dates, vs), annual: annual(dates, vs),
      values: vs.map((v) => (v / base) * 100), dd: dd.map((x) => x * 100),
    };
  });
  const ix: CompareRow[] = compareIndices(dates, indices).map((x) => {
    const filled = x.values.map((v) => v ?? NaN);
    const k0 = filled.findIndex((v) => Number.isFinite(v));
    const dd = drawdown(filled.slice(k0));
    return {
      id: `ix_${x.key}`, name: x.name, universe: "가격 지수", index: x.key, ownStart: x.from,
      stats: x.stats, annual: x.annual, values: x.values,
      dd: [...Array(k0).fill(null), ...dd.map((v) => v * 100)],
    };
  });
  const years = [...new Set(dates.map((d) => Number(d.slice(0, 4))))];
  return { start: dates[0], end: dates.at(-1)!, lateBy, dates, rows, indices: ix, errors, years };
}

/** 각 지표에서 가장 좋은 전략 id (지수 제외). 값이 클수록 좋은 것: 연평균·누적·샤프·MDD(0에 가까울수록), 작을수록 좋은 것: 최장 손실 */
export function bestOf(rows: CompareRow[]): Record<"cagr" | "mdd" | "lossDays" | "totalReturn" | "sharpe", string | null> {
  const pick = (f: (s: Stats) => number, lower = false) => {
    let best: CompareRow | null = null;
    for (const r of rows) {
      const v = f(r.stats);
      if (!Number.isFinite(v)) continue;
      if (!best || (lower ? v < f(best.stats) : v > f(best.stats))) best = r;
    }
    return rows.length > 1 && best ? best.id : null;
  };
  return {
    cagr: pick((s) => s.cagr), mdd: pick((s) => s.mdd), lossDays: pick((s) => s.lossDays, true),
    totalReturn: pick((s) => s.totalReturn), sharpe: pick((s) => s.sharpe),
  };
}

/** 여러 응답에 들어 있는 비교 지수를 하나로 (같은 key 면 더 앞선 날부터 있는 것) */
export function mergeIndices(lists: (IndexBars[] | undefined)[]): IndexBars[] {
  const m = new Map<string, IndexBars>();
  for (const l of lists) for (const x of l ?? []) {
    const cur = m.get(x.key);
    if (!cur || (x.bars[0]?.date ?? "9999") < (cur.bars[0]?.date ?? "9999") || (x.bars[0]?.date === cur.bars[0]?.date && x.bars.length > cur.bars.length)) m.set(x.key, x);
  }
  // S&P 500 먼저, 그다음 KOSPI
  return [...m.values()].sort((a, b) => (a.key === "sp500" ? -1 : b.key === "sp500" ? 1 : 0));
}
