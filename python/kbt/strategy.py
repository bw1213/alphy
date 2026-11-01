"""전략 플러그인 기본 클래스.

새 전략 만드는 법 (kbt/strategies/ 에 파일 하나 추가):

    from kbt.strategy import Strategy

    class MyStrategy(Strategy):
        name = "my_strategy"                 # --strategy 로 부를 이름
        params = {"lookback": 60, "top_k": 10}
        rebalance = "M"                      # "D" 매일, "W" 매주, "M" 매월, 정수 N = N영업일마다

        def target_weights(self, ctx):
            ret = ctx.close.iloc[-1] / ctx.close.iloc[-self.p.lookback] - 1
            picks = ret.dropna().nlargest(self.p.top_k).index
            return {t: 1 / len(picks) for t in picks}

target_weights 는 '오늘 장 마감 후' 호출되며, ctx 에는 오늘까지의 데이터만 들어있다
(미래 데이터 참조 불가). 반환한 비중대로 '다음 영업일 시가'에 매매된다.
반환값: {티커: 비중}. 비중 합 <= 1, 나머지는 현금. 빈 dict 는 전량 현금화.
None 을 반환하면 이번에는 매매하지 않는다(현재 포지션 유지).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace

import pandas as pd


@dataclass
class Context:
    date: pd.Timestamp
    open: pd.DataFrame      # 행=날짜, 열=티커 (오늘까지)
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    volume: pd.DataFrame
    positions: dict = field(default_factory=dict)   # {티커: 보유주수}
    avg_price: dict = field(default_factory=dict)   # {티커: 평균매입가}
    cash: float = 0.0
    equity: float = 0.0
    benchmark: pd.Series | None = None              # KOSPI 지수 (오늘까지)

    def weight(self, ticker) -> float:
        if not self.equity:
            return 0.0
        return self.positions.get(ticker, 0) * self.close[ticker].iloc[-1] / self.equity

    def current_weights(self) -> dict:
        return {t: self.weight(t) for t, q in self.positions.items() if q > 0}


class Strategy:
    name: str = "base"
    params: dict = {}
    rebalance: str | int = "M"
    universe_size: int | None = 100     # 시총 상위 N 종목 (None=전체)
    warmup: int = 0                     # 지표 계산에 필요한 최소 영업일 수
    stop_loss: float | None = None      # 예: 0.1 → 평단 대비 -10% 종가 이탈 시 다음날 시가 매도
    take_profit: float | None = None    # 예: 0.3 → +30% 도달 시 다음날 시가 매도
    rebalance_band: float = 0.02        # 보유 종목 비중 차이가 이보다 작으면 수량 조정 안 함(비용 절감)

    def __init__(self, **overrides):
        merged = {**self.params, **overrides}
        unknown = set(overrides) - set(self.params) - {"stop_loss", "take_profit",
                                                        "rebalance", "universe_size"}
        if unknown:
            raise ValueError(f"{self.name}: 알 수 없는 파라미터 {unknown}")
        for k in ("stop_loss", "take_profit", "rebalance", "universe_size"):
            if k in merged:
                setattr(self, k, merged.pop(k))
        self.p = SimpleNamespace(**merged)

    def prepare(self, data: dict[str, pd.DataFrame]) -> None:
        """(선택) 백테스트 시작 전 한 번 호출. 지표 미리 계산 등에 사용."""

    def target_weights(self, ctx: Context) -> dict | None:
        raise NotImplementedError

    def describe(self) -> str:
        return f"{self.name}({vars(self.p)})"
