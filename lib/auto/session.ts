import { isUsTicker, type Market } from "../data/market";
import { kst, type Kst } from "./time";

export type { Market };

export interface Session {
  market: Market;
  orderAt: string;
  followFrom: string;
  buyFrom: string;
  buyBy: string;
  cutoff: string;
  watchFrom: string;
  watchUntil: string;
  close: string;
}

export const US_LIMIT_BAND = 0.01;

// 미국 시각은 뉴욕 기준 (서머타임 자동)
export const US_SESSION: Session = { market: "US", orderAt: "09:32", followFrom: "09:32", buyFrom: "09:33", buyBy: "09:42", cutoff: "10:30", watchFrom: "09:35", watchUntil: "15:50", close: "16:00" };

export const krSession = (t: { morning: string; cutoff: string }): Session =>
  ({ market: "KR", orderAt: t.morning, followFrom: "09:00", buyFrom: "09:01", buyBy: "09:10", cutoff: t.cutoff, watchFrom: "09:00", watchUntil: "15:20", close: "15:30" });

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyClock(now = Date.now()): Kst {
  const p = Object.fromEntries(NY.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, dow: DOW[p.weekday] ?? 0 };
}

export const clockOf = (m: Market, now = Date.now()): Kst => (m === "US" ? nyClock(now) : kst(now));

export const planMarket = (p: { tickers: string[] }): Market => (p.tickers.length > 0 && p.tickers.every(isUsTicker) ? "US" : "KR");

export const marketOf = (ticker: string): Market => (isUsTicker(ticker) ? "US" : "KR");

export function planMarkets(p: { tickers: string[] }): Market[] {
  if (!p.tickers.length) return ["KR"];
  const has = new Set(p.tickers.map(marketOf));
  return (["KR", "US"] as Market[]).filter((m) => has.has(m));
}

export const isMixed = (p: { tickers: string[] }) => planMarkets(p).length > 1;

export const reportMarkets = (r: { market?: Market; markets?: Market[] }): Market[] => (r.markets?.length ? r.markets : [r.market ?? "KR"]);
