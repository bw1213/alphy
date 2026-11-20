/**
 * 날마다 종목을 골라 하루 안에 사고파는 단타 (과매도 갭 하락 반등 등).
 * 종목 고르기는 전날까지의 일봉 + 오늘 시가(장 시작 전 예상체결가로 미리 알 수 있는 값)만 씀.
 * 매수는 시가(장 시작 동시호가), 매도는 익절 지정가 · 손절 · 종가 중 먼저 닿는 것.
 */
import type { Bar } from "../engine/types";
import type { MinuteBar } from "../kis/minute";
import { krTick, regularSession, sellFill, buyFill, toMin, type Costs } from "./engine";

export interface DayTradeSpec {
  /** 20일 평균 거래대금 하한 (억 원) */
  minValue: number;
  minPrice: number;
  /** 전날 종가가 20일 평균보다 이만큼(%) 넘게 낮을 것. 0 이면 안 봄 */
  belowMa: number;
  /** 전날도 내렸을 것 */
  prevDown: boolean;
  /** 시가가 전날 종가보다 이만큼(%) 넘게 낮게 시작할 것 */
  gap: number;
  /** 하루 최대 종목 수 (갭이 큰 순) */
  maxPicks: number;
  /** 한 종목에 넣는 자금 비율 (%) */
  weight: number;
  /** 익절 % (0 = 없음) */
  takeProfit: number;
  /** 손절 % (0 = 없음) */
  stopLoss: number;
}

export const DEFAULT_DAYTRADE: DayTradeSpec = { minValue: 30, minPrice: 1000, belowMa: 10, prevDown: true, gap: 5, maxPicks: 5, weight: 20, takeProfit: 3, stopLoss: 3 };

const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), lo), hi) : d);

export function normalizeDayTrade(x: any): DayTradeSpec {
  const d = DEFAULT_DAYTRADE;
  return {
    minValue: clamp(x?.minValue, 0, 10000, d.minValue),
    minPrice: clamp(x?.minPrice, 0, 1e7, d.minPrice),
    belowMa: clamp(x?.belowMa, 0, 90, d.belowMa),
    prevDown: typeof x?.prevDown === "boolean" ? x.prevDown : d.prevDown,
    gap: clamp(x?.gap, 0.5, 29, d.gap),
    maxPicks: Math.round(clamp(x?.maxPicks, 1, 20, d.maxPicks)),
    weight: clamp(x?.weight, 1, 100, d.weight),
    takeProfit: clamp(x?.takeProfit, 0, 29, d.takeProfit),
    stopLoss: clamp(x?.stopLoss, 0, 29, d.stopLoss),
  };
}

export interface Pick { code: string; date: string; gap: number; prevClose: number; open: number }

/** 날짜별 고른 종목 (갭이 큰 순으로 maxPicks 개까지). from 이후 날짜만 */
export function screenDays(daily: Map<string, Bar[]>, spec: DayTradeSpec, from: string, to: string): Map<string, Pick[]> {
  const byDate = new Map<string, Pick[]>();
  for (const [code, bars] of daily) {
    let sumC = 0, sumV = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i >= 21) {
        const b = bars[i], prev = bars[i - 1];
        if (b.date >= from && b.date <= to && b.open > 0 && prev.close >= spec.minPrice) {
          const ma = sumC / 20, aval = sumV / 20;
          const gap = b.open / prev.close - 1;
          const ok = aval >= spec.minValue * 1e8
            && gap <= -spec.gap / 100 && gap > -0.3
            && (!spec.belowMa || prev.close / ma - 1 <= -spec.belowMa / 100)
            && (!spec.prevDown || prev.close < bars[i - 2].close);
          if (ok) {
            const list = byDate.get(b.date) ?? [];
            list.push({ code, date: b.date, gap, prevClose: prev.close, open: b.open });
            byDate.set(b.date, list);
          }
        }
      }
      sumC += bars[i].close; sumV += bars[i].close * bars[i].volume;
      if (i >= 20) { sumC -= bars[i - 20].close; sumV -= bars[i - 20].close * bars[i - 20].volume; }
    }
  }
  for (const [d, list] of byDate) byDate.set(d, list.sort((a, b) => a.gap - b.gap).slice(0, spec.maxPicks));
  return byDate;
}

export interface DayTrade { code: string; date: string; gap: number; buy: number; sell: number; exit: "익절" | "손절" | "종가"; at: number; gross: number; net: number }

export function tradeDay(pick: Pick, raw: MinuteBar[], spec: DayTradeSpec, c: Costs, year: number): DayTrade | null {
  const bars = regularSession(raw);
  if (bars.length < 30) return null;
  const last = bars.length - 1;
  const closeAt = toMin(bars[last][0]);
  const entry = bars[0][1];
  const tp = spec.takeProfit ? entry * (1 + spec.takeProfit / 100) : null;
  const sl = spec.stopLoss ? entry * (1 - spec.stopLoss / 100) : null;
  let sell = bars[last][4], exit: DayTrade["exit"] = "종가", kind: "auction" | "stop" | "limit" = "auction", at = bars[last][0];
  for (let i = 0; i < last; i++) {
    const [t, o, h, l] = bars[i];
    if (toMin(t) >= closeAt - 10) break;
    if (sl != null && l <= sl) { sell = Math.min(sl, o); exit = "손절"; kind = "stop"; at = t; break; }
    if (tp != null && h > tp) { sell = Math.max(tp, o); exit = "익절"; kind = "limit"; at = t; break; }
  }
  const b = buyFill(entry, "auction", c) * (1 + c.commission);
  const s = sellFill(sell, kind, c) * (1 - c.commission - c.sellTax(year));
  return { code: pick.code, date: pick.date, gap: pick.gap, buy: entry, sell, exit, at, gross: sell / entry - 1, net: s / b - 1 };
}

export const stockCosts = (commissionPct: number, slippagePct: number, sellTax: (y: number) => number): Costs => ({
  commission: commissionPct / 100, slippage: slippagePct / 100, sellTax, tick: (p) => krTick(p, false),
});
