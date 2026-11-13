import { rsi, sma, stdev } from "./indicators";

export type Field = "open" | "high" | "low" | "close" | "volume";

/** 날짜 x 티커 정렬된 가격 패널. 값 없음 = NaN */
export interface Panel {
  dates: string[];
  tickers: string[];
  open: Float64Array[];
  high: Float64Array[];
  low: Float64Array[];
  close: Float64Array[]; // 원본 (결측 NaN)
  closeFilled: Float64Array[]; // 직전 종가로 채움 (평가용)
  volume: Float64Array[];
  index: Map<string, number>;
  bench: Float64Array | null; // KOSPI 지수 종가 (채움)
}

/**
 * 전략에 전달되는 컨텍스트. 모든 조회는 '오늘(i)까지'로 제한되어 미래 데이터를 볼 수 없다.
 * ago=0 은 오늘, ago=1 은 전일.
 */
export class StrategyContext {
  constructor(
    private panel: Panel,
    public readonly i: number,
    public readonly positions: Readonly<Record<string, number>>,
    public readonly avgPrice: Readonly<Record<string, number>>,
    public readonly cash: number,
    public readonly equity: number,
    public readonly names: Readonly<Record<string, string>> = {},
    /** 오늘 시점의 유니버스(시점별 종목 목록을 쓸 때). 없으면 데이터에 있는 전체 종목 */
    private active?: string[],
    /** 백테스트 한 번 동안 유지되는 전략 메모 (매수 단계·최고가 등 날짜를 넘어 기억할 값) */
    public readonly state: Record<string, any> = {},
  ) {}

  /** true 로 두면 이번 신호는 리밸런싱 밴드(작은 비중 차이 무시)를 적용하지 않고 정확히 맞춤 */
  exact = false;
  /** 종목별 매매 이유를 남기면 거래 내역에 그대로 표시됨: ctx.notes[t] = "적립 매수" */
  notes: Record<string, string> = {};

  /** 오늘 날짜 YYYY-MM-DD */
  get date(): string { return this.panel.dates[this.i]; }
  /** 유니버스 티커 목록 */
  get tickers(): string[] { return this.active ?? this.panel.tickers; }
  /** 백테스트 시작 후 경과 영업일 */
  get dayIndex(): number { return this.i; }

  private col(t: string, f: Field): Float64Array | undefined {
    const k = this.panel.index.get(t);
    return k === undefined ? undefined : this.panel[f][k];
  }

  value(t: string, f: Field, ago = 0): number {
    const a = this.col(t, f);
    const j = this.i - ago;
    if (!a || ago < 0 || j < 0) return NaN;
    return a[j];
  }
  close(t: string, ago = 0) { return this.value(t, "close", ago); }
  open(t: string, ago = 0) { return this.value(t, "open", ago); }
  high(t: string, ago = 0) { return this.value(t, "high", ago); }
  low(t: string, ago = 0) { return this.value(t, "low", ago); }
  volume(t: string, ago = 0) { return this.value(t, "volume", ago); }

  /** 최근 n 일 값 배열 (오래된 것 → 오늘) */
  history(t: string, n: number, f: Field = "close"): number[] {
    const a = this.col(t, f);
    if (!a) return [];
    const s = Math.max(0, this.i - n + 1);
    return Array.from(a.subarray(s, this.i + 1));
  }

  /** n 영업일 수익률: close(skip)/close(n) - 1 */
  ret(t: string, n: number, skip = 0): number {
    return this.close(t, skip) / this.close(t, n) - 1;
  }
  sma(t: string, n: number, ago = 0): number {
    const a = this.col(t, "close");
    return a ? sma(a, this.i - ago, n) : NaN;
  }
  rsi(t: string, n = 14, ago = 0): number {
    const a = this.col(t, "close");
    return a ? rsi(a, this.i - ago, n) : NaN;
  }
  /** 일간 수익률 변동성(연율화 아님) */
  volatility(t: string, n = 20): number {
    const c = this.history(t, n + 1);
    const r = c.slice(1).map((x, k) => x / c[k] - 1);
    return r.length < 2 ? NaN : stdev(r, r.length - 1, r.length);
  }
  highest(t: string, n: number, f: Field = "high"): number { return Math.max(...this.history(t, n, f)); }
  lowest(t: string, n: number, f: Field = "low"): number { return Math.min(...this.history(t, n, f)); }
  /** 최근 n 일 평균 거래대금(원) */
  tradingValue(t: string, n = 20): number {
    const c = this.history(t, n, "close"), v = this.history(t, n, "volume");
    if (c.length < n) return NaN;
    return c.reduce((s, x, k) => s + x * v[k], 0) / n;
  }

  /** KOSPI 지수 */
  bench(ago = 0): number {
    const b = this.panel.bench;
    return b && this.i - ago >= 0 ? b[this.i - ago] : NaN;
  }
  benchSma(n: number): number {
    const b = this.panel.bench;
    return b ? sma(b, this.i, n) : NaN;
  }

  /** 현재 보유 비중 (종가 기준) */
  weight(t: string): number {
    const q = this.positions[t] ?? 0;
    if (!q || !this.equity) return 0;
    const k = this.panel.index.get(t)!;
    return (q * this.panel.closeFilled[k][this.i]) / this.equity;
  }
  /** 평단 대비 수익률 */
  pnl(t: string): number {
    const a = this.avgPrice[t];
    return a ? this.close(t) / a - 1 : NaN;
  }
  held(): string[] { return Object.keys(this.positions).filter((t) => this.positions[t] > 0); }
  name(t: string): string { return this.names[t] ?? t; }

  /** score 높은 순 상위 k 개 (NaN 제외) */
  topBy(score: (t: string) => number, k: number, filter?: (t: string) => boolean): string[] {
    return this.tickers
      .filter((t) => !filter || filter(t))
      .map((t) => [t, score(t)] as const)
      .filter(([, s]) => Number.isFinite(s))
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([t]) => t);
  }
  /** 동일비중 */
  equal(ts: string[], total = 1): Record<string, number> {
    return Object.fromEntries(ts.map((t) => [t, total / Math.max(ts.length, 1)]));
  }
}

export function buildPanel(data: Record<string, { date: string; open: number; high: number; low: number; close: number; volume: number }[]>,
                           bench?: { date: string; close: number }[] | null): Panel {
  const tickers = Object.keys(data).filter((t) => data[t].length > 0);
  const dateSet = new Set<string>();
  for (const t of tickers) for (const b of data[t]) dateSet.add(b.date);
  const dates = [...dateSet].sort();
  const di = new Map(dates.map((d, k) => [d, k]));
  const mk = () => tickers.map(() => new Float64Array(dates.length).fill(NaN));
  const p: Panel = {
    dates, tickers, open: mk(), high: mk(), low: mk(), close: mk(), closeFilled: mk(), volume: mk(),
    index: new Map(tickers.map((t, k) => [t, k])), bench: null,
  };
  tickers.forEach((t, k) => {
    for (const b of data[t]) {
      const j = di.get(b.date)!;
      p.open[k][j] = b.open; p.high[k][j] = b.high; p.low[k][j] = b.low;
      p.close[k][j] = b.close; p.volume[k][j] = b.volume;
    }
    let last = NaN;
    for (let j = 0; j < dates.length; j++) {
      if (!Number.isNaN(p.close[k][j])) last = p.close[k][j];
      p.closeFilled[k][j] = last;
    }
  });
  if (bench && bench.length) {
    const m = new Map(bench.map((b) => [b.date, b.close]));
    const arr = new Float64Array(dates.length);
    let last = NaN;
    for (let j = 0; j < dates.length; j++) {
      const v = m.get(dates[j]);
      if (v !== undefined) last = v;
      arr[j] = last;
    }
    p.bench = arr;
  }
  return p;
}
