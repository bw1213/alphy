"""KOSPI 백테스트 실행기.

예)
  python run.py --list
  python run.py --strategy momentum --start 2015-01-01 --end 2025-12-31
  python run.py --strategy momentum --params '{"top_k": 5, "lookback": 60}'
  python run.py --strategy ma_cross --tickers 005930,000660,035420
  python run.py --strategy momentum --source synthetic      # 오프라인 코드 테스트
"""
import argparse
import warnings
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

warnings.filterwarnings("ignore", category=DeprecationWarning)
import pandas as pd

from kbt import CostModel, run_backtest
from kbt.data import get_universe, load_benchmark, load_ohlcv
from kbt.metrics import print_summary, save_report, summarize
from kbt.strategies import REGISTRY, get


def main(argv=None):
    ap = argparse.ArgumentParser(description="KOSPI 백테스트")
    ap.add_argument("--strategy", default="momentum")
    ap.add_argument("--params", default="{}", help="JSON. 전략 파라미터 덮어쓰기")
    ap.add_argument("--start", default="2015-01-01")
    ap.add_argument("--end", default=datetime.today().strftime("%Y-%m-%d"))
    ap.add_argument("--source", default="pykrx", choices=["pykrx", "fdr", "csv", "synthetic"])
    ap.add_argument("--tickers", default=None, help="콤마 구분 티커. 없으면 시총 상위 N")
    ap.add_argument("--universe-size", type=int, default=None)
    ap.add_argument("--cash", type=float, default=10_000_000)
    ap.add_argument("--commission", type=float, default=0.00015)
    ap.add_argument("--slippage", type=float, default=0.001)
    ap.add_argument("--sell-tax", type=float, default=None, help="미지정 시 연도별 법정세율")
    ap.add_argument("--out", default=None)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)

    if a.list:
        for n, cls in sorted(REGISTRY.items()):
            doc = (sys.modules[cls.__module__].__doc__ or "").strip().splitlines()
            print(f"{n:15s} {doc[0] if doc else ''}\n{'':15s} 기본 파라미터: {cls.params}")
        return

    strat = get(a.strategy)(**json.loads(a.params))
    if a.universe_size:
        strat.universe_size = a.universe_size

    if a.source == "synthetic":
        print("※ synthetic: 랜덤 가짜 데이터입니다. 코드 동작 확인용이며 수익률은 의미 없습니다.")
    if a.tickers:
        tickers = [t.strip() for t in a.tickers.split(",")]
    else:
        print(f"유니버스: {a.start} 시점 KOSPI 시총 상위 {strat.universe_size}")
        tickers = get_universe(a.start, a.source, strat.universe_size)
    # 지표 워밍업을 위해 시작일보다 1년 앞선 데이터부터 로드
    load_start = (pd.Timestamp(a.start) - pd.DateOffset(days=400)).strftime("%Y-%m-%d")
    print(f"가격 데이터 로드: {len(tickers)} 종목 ({a.source})")
    data = load_ohlcv(tickers, load_start, a.end, a.source)
    bench = load_benchmark(load_start, a.end, a.source)

    costs = CostModel(a.commission, a.slippage, a.sell_tax)
    print(f"백테스트: {strat.describe()}")
    res = run_backtest(strat, data, a.cash, costs, bench)

    # 워밍업 구간 제외하고 평가
    cut = pd.Timestamp(a.start)
    res.equity = res.equity[res.equity.index >= cut]
    res.positions = res.positions[res.positions.index >= cut]
    if res.benchmark is not None:
        res.benchmark = res.benchmark[res.benchmark.index >= cut]
    res.initial_cash = float(res.equity.iloc[0])

    s = summarize(res)
    print_summary(s, res.strategy)
    out = a.out or f"results/{a.strategy}_{datetime.now():%Y%m%d_%H%M%S}"
    path = save_report(res, s, Path(__file__).resolve().parent / out)
    print(f"결과 저장: {path}  (equity.png, trades.csv, equity.csv, summary.json)")


if __name__ == "__main__":
    main()
