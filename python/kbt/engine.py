"""일봉 포트폴리오 백테스트 엔진.

타이밍 규칙 (미래 데이터 사용 방지)
- t일 장 마감 후: 전략이 t일까지의 데이터로 목표 비중 결정, 손절/익절 조건 확인
- t+1일 시가: 매도 먼저, 그 다음 매수 (정수 주 단위)
- 거래정지(거래량 0)·가격 없음 종목은 그날 매매하지 않음
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .costs import CostModel
from .strategy import Context, Strategy


@dataclass
class BacktestResult:
    equity: pd.Series
    trades: pd.DataFrame
    positions: pd.DataFrame          # 일별 종목별 평가금액
    benchmark: pd.Series | None
    strategy: str
    initial_cash: float
    meta: dict = field(default_factory=dict)


def _rebalance_days(index: pd.DatetimeIndex, rule) -> set:
    if rule == "D":
        return set(index)
    if isinstance(rule, int):
        return set(index[::rule])
    s = pd.Series(index, index=index)
    period = {"W": "W", "M": "M", "Q": "Q"}[rule]
    # 각 기간의 마지막 영업일에 신호 → 다음 기간 첫 영업일 시가에 매매
    return set(s.groupby(index.to_period(period)).max())


def run_backtest(strategy: Strategy, data: dict[str, pd.DataFrame],
                 initial_cash: float = 10_000_000, costs: CostModel | None = None,
                 benchmark: pd.Series | None = None, verbose: bool = True) -> BacktestResult:
    costs = costs or CostModel()
    panel = {c: pd.DataFrame({t: df[c] for t, df in data.items()}).sort_index()
             for c in ("Open", "High", "Low", "Close", "Volume")}
    O, H, L, C, V = (panel[c] for c in ("Open", "High", "Low", "Close", "Volume"))
    dates = C.index
    C_ffill = C.ffill()
    bench = benchmark.reindex(dates).ffill() if benchmark is not None else None

    strategy.prepare(data)
    reb = _rebalance_days(dates, strategy.rebalance)

    cash = float(initial_cash)
    pos: dict[str, int] = {}
    avg: dict[str, float] = {}
    trades = []
    eq_hist, pos_hist = [], []
    pending: dict | None = None      # 다음날 시가에 맞출 목표 비중
    forced_exit: set = set()         # 손절/익절로 다음날 시가 매도할 종목

    for i, d in enumerate(dates):
        # ---------------- 1) 시가 체결 ----------------
        if pending is not None or forced_exit:
            o_row, v_row = O.loc[d], V.loc[d]
            tradable = lambda t: (t in o_row.index and pd.notna(o_row[t]) and o_row[t] > 0
                                  and pd.notna(v_row[t]) and v_row[t] > 0)
            mark = {t: (o_row[t] if tradable(t) else C_ffill[t].iloc[i - 1]) for t in pos}
            equity_open = cash + sum(q * mark[t] for t, q in pos.items())

            target_sh = dict(pos)
            if pending is not None:
                target_sh = {}
                for t, w in pending.items():
                    if w > 0 and tradable(t):
                        cur_w = pos.get(t, 0) * o_row[t] / equity_open
                        if t in pos and abs(cur_w - w) < strategy.rebalance_band:
                            target_sh[t] = pos[t]          # 작은 차이는 무시
                            continue
                        px = costs.buy_price(o_row[t]) * (1 + costs.commission)
                        target_sh[t] = int(equity_open * w // px)
                for t in pos:            # 거래불가 종목은 현 상태 유지
                    if not tradable(t):
                        target_sh[t] = pos[t]
            for t in forced_exit:
                if tradable(t):
                    target_sh[t] = 0

            tax = costs.tax(d.year)
            # 매도
            for t, q in list(pos.items()):
                tgt = target_sh.get(t, 0)
                if q > tgt and tradable(t):
                    n = q - tgt
                    px = costs.sell_price(o_row[t])
                    gross = n * px
                    fee = gross * costs.commission + gross * tax
                    cash += gross - fee
                    pnl = (px - avg[t]) * n - fee
                    trades.append(dict(date=d, ticker=t, side="SELL", qty=n, price=px,
                                       fee=fee, pnl=pnl, ret=px / avg[t] - 1,
                                       reason="exit" if t in forced_exit else "rebalance"))
                    pos[t] = tgt
                    if tgt == 0:
                        pos.pop(t); avg.pop(t)
            # 매수 (현금 부족 시 가능한 만큼)
            for t, tgt in target_sh.items():
                q = pos.get(t, 0)
                if tgt > q and tradable(t):
                    px = costs.buy_price(o_row[t])
                    n = min(tgt - q, int(cash // (px * (1 + costs.commission))))
                    if n <= 0:
                        continue
                    fee = n * px * costs.commission
                    cash -= n * px + fee
                    avg[t] = (avg.get(t, 0) * q + px * n) / (q + n)
                    pos[t] = q + n
                    trades.append(dict(date=d, ticker=t, side="BUY", qty=n, price=px,
                                       fee=fee, pnl=np.nan, ret=np.nan, reason="rebalance"))
            pending, forced_exit = None, set()

        # ---------------- 2) 종가 평가 ----------------
        c_row = C_ffill.iloc[i]
        values = {t: q * c_row[t] for t, q in pos.items()}
        equity = cash + sum(values.values())
        eq_hist.append(equity)
        pos_hist.append(values)

        # ---------------- 3) 장 마감 후 신호 ----------------
        if i == len(dates) - 1:
            break
        if strategy.stop_loss or strategy.take_profit:
            for t in pos:
                r = c_row[t] / avg[t] - 1
                if (strategy.stop_loss and r <= -strategy.stop_loss) or \
                   (strategy.take_profit and r >= strategy.take_profit):
                    forced_exit.add(t)
        if d in reb and i + 1 >= strategy.warmup:
            ctx = Context(date=d, open=O.iloc[: i + 1], high=H.iloc[: i + 1],
                          low=L.iloc[: i + 1], close=C.iloc[: i + 1],
                          volume=V.iloc[: i + 1], positions=dict(pos), avg_price=dict(avg),
                          cash=cash, equity=equity,
                          benchmark=bench.iloc[: i + 1] if bench is not None else None)
            w = strategy.target_weights(ctx)
            if w is not None:
                w = {t: float(x) for t, x in w.items() if x and x > 0}
                s = sum(w.values())
                if s > 1 + 1e-9:
                    w = {t: x / s for t, x in w.items()}
                pending = w
                forced_exit -= set(w)  # 새 목표에 포함되면 리밸런싱 규칙을 따름
        if verbose and i % 250 == 0:
            print(f"  {d.date()}  평가금액 {equity:,.0f}")

    equity_s = pd.Series(eq_hist, index=dates, name="equity")
    trades_df = pd.DataFrame(trades)
    pos_df = pd.DataFrame(pos_hist, index=dates).fillna(0)
    return BacktestResult(equity_s, trades_df, pos_df, bench, strategy.describe(),
                          initial_cash, meta=dict(costs=vars(costs)))
