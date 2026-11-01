"""성과 지표와 리포트."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .engine import BacktestResult

TARGET_CAGR = 0.30   # 프로젝트 목표: 연 30%


def _stats(eq: pd.Series, rf: float = 0.03) -> dict:
    eq = eq.dropna()
    if len(eq) < 2:
        return {}
    r = eq.pct_change().dropna()
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1 if years > 0 else np.nan
    dd = eq / eq.cummax() - 1
    vol = r.std() * np.sqrt(252)
    sharpe = (r.mean() * 252 - rf) / vol if vol > 0 else np.nan
    downside = r[r < 0].std() * np.sqrt(252)
    sortino = (r.mean() * 252 - rf) / downside if downside > 0 else np.nan
    return dict(total_return=eq.iloc[-1] / eq.iloc[0] - 1, cagr=cagr, mdd=dd.min(),
                volatility=vol, sharpe=sharpe, sortino=sortino,
                calmar=cagr / abs(dd.min()) if dd.min() < 0 else np.nan)


def annual_returns(eq: pd.Series) -> pd.Series:
    y = eq.groupby(eq.index.year).last()
    first = eq.iloc[0]
    return y / y.shift(1).fillna(first) - 1


def summarize(res: BacktestResult) -> dict:
    s = _stats(res.equity)
    t = res.trades
    sells = t[t["side"] == "SELL"] if len(t) else t
    s.update(
        start=str(res.equity.index[0].date()), end=str(res.equity.index[-1].date()),
        initial=res.initial_cash, final=float(res.equity.iloc[-1]),
        n_trades=int(len(t)), n_round_trips=int(len(sells)),
        win_rate=float((sells["pnl"] > 0).mean()) if len(sells) else np.nan,
        avg_trade_ret=float(sells["ret"].mean()) if len(sells) else np.nan,
        total_fees=float(t["fee"].sum()) if len(t) else 0.0,
        exposure=float((res.positions.sum(axis=1) / res.equity).mean()),
    )
    ar = annual_returns(res.equity)
    s["annual_returns"] = {int(k): float(v) for k, v in ar.items()}
    s["years_hit_30pct"] = f"{int((ar >= TARGET_CAGR).sum())}/{len(ar)}"
    s["meets_target_cagr"] = bool(s["cagr"] >= TARGET_CAGR)
    if res.benchmark is not None:
        b = _stats(res.benchmark)
        s["benchmark"] = {k: b[k] for k in ("total_return", "cagr", "mdd", "sharpe")}
        s["benchmark_annual"] = {int(k): float(v) for k, v in annual_returns(res.benchmark.dropna()).items()}
    return s


def print_summary(s: dict, name: str) -> None:
    pct = lambda x: f"{x * 100:,.2f}%" if x is not None and not pd.isna(x) else "-"
    print("\n" + "=" * 60)
    print(f" 전략: {name}")
    print(f" 기간: {s['start']} ~ {s['end']}")
    print("=" * 60)
    print(f" 최종자산      {s['final']:>16,.0f} 원 (초기 {s['initial']:,.0f})")
    print(f" 누적수익률    {pct(s['total_return']):>16}")
    print(f" 연평균(CAGR)  {pct(s['cagr']):>16}   목표 30% {'달성' if s['meets_target_cagr'] else '미달'}")
    print(f" 최대낙폭(MDD) {pct(s['mdd']):>16}")
    print(f" 샤프 / 소르티노  {s['sharpe']:.2f} / {s['sortino']:.2f}")
    print(f" 매매횟수      {s['n_trades']:>16}   승률 {pct(s['win_rate'])}  평균 {pct(s['avg_trade_ret'])}")
    print(f" 총 비용(수수료+세금) {s['total_fees']:,.0f} 원   평균 투자비중 {pct(s['exposure'])}")
    if "benchmark" in s:
        b = s["benchmark"]
        print(f" KOSPI 지수    CAGR {pct(b['cagr'])}  MDD {pct(b['mdd'])}")
    print(" 연도별 수익률:")
    bench = s.get("benchmark_annual", {})
    for y, r in s["annual_returns"].items():
        mark = "★" if r >= TARGET_CAGR else " "
        bm = f"  (KOSPI {pct(bench[y])})" if y in bench else ""
        print(f"   {y}: {pct(r):>9} {mark}{bm}")
    print(f" 연 30% 이상 달성 연도: {s['years_hit_30pct']}")
    print("=" * 60)


def save_report(res: BacktestResult, s: dict, out_dir: str | Path) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    res.equity.to_csv(out / "equity.csv")
    res.trades.to_csv(out / "trades.csv", index=False)
    (out / "summary.json").write_text(json.dumps({"strategy": res.strategy, **s}, indent=2,
                                                  ensure_ascii=False, default=str))
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, (a1, a2) = plt.subplots(2, 1, figsize=(11, 7), sharex=True,
                                     gridspec_kw={"height_ratios": [3, 1]})
        eq = res.equity / res.equity.iloc[0]
        a1.plot(eq.index, eq, label="Strategy", lw=1.6)
        if res.benchmark is not None:
            b = res.benchmark.dropna()
            a1.plot(b.index, b / b.iloc[0], label="KOSPI", lw=1.2, alpha=0.7)
        target = (1 + TARGET_CAGR) ** ((eq.index - eq.index[0]).days / 365.25)
        a1.plot(eq.index, target, "--", lw=1, color="gray", label="30%/yr target")
        a1.set_yscale("log"); a1.legend(); a1.grid(alpha=0.3)
        a1.set_title(f"{res.strategy}  CAGR {s['cagr']*100:.1f}%  MDD {s['mdd']*100:.1f}%")
        dd = res.equity / res.equity.cummax() - 1
        a2.fill_between(dd.index, dd * 100, 0, color="tab:red", alpha=0.4)
        a2.set_ylabel("Drawdown %"); a2.grid(alpha=0.3)
        fig.tight_layout(); fig.savefig(out / "equity.png", dpi=110); plt.close(fig)
    except Exception as e:
        print(f"  [chart skip] {e}")
    return out
