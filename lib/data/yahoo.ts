/**
 * 야후 파이낸스 일봉 (서버 전용) — 미국 주식·ETF, S&P 500 지수, 원/달러 환율.
 * - v8 chart API. 가격은 액면분할만 반영된 값(배당은 가격에 넣지 않음 — 국내 네이버 시세와 같은 기준)
 * - 날짜는 거래소 현지 날짜 (뉴욕)
 */
import type { Bar } from "../engine/types";
import { yahooSymbol } from "./market";

const UA = { "User-Agent": "Mozilla/5.0 (alphy-backtest)" };

export interface YahooChart {
  bars: Bar[];
  /** 주당 배당금 (현지 통화), 배당락일 기준 */
  dividends: { date: string; amount: number }[];
  currency?: string;
  name?: string;
  exchange?: string;
  type?: string;
}

const dayOf = (ts: number, offset: number) => new Date((ts + offset) * 1000).toISOString().slice(0, 10);

export function parseYahooChart(j: any): YahooChart {
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description ?? "데이터 없음");
  const off = Number(r.meta?.gmtoffset) || 0;
  const ts: number[] = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const byDate = new Map<string, Bar>();
  ts.forEach((t, k) => {
    const o = q.open?.[k], h = q.high?.[k], l = q.low?.[k], c = q.close?.[k], v = q.volume?.[k];
    if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) return;
    // 소수점 4자리로 (야후는 float32 잡음이 섞여 옴)
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    byDate.set(dayOf(t, off), { date: dayOf(t, off), open: r4(o), high: r4(h), low: r4(l), close: r4(c), volume: typeof v === "number" ? v : 0 });
  });
  const dividends = Object.values(r.events?.dividends ?? {})
    .map((d: any) => ({ date: dayOf(Number(d.date), off), amount: Number(d.amount) }))
    .filter((d) => d.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    bars: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    dividends,
    currency: r.meta?.currency, name: r.meta?.shortName ?? r.meta?.longName, exchange: r.meta?.exchangeName, type: r.meta?.instrumentType,
  };
}

export async function fetchYahooChart(symbol: string, start: string, end?: string): Promise<YahooChart> {
  const p1 = Math.floor(Date.parse(start) / 1000) - 86400;
  const p2 = end ? Math.floor(Date.parse(end) / 1000) + 2 * 86400 : Math.floor(Date.now() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`;
  let res: Response | null = null;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, { headers: UA, cache: "no-store" });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // 잠깐 쉬었다가 다시
  }
  if (res!.status === 404) throw new Error(`${symbol}: 야후 파이낸스에 없는 티커입니다`);
  if (!res!.ok) throw new Error(`${symbol}: HTTP ${res!.status}`);
  const c = parseYahooChart(await res!.json());
  if (!c.bars.length) throw new Error(`${symbol}: 데이터 없음`);
  return c;
}

/** 일봉만 (cachedDaily 용) */
export const fetchYahooDaily = async (symbol: string, start: string) => (await fetchYahooChart(symbol, start)).bars;

/** 원/달러 환율 심볼, S&P 500 지수 심볼 */
export const USDKRW = "KRW=X";
export const SP500 = "^GSPC";

/**
 * fxAt: 그 날짜의 원/달러 환율. toKrw: 달러 일봉 → 원화 일봉. 그날 환율이 없으면(환율 휴일) 그 전 가장 가까운 날 환율.
 * 환율 데이터보다 앞선 날짜는 첫 환율을 씀
 */
export function fxAt(fx: { date: string; close: number }[], date: string): number {
  if (!fx.length) return NaN;
  let lo = 0, hi = fx.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fx[m].date <= date) { k = m; lo = m + 1; } else hi = m - 1; }
  return fx[k].close;
}

export function toKrw(bars: Bar[], fx: { date: string; close: number }[]): Bar[] {
  if (!fx.length) return [];
  let k = 0;
  return bars.map((b) => {
    while (k + 1 < fx.length && fx[k + 1].date <= b.date) k++;
    const r = fx[k].close;
    return { ...b, open: b.open * r, high: b.high * r, low: b.low * r, close: b.close * r };
  });
}
