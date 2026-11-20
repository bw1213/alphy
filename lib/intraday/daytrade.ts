/** 날마다 종목을 고르는 단타 백테스트: 전 종목 일봉으로 고르고, 고른 종목·날짜의 1분봉으로 매매 */
import { sellTax as krSellTax, DEFAULT_COSTS } from "../engine/costs";
import { compareIndices, stats, type IndexBars } from "../engine/metrics";
import type { Bar } from "../engine/types";
import type { MinuteBar } from "../kis/minute";
import { normalizeDayTrade, screenDays, stockCosts, tradeDay, type DayTrade, type DayTradeSpec } from "./screen";

export interface DayTradeRequest { spec?: Partial<DayTradeSpec>; start?: string; end?: string; commission?: number; slippage?: number }

export interface Perf { totalReturn: number; cagr: number; mdd: number }

export interface DayTradeReport {
  spec: DayTradeSpec;
  from: string; to: string; days: number;
  stocks: number;
  costs: { commission: number; slippage: number };
  result: Perf & { trades: number; winRate: number; avgNet: number; activeDays: number; exits: Record<string, number> };
  halves: { from: string; to: string; totalReturn: number; trades: number; avgNet: number }[];
  monthly: { month: string; trades: number; ret: number }[];
  indices: ({ name: string } & Perf)[];
  equity: { date: string; value: number }[];
  trades: (DayTrade & { name?: string })[];
  warnings: string[];
}

export interface DayTradeDeps {
  stocks: () => { code: string; name: string }[];
  daily: (code: string, start: string) => Promise<Bar[]>;
  /** 거래일 달력 + 비교 지수 */
  calendar: (start: string, end: string) => Promise<{ dates: string[]; indices: IndexBars[] }>;
  minute: (code: string, date: string) => Promise<MinuteBar[]>;
}

const kstToday = (now: number) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
const minusDays = (d: string, n: number) => new Date(Date.parse(d) - n * 864e5).toISOString().slice(0, 10);
const kstTime = (now: number) => new Date(now + 9 * 3600_000).toISOString().slice(11, 16);

export async function runDayTrade(raw: DayTradeRequest, deps: DayTradeDeps, onProgress?: (done: number, total: number) => void, now = Date.now()): Promise<DayTradeReport> {
  const spec = normalizeDayTrade(raw.spec ?? {});
  const today = kstToday(now);
  const lastDone = kstTime(now) >= "16:40" ? today : minusDays(today, 1);
  const floor = minusDays(today, 364);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(raw.start ?? "") && raw.start! > floor ? raw.start! : floor;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(raw.end ?? "") && raw.end! < lastDone ? raw.end! : lastDone;
  const commission = Number.isFinite(Number(raw.commission)) ? Math.min(Math.max(Number(raw.commission), 0), 1) : DEFAULT_COSTS.commission * 100;
  const slippage = Number.isFinite(Number(raw.slippage)) ? Math.min(Math.max(Number(raw.slippage), 0), 1) : 0.05;
  const warnings: string[] = ["지금 상장된 종목만 대상이라, 기간 중 상장폐지된 종목은 빠져 있습니다 (결과가 실제보다 좋게 나올 수 있음)."];

  const list = deps.stocks();
  const daily = new Map<string, Bar[]>();
  const names = new Map(list.map((s) => [s.code, s.name]));
  let done = 0, failed = 0;
  const dailyStart = minusDays(from, 50);
  const queue = [...list];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try { daily.set(s.code, await deps.daily(s.code, dailyStart)); } catch { failed++; }
      onProgress?.(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (failed) warnings.push(`${failed}개 종목은 일봉을 받지 못해 뺐습니다.`);

  const cal = await deps.calendar(from, to);
  const dates = cal.dates.filter((d) => d >= from && d <= to);
  if (dates.length < 20) throw new Error("거래일이 너무 적습니다. 기간을 늘려 주세요.");
  const picks = screenDays(daily, spec, from, to);
  const pairs = [...picks.values()].flat();
  const costs = stockCosts(commission, slippage, (y) => krSellTax(DEFAULT_COSTS, y));
  const trades: DayTrade[] = [];
  let missing = 0;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    try {
      const t = tradeDay(p, await deps.minute(p.code, p.date), spec, costs, Number(p.date.slice(0, 4)));
      if (t) trades.push(t); else missing++;
    } catch { missing++; }
    onProgress?.(list.length + i + 1, list.length + pairs.length);
  }
  if (missing) warnings.push(`고른 ${pairs.length}건 중 ${missing}건은 1분봉이 없어 빼고 계산했습니다.`);

  const byDay = new Map<string, number>();
  for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + (spec.weight / 100) * t.net);
  const values: number[] = [1];
  for (const d of dates) values.push(values[values.length - 1] * (1 + (byDay.get(d) ?? 0)));
  const base = [minusDays(dates[0], 1), ...dates];
  const st = stats(base, values);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exit] = (exits[t.exit] ?? 0) + 1;
  const mid = Math.floor(dates.length / 2);
  const half = (a: number, b: number) => {
    const ts = trades.filter((t) => t.date >= dates[a] && t.date <= dates[b - 1]);
    return { from: dates[a], to: dates[b - 1], totalReturn: values[b] / values[a] - 1, trades: ts.length, avgNet: mean(ts.map((t) => t.net)) };
  };
  const months = new Map<string, { trades: number; v0: number; v1: number }>();
  dates.forEach((d, k) => {
    const m = d.slice(0, 7);
    const e = months.get(m) ?? { trades: 0, v0: values[k], v1: values[k] };
    e.v1 = values[k + 1];
    months.set(m, e);
  });
  for (const t of trades) { const e = months.get(t.date.slice(0, 7)); if (e) e.trades++; }
  const indices = cal.indices.map((ix) => {
    const c = compareIndices(base, [ix])[0];
    if (!c) return null;
    const vs = c.values.filter((v): v is number => v != null);
    const s = stats(base.slice(base.length - vs.length), vs);
    return { name: ix.name, totalReturn: s.totalReturn, cagr: s.cagr, mdd: s.mdd };
  }).filter((x): x is { name: string } & Perf => !!x);

  return {
    spec, from: dates[0], to: dates[dates.length - 1], days: dates.length, stocks: daily.size,
    costs: { commission, slippage },
    result: {
      totalReturn: st.totalReturn, cagr: st.cagr, mdd: st.mdd,
      trades: trades.length, winRate: trades.length ? trades.filter((t) => t.net > 0).length / trades.length : 0,
      avgNet: mean(trades.map((t) => t.net)), activeDays: byDay.size, exits,
    },
    halves: [half(0, mid), half(mid, dates.length)],
    monthly: [...months].map(([month, e]) => ({ month, trades: e.trades, ret: e.v1 / e.v0 - 1 })),
    indices,
    equity: dates.map((d, k) => ({ date: d, value: values[k + 1] })),
    trades: trades.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300).map((t) => ({ ...t, name: names.get(t.code) })),
    warnings,
  };
}
