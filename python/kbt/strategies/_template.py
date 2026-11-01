"""새 전략 템플릿. 이 파일을 복사해 이름을 바꾸고(밑줄로 시작하지 않게) 수정하세요.

예) cp kbt/strategies/_template.py kbt/strategies/my_rule.py
    python run.py --strategy my_rule
"""
from kbt.strategy import Strategy


class MyRule(Strategy):
    name = "my_rule"                 # --strategy 이름
    params = {"lookback": 60, "top_k": 5}   # --params '{"top_k": 3}' 으로 덮어쓰기 가능
    rebalance = "M"                  # "D" / "W" / "M" / "Q" / 정수(N영업일)
    universe_size = 100              # 시총 상위 N 종목
    stop_loss = None                 # 예: 0.1
    take_profit = None               # 예: 0.3

    @property
    def warmup(self):
        return self.p.lookback + 1

    def target_weights(self, ctx):
        # ctx.close / open / high / low / volume : 날짜 x 티커 DataFrame (오늘까지)
        # ctx.positions, ctx.avg_price, ctx.cash, ctx.equity, ctx.benchmark(KOSPI)
        c = ctx.close
        ret = c.iloc[-1] / c.iloc[-self.p.lookback] - 1
        picks = ret.dropna().nlargest(self.p.top_k).index
        return {t: 1 / self.p.top_k for t in picks}
