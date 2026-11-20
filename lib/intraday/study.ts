/**
 * 단타 전략 찾기: 종목마다 1분봉을 받아 전략·파라미터 후보를 모두 돌리고,
 * 앞 2/3 기간(고르는 구간)에서 가장 좋은 파라미터를 뒤 1/3(확인 구간)에 그대로 적용해 봅니다.
 */
import { stats, compareIndices, type IndexBars } from "../engine/metrics";
import { sellTax as krSellTax, DEFAULT_COSTS } from "../engine/costs";
import type { MinuteBar } from "../kis/minute";
import { settled, type MinuteDay } from "./data";
import { krTick, prepareDays, run, type Costs, type Day, type Trade } from "./engine";
import { INTRADAY_STRATEGIES } from "./strategies";

export interface IntradayRequest {
  tickers: string[];
  start?: string;
  end?: string;
  barMinutes?: number;
  /** % 단위 (0.015 = 0.015%) */
  commission?: number;
  slippage?: number;
  strategies?: string[];
}

export interface Summary {
  from: string; to: string; days: number;
  totalReturn: number; cagr: number; mdd: number;
  trades: number; winRate: number;
  /** 거래 1번 평균 (비용 뺀 것 / 빼기 전) */
  avgNet: number; avgGross: number;
}

export interface Span { from: string; to: string; days: number; totalReturn: number; cagr: number; mdd: number }

export interface StrategyResult {
  id: string; name: string; desc: string; baseline: boolean;
  params: Record<string, unknown>; label: string;
  pick: Summary; check: Summary; all: Summary;
  /** 후보 파라미터 중 전체 기간 비용 뺀 수익이 플러스인 비율 */
  positive: { count: number; of: number };
}

export interface TickerResult {
  code: string; name: string; etf: boolean;
  days: number; from: string; to: string;
  costs: { commission: number; sellTax: number; slippage: number; tickPct: number };
  hold: { pick: Span; check: Span; all: Span };
  strategies: StrategyResult[];
}

export interface IntradayReport {
  barMinutes: number;
  split: { pickFrom: string; pickTo: string; checkFrom: string; checkTo: string } | null;
  tickers: TickerResult[];
  indices: { name: string; pick: Span | null; check: Span | null; all: Span | null }[];
  warnings: string[];
}

export interface StudyDeps {
  daily: (tickers: string[], start: string, end: string) => Promise<{ dates: Record<string, string[]>; names: Record<string, string>; indices: IndexBars[]; warnings: string[] }>;
  minute: (code: string, dates: string[], onDay: (done: number, total: number) => void) => Promise<MinuteDay[]>;
  info: (code: string) => { name?: string; etf: boolean };
}

const kstToday = (now = Date.now()) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
const minusDays = (d: string, n: number) => new Date(Date.parse(d) - n * 864e5).toISOString().slice(0, 10);

export function normalizeRequest(r: IntradayRequest, now = Date.now()): Required<IntradayRequest> {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(r.end ?? "") ? r.end! : kstToday(now);
  const floor = minusDays(kstToday(now), 366);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(r.start ?? "") && r.start! > floor ? r.start! : floor;
  const tickers = [...new Set((r.tickers ?? []).map((t) => String(t).trim().toUpperCase()).filter((t) => /^[0-9A-Z]{6}$/.test(t)))].slice(0, 6);
  const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), lo), hi) : d);
  const ids = INTRADAY_STRATEGIES.map((s) => s.id);
  const strategies = Array.isArray(r.strategies) && r.strategies.length ? r.strategies.filter((s) => ids.includes(s)) : ids;
  return {
    tickers, start, end,
    barMinutes: [1, 3, 5, 10].includes(Number(r.barMinutes)) ? Number(r.barMinutes) : 5,
    commission: clamp(r.commission, 0, 1, DEFAULT_COSTS.commission * 100),
    slippage: clamp(r.slippage, 0, 1, 0.02),
    strategies,
  };
}

function summarize(days: Day[], eq: number[], trades: Trade[], a: number, b: number): Summary {
  const base = a > 0 ? eq[a - 1] : 1;
  const dates = [a > 0 ? days[a - 1].date : minusDays(days[a].date, 1), ...days.slice(a, b).map((d) => d.date)];
  const st = stats(dates, [base, ...eq.slice(a, b)]);
  const from = days[a].date, to = days[b - 1].date;
  const ts = trades.filter((t) => t.date >= from && t.date <= to);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
  return {
    from, to, days: b - a,
    totalReturn: st.totalReturn, cagr: st.cagr, mdd: st.mdd,
    trades: ts.length, winRate: ts.length ? ts.filter((t) => t.net > 0).length / ts.length : 0,
    avgNet: mean(ts.map((t) => t.net)), avgGross: mean(ts.map((t) => t.gross)),
  };
}

function span(dates: string[], values: number[]): Span {
  const st = stats(dates, values);
  return { from: dates[1] ?? dates[0], to: dates[dates.length - 1], days: dates.length - 1, totalReturn: st.totalReturn, cagr: st.cagr, mdd: st.mdd };
}

const lastClose = (bars: MinuteBar[]) => bars[bars.length - 1][4];

export function studyTicker(code: string, name: string, etf: boolean, days: Day[], req: Required<IntradayRequest>, split: number): TickerResult {
  const avgPrice = days.reduce((s, d) => s + lastClose(d.bars), 0) / days.length;
  const costs: Costs = {
    commission: req.commission / 100,
    slippage: req.slippage / 100,
    sellTax: (y) => (etf ? 0 : krSellTax(DEFAULT_COSTS, y)),
    tick: (p) => krTick(p, etf),
  };
  const closes = days.map((d) => lastClose(d.bars));
  const firstOpen = days[0].bars[0][1];
  const holdSpan = (a: number, b: number) => span(
    [a > 0 ? days[a - 1].date : minusDays(days[0].date, 1), ...days.slice(a, b).map((d) => d.date)],
    [a > 0 ? closes[a - 1] : firstOpen, ...closes.slice(a, b)],
  );
  const n = days.length;
  const results: StrategyResult[] = [];
  for (const s of INTRADAY_STRATEGIES.filter((x) => req.strategies.includes(x.id))) {
    let best: { p: unknown; r: ReturnType<typeof run>; pick: Summary } | null = null;
    let positive = 0;
    for (const p of s.grid) {
      const r = run(days, s.rule, p, costs);
      if (r.equity[n - 1] > 1) positive++;
      const pick = summarize(days, r.equity, r.trades, 0, split);
      const better = !best || (pick.trades >= 5 && (best.pick.trades < 5 || pick.totalReturn > best.pick.totalReturn));
      if (better) best = { p, r, pick };
    }
    if (!best) continue;
    results.push({
      id: s.id, name: s.name, desc: s.desc, baseline: !!s.baseline,
      params: best.p as Record<string, unknown>, label: s.label(best.p),
      pick: best.pick,
      check: summarize(days, best.r.equity, best.r.trades, split, n),
      all: summarize(days, best.r.equity, best.r.trades, 0, n),
      positive: { count: positive, of: s.grid.length },
    });
  }
  return {
    code, name, etf, days: n, from: days[0].date, to: days[n - 1].date,
    costs: { commission: costs.commission, sellTax: costs.sellTax(Number(days[n - 1].date.slice(0, 4))), slippage: costs.slippage, tickPct: krTick(avgPrice, etf) / avgPrice },
    hold: { pick: holdSpan(0, split), check: holdSpan(split, n), all: holdSpan(0, n) },
    strategies: results,
  };
}

function indexSpans(indices: IndexBars[], all: string[], split: number): IntradayReport["indices"] {
  const pickDates = all.slice(0, split + 1);
  const checkDates = all.slice(split);
  const one = (ds: string[], ix: IndexBars): Span | null => {
    const c = compareIndices(ds, [ix])[0];
    if (!c) return null;
    const vs = c.values.filter((v): v is number => v != null);
    const dts = ds.slice(ds.length - vs.length);
    return dts.length > 1 ? span(dts, vs) : null;
  };
  return indices.map((ix) => ({ name: ix.name, pick: one(pickDates, ix), check: one(checkDates, ix), all: one(all, ix) }));
}

export async function runStudy(raw: IntradayRequest, deps: StudyDeps, onProgress?: (done: number, total: number) => void, now = Date.now()): Promise<IntradayReport> {
  const req = normalizeRequest(raw, now);
  if (!req.tickers.length) throw new Error("국내 종목코드(6자리)를 1~6개 넣어 주세요.");
  const daily = await deps.daily(req.tickers, req.start, req.end);
  const warnings = [...daily.warnings];
  const total = req.tickers.reduce((s, t) => s + (daily.dates[t]?.length ?? 0), 0);
  let before = 0;
  const loaded: { code: string; days: Day[] }[] = [];
  for (const code of req.tickers) {
    const dates = (daily.dates[code] ?? []).filter((d) => d >= req.start && d <= req.end && settled(d, now));
    if (!dates.length) { warnings.push(`${code}: 일봉이 없어 뺐습니다.`); continue; }
    const md = await deps.minute(code, dates, (d) => onProgress?.(before + d, total));
    before += dates.length;
    const days = prepareDays(md, req.barMinutes);
    if (days.length < 40) { warnings.push(`${code}: 분봉이 ${days.length}일치뿐이라 뺐습니다 (증권사가 최근 1년치만 보관).`); continue; }
    if (days.length < dates.length * 0.9) warnings.push(`${code}: ${dates.length}거래일 중 ${days.length}일만 분봉이 있습니다.`);
    loaded.push({ code, days });
  }
  const allDates = [...new Set(loaded.flatMap((l) => l.days.map((d) => d.date)))].sort();
  const split = Math.floor(allDates.length * 2 / 3);
  const tickers = loaded.map(({ code, days }) => {
    const i = deps.info(code);
    const cut = days.findIndex((d) => d.date >= allDates[split]);
    return studyTicker(code, daily.names[code] ?? i.name ?? code, i.etf, days, req, cut < 0 ? days.length : Math.max(cut, 1));
  });
  const base = allDates.length ? [minusDays(allDates[0], 1), ...allDates] : [];
  return {
    barMinutes: req.barMinutes,
    split: allDates.length ? { pickFrom: allDates[0], pickTo: allDates[split - 1], checkFrom: allDates[split], checkTo: allDates[allDates.length - 1] } : null,
    tickers,
    indices: allDates.length ? indexSpans(daily.indices, base, split) : [],
    warnings,
  };
}
