"""RSI 과매도 반등 (단기 역추세).

매일 RSI(period) < buy_below 이고 장기 상승추세(종가 > trend_ma) 종목을 매수,
RSI > sell_above 이면 매도. 익절 +15%, 손절 -7% 기본.
"""
from kbt.strategy import Strategy


def rsi(close, n):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)


class RSIReversal(Strategy):
    name = "rsi_reversal"
    params = {"period": 14, "buy_below": 30, "sell_above": 60, "trend_ma": 120, "max_pos": 10}
    rebalance = "D"
    universe_size = 100
    stop_loss = 0.07
    take_profit = 0.15

    @property
    def warmup(self):
        return self.p.trend_ma + 1

    def target_weights(self, ctx):
        p = self.p
        c = ctx.close.iloc[-(p.trend_ma + 50):]
        r = rsi(c, p.period).iloc[-1]
        trend = c.iloc[-1] > c.iloc[-p.trend_ma:].mean()
        keep = [t for t in ctx.positions if r.get(t, 0) < p.sell_above]
        cand = r[(r < p.buy_below) & trend].dropna().sort_values()
        new = [t for t in cand.index if t not in keep][: max(0, p.max_pos - len(keep))]
        if not new and len(keep) == len(ctx.positions):
            return None   # 변화 없음 → 매매 안 함 (불필요한 리밸런싱 비용 방지)
        w = 1 / p.max_pos
        return {t: (ctx.weight(t) if t in keep else w) for t in keep + new}
