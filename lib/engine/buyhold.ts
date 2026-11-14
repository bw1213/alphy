/**
 * 비교용 "매수 후 보유": 전략과 같은 기간·같은 자금(시작 자금 + 매달 추가 입금)·같은 비용으로,
 * 정한 종목을 같은 비율(똑같이 나눠서)로 사기만 하고 팔지 않았을 때의 결과.
 *
 *  - 평가 시작일 시가에 시작 자금을 종목 수로 똑같이 나눠 산다 (전략의 첫 체결과 같은 날).
 *  - 매달 추가 입금도 그날 시가에 같은 비율로 나눠 산다.
 *  - 정수 주만 살 수 있어서 남는 돈은 종목별로 모아 두었다가 1주 이상 되면 산다.
 *    그날 거래가 안 되는 종목(거래정지, 아직 상장 전)도 그 몫을 모아 두었다가 거래되는 날 산다.
 *  - 팔지 않는다. 단, 시세가 끊긴 종목(상장폐지)은 엔진과 같은 규칙으로 마지막 종가에 정리하고
 *    그 돈은 남은 종목에 똑같이 나눠 다시 산다.
 *  - 수익률은 엔진과 같이 추가 입금 효과를 뺀 시간가중(nav) 기준.
 */
import { buildPanel } from "./context";
import { DEFAULT_COSTS, sellTax } from "./costs";
import { DELIST_AFTER_DAYS, type RunOptions } from "./engine";
import type { BacktestResult, EquityPoint, Trade } from "./types";

export type HoldOptions = Omit<RunOptions, "strategy" | "settings" | "universe"> & {
  /** 살 종목. 데이터에 없는 종목은 빠진다 */
  tickers: string[];
};

export function runBuyAndHold(opt: HoldOptions): BacktestResult | null {
  const costs = opt.costs ?? DEFAULT_COSTS;
  const P = buildPanel(opt.data, opt.benchmark);
  const { dates } = P;
  const N = dates.length;
  const tickers = [...new Set(opt.tickers)].filter((t) => P.index.has(t));
  if (!tickers.length || !N) return null;
  const startIdx = opt.startDate ? dates.findIndex((d) => d >= opt.startDate!) : 0;
  if (startIdx < 0) return null;
  const col = (t: string) => P.index.get(t)!;

  const lastIdx = new Map<string, number>();
  for (const t of tickers) {
    let j = N - 1;
    while (j >= 0 && Number.isNaN(P.close[col(t)][j])) j--;
    lastIdx.set(t, j);
  }
  const delisted = (t: string) => lastIdx.get(t)! < N - 1 - DELIST_AFTER_DAYS;

  const deposit = Math.max(0, opt.monthlyDeposit ?? 0);
  let cash = opt.initialCash ?? 10_000_000;
  let contributed = cash;
  let units = 1;
  let prevEq = cash;
  /** 종목별로 아직 못 쓴 몫 (합 = 현금) */
  const budget: Record<string, number> = {};
  const pos: Record<string, number> = {};
  const avg: Record<string, number> = {};
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let alive = [...tickers];
  const share = (amount: number, list: string[]) => {
    if (!list.length) return;
    for (const t of list) budget[t] = (budget[t] ?? 0) + amount / list.length;
  };

  for (let i = startIdx; i < N; i++) {
    const d = dates[i];
    if (i === startIdx) share(cash, alive);
    else if (deposit > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7)) {
      const unitPrice = prevEq > 0 && units > 0 ? prevEq / units : 1;
      units += deposit / unitPrice;
      cash += deposit;
      contributed += deposit;
      if (alive.length) share(deposit, alive);
    }

    // 시가 매수
    for (const t of alive) {
      const k = col(t);
      const o = P.open[k][i], v = P.volume[k][i];
      if (!(Number.isFinite(o) && o > 0 && Number.isFinite(v) && v > 0)) continue;
      const px = o * (1 + costs.slippage);
      const n = Math.floor(Math.min(budget[t] ?? 0, cash) / (px * (1 + costs.commission)));
      if (n <= 0) continue;
      const fee = n * px * costs.commission;
      const spent = n * px + fee;
      cash -= spent;
      budget[t] -= spent;
      const q = pos[t] ?? 0;
      avg[t] = ((avg[t] ?? 0) * q + px * n) / (q + n);
      pos[t] = q + n;
      trades.push({ date: d, ticker: t, side: "BUY", qty: n, price: px, fee, pnl: null, ret: null, reason: "rebalance", note: "매수 후 보유" });
    }

    // 상장폐지 정리 → 남은 종목에 다시 나눔
    for (const t of [...alive]) {
      const li = lastIdx.get(t)!;
      if (delisted(t) && i === li + 1) {
        let got = budget[t] ?? 0;
        delete budget[t];
        const q = pos[t] ?? 0;
        if (q > 0) {
          const px = P.closeFilled[col(t)][li];
          const gross = q * px;
          const fee = gross * (costs.commission + sellTax(costs, Number(d.slice(0, 4))));
          cash += gross - fee;
          got += gross - fee;
          trades.push({ date: d, ticker: t, side: "SELL", qty: q, price: px, fee, pnl: (px - avg[t]) * q - fee, ret: px / avg[t] - 1, reason: "delisted" });
          delete pos[t]; delete avg[t];
        }
        alive = alive.filter((x) => x !== t);
        share(got, alive);
      }
    }

    let invested = 0;
    for (const [t, q] of Object.entries(pos)) invested += q * P.closeFilled[col(t)][i];
    const eq = cash + invested;
    prevEq = eq;
    equity.push({ date: d, equity: eq, nav: units > 0 ? eq / units : eq, contributed, cash, invested, benchmark: P.bench ? P.bench[i] : null });
  }

  return {
    equity,
    trades,
    finalPositions: Object.entries(pos).map(([t, q]) => ({ ticker: t, qty: q, avgPrice: avg[t], value: q * P.closeFilled[col(t)][N - 1] })),
    signal: null,
  };
}

/**
 * 비교할 종목 고르기: 종목을 직접 입력했으면 그 종목, 아니면(시총 상위 등) 전략이 기간 중 한 번이라도 산 종목.
 * 고를 종목이 없으면 null.
 */
export function holdTickers(res: BacktestResult, list?: string[] | null): { tickers: string[]; basis: "list" | "traded" } | null {
  if (list?.length) return { tickers: [...new Set(list)], basis: "list" };
  const bought = [...new Set(res.trades.filter((t) => t.side === "BUY").map((t) => t.ticker))];
  return bought.length ? { tickers: bought, basis: "traded" } : null;
}
