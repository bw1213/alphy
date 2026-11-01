"""한국 주식 거래비용.

- 위탁수수료: 증권사마다 다름. 기본 0.015% (온라인 일반 수준), 매수·매도 양쪽.
- 증권거래세(+농특세), 매도 시에만. KOSPI 기준 연도별 합계 세율:
    ~2020: 0.25%, 2021~2022: 0.23%, 2023: 0.20%, 2024: 0.18%, 2025: 0.15%, 2026~: 0.20%
  (2026년 세법 개정으로 0.20% 환원. 바뀌면 KOSPI_SELL_TAX 만 고치면 됨)
- 슬리피지: 체결가 불리 가정. 기본 0.1%.
- 대주주가 아니면 상장주식 양도소득세는 없다고 가정.
"""
from dataclasses import dataclass

KOSPI_SELL_TAX = {2020: 0.0025, 2021: 0.0023, 2022: 0.0023, 2023: 0.0020,
                  2024: 0.0018, 2025: 0.0015, 2026: 0.0020}


@dataclass
class CostModel:
    commission: float = 0.00015
    slippage: float = 0.001
    sell_tax: float | None = None   # None 이면 연도별 표 사용

    def tax(self, year: int) -> float:
        if self.sell_tax is not None:
            return self.sell_tax
        if year in KOSPI_SELL_TAX:
            return KOSPI_SELL_TAX[year]
        return KOSPI_SELL_TAX[min(KOSPI_SELL_TAX)] if year < min(KOSPI_SELL_TAX) \
            else KOSPI_SELL_TAX[max(KOSPI_SELL_TAX)]

    def buy_price(self, px: float) -> float:
        return px * (1 + self.slippage)

    def sell_price(self, px: float) -> float:
        return px * (1 - self.slippage)
