"""모멘텀 + 시장 필터 (상대·절대 모멘텀).

매월 말, 최근 lookback 일 수익률 상위 top_k 종목을 동일비중 매수.
단, 최근 skip 일은 제외(단기 반전 효과 회피).
KOSPI 지수가 market_ma 일 이동평균 아래면 전량 현금 (하락장 회피).
"""
from kbt.strategy import Strategy


class Momentum(Strategy):
    name = "momentum"
    params = {"lookback": 120, "skip": 20, "top_k": 10, "market_ma": 200, "min_value": 5e8}
    rebalance = "M"
    universe_size = 100

    @property
    def warmup(self):
        return max(self.p.lookback, self.p.market_ma) + 1

    def target_weights(self, ctx):
        p = self.p
        if ctx.benchmark is not None and p.market_ma:
            b = ctx.benchmark.dropna()
            if len(b) >= p.market_ma and b.iloc[-1] < b.iloc[-p.market_ma:].mean():
                return {}
        c = ctx.close
        if len(c) <= p.lookback:
            return None
        mom = c.iloc[-1 - p.skip] / c.iloc[-1 - p.lookback] - 1
        # 유동성 필터: 최근 20일 평균 거래대금
        value = (c.iloc[-20:] * ctx.volume.iloc[-20:]).mean()
        mom = mom[(value >= p.min_value) & (mom > 0)].dropna()
        picks = mom.nlargest(p.top_k).index
        return {t: 1 / p.top_k for t in picks}
