/**
 * 시장별 시계와 하루 일정.
 *
 * 한국: 한국 시간. 아침 주문 시각·마감 시각은 관리자가 화면에서 정함.
 * 미국: 뉴욕 시간(서머타임 자동). 날짜·요일·시각을 모두 뉴욕 기준으로 보므로 한국 자정을 넘어가도 하루로 다룬다.
 *       장 시작(09:30) 2분 뒤 현재가 ±1% 지정가로 주문, 10:30 에 미체결 취소, 15:50 까지 장중 매도 감시.
 */
import { isUsTicker, type Market } from "../data/market";
import { kst, type Kst } from "./time";

export type { Market };

export interface Session {
  market: Market;
  /** 그날 주문을 내는 시각 */
  orderAt: string;
  /** 이 시각부터 체결 확인 */
  followFrom: string;
  /** 현금이 모자라 미룬 매수: 이 시각부터 매도가 끝났으면, buyBy 가 지나면 그냥 */
  buyFrom: string;
  buyBy: string;
  /** 미체결 취소 */
  cutoff: string;
  /** 장중 매도 감시 구간 */
  watchFrom: string;
  watchUntil: string;
  /** 장 마감 */
  close: string;
}

/** 미국 주문 지정가: 현재가에서 이만큼 불리하게 (바로 체결되도록) */
export const US_LIMIT_BAND = 0.01;

export const US_SESSION: Session = { market: "US", orderAt: "09:32", followFrom: "09:32", buyFrom: "09:33", buyBy: "09:42", cutoff: "10:30", watchFrom: "09:35", watchUntil: "15:50", close: "16:00" };

export const krSession = (t: { morning: string; cutoff: string }): Session =>
  ({ market: "KR", orderAt: t.morning, followFrom: "09:00", buyFrom: "09:01", buyBy: "09:10", cutoff: t.cutoff, watchFrom: "09:00", watchUntil: "15:20", close: "15:30" });

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 뉴욕 시간 */
export function nyClock(now = Date.now()): Kst {
  const p = Object.fromEntries(NY.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, dow: DOW[p.weekday] ?? 0 };
}

export const clockOf = (m: Market, now = Date.now()): Kst => (m === "US" ? nyClock(now) : kst(now));

/** 운용 전략의 시장: 대상 종목이 모두 미국이면 미국, 아니면 한국 (종목을 비운 기본 전략은 한국 시총 상위) */
export const planMarket = (p: { tickers: string[] }): Market => (p.tickers.length > 0 && p.tickers.every(isUsTicker) ? "US" : "KR");

export interface Mk { s: Session; clock: (now: number) => Kst }
export const mkFor = (s: Session): Mk => ({ s, clock: (now) => clockOf(s.market, now) });
