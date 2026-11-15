/** 배당금·분배금 계산 도우미 (엔진·매수 후 보유 공통) */
import type { Dividend, DividendData, DividendPayment } from "./types";

/** 배당소득세 기본값: 한국 15.4%(소득세 14% + 지방세 1.4%), 미국 주식 현지 원천징수 15% */
export const KR_DIVIDEND_TAX = 0.154;
export const US_DIVIDEND_TAX = 0.15;

/** 숫자 하나 또는 종목별 세율 함수 */
export type DividendTax = number | ((ticker: string) => number);

/**
 * 티커별 "그 거래일 장 시작 전에 들고 있으면 받는 1주당 금액" 표 (거래일 번호 → 금액).
 * 배당락일이 휴장일이면 그다음 거래일로 옮긴다. dates 는 오름차순 거래일.
 */
export function dividendIndex(dates: string[], divs: Dividend[] | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!divs?.length || !dates.length) return m;
  let i = 0;
  for (const d of divs) {
    if (d.date < dates[0]) continue; // 데이터 시작 전 배당
    while (i < dates.length && dates[i] < d.date) i++;
    if (i >= dates.length) break;
    m.set(i, (m.get(i) ?? 0) + d.amount);
  }
  return m;
}

/** 한국 종목(첫 글자가 숫자인 6자리 코드)은 kr, 그 밖(미국 티커)은 미국 원천징수 15% */
export function dividendTaxFn(kr: number, us = US_DIVIDEND_TAX): (ticker: string) => number {
  return (t) => (/^\d[0-9A-Z]{5}$/.test(t) ? kr : us);
}

/** 엔진용: 티커별 표 + 세율 */
export function dividendBook(dates: string[], data: DividendData | null | undefined, tax: DividendTax | undefined) {
  const idx = new Map<string, Map<number, number>>();
  for (const [t, list] of Object.entries(data ?? {})) {
    const m = dividendIndex(dates, list);
    if (m.size) idx.set(t, m);
  }
  const rate = (t: string) => {
    const r = typeof tax === "function" ? tax(t) : tax ?? KR_DIVIDEND_TAX;
    return Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : KR_DIVIDEND_TAX;
  };
  /** i 번째 거래일에 qty 주를 들고 있었으면 받는 배당 (없으면 null) */
  const pay = (t: string, i: number, qty: number, date: string): DividendPayment | null => {
    const per = idx.get(t)?.get(i);
    if (!per || !(qty > 0)) return null;
    const gross = per * qty;
    const tx = gross * rate(t);
    return { date, ticker: t, qty, perShare: per, gross, tax: tx, net: gross - tx };
  };
  return { pay, has: idx.size > 0 };
}
