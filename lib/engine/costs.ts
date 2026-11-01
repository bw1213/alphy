import type { CostSettings } from "./types";

/**
 * KOSPI 매도 시 증권거래세+농특세 합계 (연도별).
 * 2026년 세법 개정으로 0.20% 환원. 바뀌면 이 표만 수정.
 */
export const KOSPI_SELL_TAX: Record<number, number> = {
  2020: 0.0025, 2021: 0.0023, 2022: 0.0023, 2023: 0.002, 2024: 0.0018, 2025: 0.0015, 2026: 0.002,
};

export const DEFAULT_COSTS: CostSettings = { commission: 0.00015, slippage: 0.001, sellTax: null };

export function sellTax(c: CostSettings, year: number): number {
  if (c.sellTax != null) return c.sellTax;
  const years = Object.keys(KOSPI_SELL_TAX).map(Number);
  const y = Math.min(Math.max(year, Math.min(...years)), Math.max(...years));
  return KOSPI_SELL_TAX[y];
}
