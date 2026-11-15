import { isUsTicker } from "../data/market";
import type { CostSettings } from "./types";

/**
 * KOSPI 매도 시 증권거래세+농특세 합계 (연도별).
 * 2026년 세법 개정으로 0.20% 환원. 바뀌면 이 표만 수정.
 */
export const KOSPI_SELL_TAX: Record<number, number> = {
  2020: 0.0025, 2021: 0.0023, 2022: 0.0023, 2023: 0.002, 2024: 0.0018, 2025: 0.0015, 2026: 0.002,
};

/**
 * 미국 주식 기본 비용 (한국투자증권 온라인 기준).
 *  - 수수료 0.25% (이벤트로 더 낮을 수 있음)
 *  - 환전 비용 0.1%: 원화로 살 때·팔 때 각각 (환율 우대에 따라 다름)
 *  - 매도 시 미국 SEC 수수료는 0.003% 안팎이라 뺌. 양도소득세(연 250만 원 넘는 차익의 22%)는 계산하지 않음
 */
export const DEFAULT_US_COSTS = { commission: 0.0025, fx: 0.001 };

export const DEFAULT_COSTS: CostSettings = { commission: 0.00015, slippage: 0.001, sellTax: null };

export function sellTax(c: CostSettings, year: number): number {
  if (c.sellTax != null) return c.sellTax;
  const years = Object.keys(KOSPI_SELL_TAX).map(Number);
  const y = Math.min(Math.max(year, Math.min(...years)), Math.max(...years));
  return KOSPI_SELL_TAX[y];
}

/**
 * 매수 때 비용률 (체결 금액 대비). 미국 종목은 수수료 + 환전 비용.
 * c.us 가 있을 때만 미국 규칙을 쓴다 (서버가 미국 시세를 원화로 바꿔 준 경우 = DataResponse.fx 가 있을 때 화면이 넣음).
 * 없으면 모든 종목을 한국 규칙으로 (가짜 데이터의 S00000 같은 코드, 예전 호출과 호환)
 */
export function buyFeeRate(c: CostSettings, ticker: string): number {
  if (!c.us || !isUsTicker(ticker)) return c.commission;
  return c.us.commission + c.us.fx;
}

/** 매도 때 비용률. 한국은 수수료 + 거래세, 미국은 수수료 + 환전 비용 (거래세 없음) */
export function sellFeeRate(c: CostSettings, ticker: string, year: number): number {
  if (!c.us || !isUsTicker(ticker)) return c.commission + sellTax(c, year);
  return c.us.commission + c.us.fx;
}
