"""KOSPI 데이터 로더.

지원 소스
- "pykrx"     : KRX 공식 데이터 (과거 시점별 상장 종목 조회 가능 → 생존편향 감소). 기본값.
- "fdr"       : FinanceDataReader (네이버/KRX 등)
- "csv"       : data/csv/{티커}.csv  (컬럼: Date,Open,High,Low,Close,Volume)
- "synthetic" : 오프라인 코드 테스트용 가짜 데이터. 실제 수익률 판단에 쓰면 안 됨.

내려받은 데이터는 data/cache/ 에 CSV로 저장해 두고 재사용한다.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "cache"
CSV_DIR = ROOT / "data" / "csv"
COLS = ["Open", "High", "Low", "Close", "Volume"]


def _ymd(d) -> str:
    return pd.Timestamp(d).strftime("%Y%m%d")


# --------------------------------------------------------------------------- #
# 유니버스 (종목 목록)
# --------------------------------------------------------------------------- #
def get_universe(date, source: str = "pykrx", top_n: int | None = 100,
                 market: str = "KOSPI") -> list[str]:
    """date 시점 KOSPI 종목 중 시가총액 상위 top_n 개 티커.

    pykrx 는 '그 시점'의 상장 종목·시총을 주므로 생존편향이 줄어든다.
    fdr 은 '현재' 상장 목록만 주므로 과거 백테스트 시 생존편향이 생긴다.
    """
    if source == "synthetic":
        return [f"S{i:05d}" for i in range(top_n or 50)]
    if source == "csv":
        ticks = sorted(p.stem for p in CSV_DIR.glob("*.csv"))
        return ticks[:top_n] if top_n else ticks

    if source == "pykrx":
        from pykrx import stock
        d = stock.get_nearest_business_day_in_a_week(_ymd(date))
        cap = stock.get_market_cap(d, market=market)
        cap = cap[cap["시가총액"] > 0].sort_values("시가총액", ascending=False)
        ticks = cap.index.tolist()
    elif source == "fdr":
        import FinanceDataReader as fdr
        lst = fdr.StockListing(market)
        code_col = "Code" if "Code" in lst.columns else "Symbol"
        cap_col = next((c for c in ("Marcap", "MarketCap") if c in lst.columns), None)
        if cap_col:
            lst = lst.sort_values(cap_col, ascending=False)
        ticks = lst[code_col].astype(str).tolist()
    else:
        raise ValueError(f"unknown source: {source}")

    # 우선주(티커 끝자리 0 아님)·스팩 등 제외: 보통주만
    ticks = [t for t in ticks if t.endswith("0")]
    return ticks[:top_n] if top_n else ticks


# --------------------------------------------------------------------------- #
# 가격 데이터
# --------------------------------------------------------------------------- #
def _fetch_one(ticker: str, start, end, source: str) -> pd.DataFrame:
    if source == "pykrx":
        from pykrx import stock
        df = stock.get_market_ohlcv(_ymd(start), _ymd(end), ticker, adjusted=True)
        df = df.rename(columns={"시가": "Open", "고가": "High", "저가": "Low",
                                "종가": "Close", "거래량": "Volume"})
    elif source == "fdr":
        import FinanceDataReader as fdr
        df = fdr.DataReader(ticker, pd.Timestamp(start), pd.Timestamp(end))
    elif source == "csv":
        df = pd.read_csv(CSV_DIR / f"{ticker}.csv", parse_dates=["Date"], index_col="Date")
    else:
        raise ValueError(source)
    df.index = pd.to_datetime(df.index)
    df.index.name = "Date"
    return df[COLS].astype(float)


def load_ohlcv(tickers, start, end, source: str = "pykrx",
               use_cache: bool = True, verbose: bool = True) -> dict[str, pd.DataFrame]:
    """여러 종목의 일봉을 {ticker: DataFrame} 로 반환."""
    if source == "synthetic":
        return synthetic_ohlcv(tickers, start, end)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out: dict[str, pd.DataFrame] = {}
    for i, t in enumerate(tickers, 1):
        path = CACHE_DIR / f"{source}_{t}.csv"
        df = None
        if use_cache and path.exists():
            df = pd.read_csv(path, parse_dates=["Date"], index_col="Date")
            if df.index.min() > pd.Timestamp(start) + pd.Timedelta(days=10) or \
               df.index.max() < pd.Timestamp(end) - pd.Timedelta(days=10):
                df = None  # 캐시 기간이 모자라면 새로 받음
        if df is None:
            try:
                df = _fetch_one(t, start, end, source)
                if use_cache and source != "csv":
                    df.to_csv(path)
            except Exception as e:  # 상장폐지 등
                if verbose:
                    print(f"  [skip] {t}: {e}")
                continue
        df = df.loc[pd.Timestamp(start):pd.Timestamp(end)]
        if len(df):
            out[t] = df
        if verbose and i % 20 == 0:
            print(f"  데이터 로드 {i}/{len(tickers)}")
    return out


def load_benchmark(start, end, source: str = "pykrx") -> pd.Series | None:
    """KOSPI 지수 종가."""
    try:
        if source == "pykrx":
            from pykrx import stock
            s = stock.get_index_ohlcv(_ymd(start), _ymd(end), "1001")["종가"]
        elif source == "fdr":
            import FinanceDataReader as fdr
            s = fdr.DataReader("KS11", pd.Timestamp(start), pd.Timestamp(end))["Close"]
        elif source == "synthetic":
            return synthetic_ohlcv(["KOSPI"], start, end, seed=7)["KOSPI"]["Close"]
        else:
            return None
        s.index = pd.to_datetime(s.index)
        return s.astype(float)
    except Exception as e:
        print(f"  [benchmark skip] {e}")
        return None


def synthetic_ohlcv(tickers, start, end, seed: int = 42) -> dict[str, pd.DataFrame]:
    """오프라인 테스트용 랜덤워크 데이터 (실제 시장과 무관)."""
    idx = pd.bdate_range(start, end)
    out = {}
    for k, t in enumerate(tickers):
        r = np.random.default_rng(seed + k)
        drift = r.normal(0.0003, 0.0004)
        vol = r.uniform(0.012, 0.03)
        ret = r.normal(drift, vol, len(idx))
        close = 10000 * np.exp(np.cumsum(ret))
        open_ = close * np.exp(r.normal(0, vol / 3, len(idx)))
        high = np.maximum(open_, close) * (1 + np.abs(r.normal(0, vol / 2, len(idx))))
        low = np.minimum(open_, close) * (1 - np.abs(r.normal(0, vol / 2, len(idx))))
        volu = r.integers(50_000, 2_000_000, len(idx)).astype(float)
        out[t] = pd.DataFrame({"Open": open_, "High": high, "Low": low,
                               "Close": close, "Volume": volu}, index=idx).rename_axis("Date")
    return out
