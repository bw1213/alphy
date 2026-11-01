"""이동평균 골든크로스 (종목별 추세추종).

매일 종가 기준 단기 MA > 장기 MA 인 종목을 보유. 동시 보유 최대 max_pos 개,
조건 충족 종목이 많으면 단기 MA 이격도가 큰 순서로 선택. 손절 -10% 기본.
"""
from kbt.strategy import Strategy


class MACross(Strategy):
    name = "ma_cross"
    params = {"short": 20, "long": 60, "max_pos": 10}
    rebalance = "W"
    universe_size = 100
    stop_loss = 0.10

    @property
    def warmup(self):
        return self.p.long + 1

    def target_weights(self, ctx):
        c = ctx.close
        s = c.iloc[-self.p.short:].mean()
        l = c.iloc[-self.p.long:].mean()
        ok = (s > l) & (c.iloc[-1] > s)
        score = (c.iloc[-1] / s - 1)[ok].dropna()
        held = [t for t in ctx.positions if ok.get(t, False)]   # 기존 보유 우선 유지
        rest = score.drop(held, errors="ignore").nlargest(max(0, self.p.max_pos - len(held))).index
        picks = list(held)[: self.p.max_pos] + list(rest)
        return {t: 1 / self.p.max_pos for t in picks}
