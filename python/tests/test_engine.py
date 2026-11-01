"""엔진 정합성 테스트: python -m pytest tests  또는  python tests/test_engine.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import pandas as pd

from kbt import CostModel, Strategy, run_backtest
from kbt.data import synthetic_ohlcv


class BuyHold(Strategy):
    name = "_bh"; rebalance = "D"
    def target_weights(self, ctx):
        return None if ctx.positions else {"A": 1.0}


class Spy(Strategy):
    """미래 데이터가 ctx 에 섞이지 않는지 확인."""
    name = "_spy"; rebalance = "D"; seen = []
    def target_weights(self, ctx):
        assert ctx.close.index[-1] == ctx.date
        self.seen.append(ctx.date)
        return {"A": 0.5}


def test_buy_hold_matches_price():
    data = synthetic_ohlcv(["A"], "2020-01-01", "2021-12-31")
    res = run_backtest(BuyHold(), data, 1e8, CostModel(0, 0, 0), verbose=False)
    df = data["A"]
    buy_px = df["Open"].iloc[1]                    # 첫날 신호 → 다음날 시가 체결
    shares = int(1e8 // buy_px)
    expect = 1e8 - shares * buy_px + shares * df["Close"].iloc[-1]
    assert abs(res.equity.iloc[-1] - expect) < 1e-3
    assert len(res.trades) == 1


def test_costs_reduce_equity():
    data = synthetic_ohlcv(["A"], "2020-01-01", "2020-12-31")
    a = run_backtest(BuyHold(), data, 1e8, CostModel(0, 0, 0), verbose=False)
    b = run_backtest(BuyHold(), data, 1e8, CostModel(0.00015, 0.001, 0.002), verbose=False)
    assert b.equity.iloc[-1] < a.equity.iloc[-1]


def test_no_lookahead_and_halt():
    data = synthetic_ohlcv(["A"], "2020-01-01", "2020-03-31")
    data["A"].loc[data["A"].index[1], "Volume"] = 0      # 둘째 날 거래정지
    res = run_backtest(Spy(), data, 1e7, verbose=False)
    first_trade = res.trades["date"].iloc[0]
    assert first_trade == data["A"].index[2]             # 정지일엔 체결 안 됨
    assert res.equity.iloc[-1] > 0


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
