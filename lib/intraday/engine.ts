/**
 * 단타(하루 안 매매) 백테스트 엔진.
 * 신호는 봉이 끝날 때 보고 다음 봉 시가에 시장가로 체결. 시장가는 1호가 불리하게 + 슬리피지,
 * 시가·종가 동시호가는 호가 차이 없이 슬리피지만, 손절은 손절가(갭이면 시가)에서 1호가 + 슬리피지.
 */
import type { MinuteBar } from "../kis/minute";
import type { MinuteDay } from "./data";

export interface Day {
  date: string;
  bars: MinuteBar[];
  /** 장중(연속 매매) 마지막 봉 위치. 그 뒤는 장 마감 동시호가 */
  lastCont: number;
  prevClose: number | null;
}

export type Fill = "auction" | "market" | "stop" | "limit";

export interface RawTrade {
  inPrice: number; inKind: Fill;
  outPrice: number; outKind: Fill;
  /** 판 날이 다음 날이면 1 (종가 매수 → 다음 날 시가 매도) */
  overnight?: boolean;
}

export interface Trade extends RawTrade { date: string; gross: number; net: number }

export interface Costs {
  /** 매수·매도 각각 수수료율 */
  commission: number;
  /** 그 해 매도 세금률 (ETF·ETN 은 0) */
  sellTax: (year: number) => number;
  /** 체결마다 추가로 불리하게 보는 비율 */
  slippage: number;
  tick: (price: number) => number;
}

/** 한국거래소 호가 단위 (2023-01 개편 기준) */
export function krTick(price: number, etf: boolean): number {
  if (etf) return price < 2000 ? 1 : 5;
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

export function buyFill(p: number, kind: Fill, c: Costs): number {
  const spread = kind === "market" ? c.tick(p) : 0;
  return (p + spread) * (1 + (kind === "limit" ? 0 : c.slippage));
}

export function sellFill(p: number, kind: Fill, c: Costs): number {
  const spread = kind === "market" || kind === "stop" ? c.tick(p) : 0;
  return (p - spread) * (1 - (kind === "limit" ? 0 : c.slippage));
}

export function settle(t: RawTrade, c: Costs, year: number): { gross: number; net: number } {
  const buy = buyFill(t.inPrice, t.inKind, c) * (1 + c.commission);
  const sell = sellFill(t.outPrice, t.outKind, c) * (1 - c.commission - c.sellTax(year));
  return { gross: t.outPrice / t.inPrice - 1, net: sell / buy - 1 };
}

export const toMin = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

/** n분봉으로 묶기 (첫 봉 시각 기준) */
export function aggregate(bars: MinuteBar[], n: number): MinuteBar[] {
  if (n <= 1 || !bars.length) return bars;
  const out: MinuteBar[] = [];
  const base = toMin(bars[0][0]);
  let cur: MinuteBar | null = null, slot = -1;
  for (const b of bars) {
    const s = Math.floor((toMin(b[0]) - base) / n);
    if (!cur || s !== slot) {
      if (cur) out.push(cur);
      cur = [b[0], b[1], b[2], b[3], b[4], b[5]];
      slot = s;
    } else {
      cur[2] = Math.max(cur[2], b[2]); cur[3] = Math.min(cur[3], b[3]); cur[4] = b[4]; cur[5] += b[5];
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 날짜별 봉 → 엔진용. 마지막 봉은 종가(장 마감 동시호가) 자리로 보고, 그 10분 전까지가 장중.
 * 수능날처럼 늦게 열고 늦게 닫는 날도 봉 시각으로 맞춰짐
 */
export function prepareDays(days: MinuteDay[], barMinutes = 1): Day[] {
  const out: Day[] = [];
  let prev: number | null = null;
  for (const d of days) {
    const raw = d.bars.filter((b) => b[4] > 0);
    if (raw.length < 30) { if (raw.length) prev = raw[raw.length - 1][4]; continue; }
    const closeAt = toMin(raw[raw.length - 1][0]);
    const cont = raw.slice(0, -1).filter((b) => toMin(b[0]) < closeAt - 10);
    const bars = [...aggregate(cont, barMinutes), raw[raw.length - 1]];
    out.push({ date: d.date, bars, lastCont: bars.length - 2, prevClose: prev });
    prev = raw[raw.length - 1][4];
  }
  return out;
}

export interface RunResult {
  trades: Trade[];
  /** 날마다 그날 끝 자산 (시작 1) */
  equity: number[];
}

export type DayRule<P> = (day: Day, p: P, next?: Day) => RawTrade[];

export function run<P>(days: Day[], rule: DayRule<P>, p: P, c: Costs): RunResult {
  const trades: Trade[] = [];
  const equity: number[] = [];
  let eq = 1;
  const pending: number[] = days.map(() => 1);
  for (let i = 0; i < days.length; i++) {
    eq *= pending[i];
    for (const t of rule(days[i], p, days[i + 1])) {
      const k = t.overnight ? i + 1 : i;
      if (k >= days.length) continue;
      const s = settle(t, c, Number(days[k].date.slice(0, 4)));
      trades.push({ ...t, date: days[k].date, ...s });
      if (k === i) eq *= 1 + s.net; else pending[k] *= 1 + s.net;
    }
    equity.push(eq);
  }
  return { trades, equity };
}
