import { dividendIndex } from "../engine/dividends";
import type { Bar, Dividend } from "../engine/types";

/**
 * 분배금까지 반영된 수정주가(네이버 국내 ETF)를 원래 가격으로 되돌린다.
 * 수정주가는 배당락일마다 그 전 가격에 (P − D) / P 를 곱한 값이므로(P: 전날 원래 종가),
 * 뒤에서부터 배수 m 을 m + D / 전날 수정 종가 로 키우며 곱한다.
 */
export function undoDistributionAdjust(bars: Bar[], divs: Dividend[]): Bar[] {
  const ex = dividendIndex(bars.map((b) => b.date), divs);
  if (!ex.size) return bars;
  const out = new Array<Bar>(bars.length);
  let m = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    out[i] = m === 1 ? b : { ...b, open: b.open * m, high: b.high * m, low: b.low * m, close: b.close * m };
    const d = ex.get(i);
    if (d && i > 0 && bars[i - 1].close > 0) m += d / bars[i - 1].close;
  }
  return out;
}

const spread = (xs: number[]) => (xs.length < 2 ? 0 : Math.log(Math.max(...xs) / Math.min(...xs)));

/**
 * 원주가 월 종가와 비교해 시세에 분배금이 들어 있는지 판단. 비교할 달이 모자라면 null.
 * 수정주가/원주가 비율이 들쭉날쭉한데 되돌린 값으로는 거의 일정해지면 분배금 반영 시세로 본다.
 */
export function isDistributionAdjusted(bars: Bar[], undone: Bar[], rawMonthly: Record<string, number>): boolean | null {
  const lastIn = new Map<string, number>();
  bars.forEach((b, i) => lastIn.set(b.date.slice(0, 7), i));
  const a: number[] = [], u: number[] = [];
  for (const [m, i] of lastIn) {
    const raw = rawMonthly[m];
    if (!(raw > 0) || !(bars[i].close > 0)) continue;
    a.push(bars[i].close / raw);
    u.push(undone[i].close / raw);
  }
  if (a.length < 2) return null;
  const sa = spread(a);
  if (sa < 0.005) return false;
  return spread(u) < sa * 0.5;
}
