import { describe, expect, it } from "vitest";
import { holdTickers, runBuyAndHold } from "@/lib/engine/buyhold";
import { runBacktest } from "@/lib/engine/engine";
import { summarize } from "@/lib/engine/metrics";
import type { Bar, PriceData } from "@/lib/engine/types";

const days = (start: string, n: number) => {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  while (out.length < n) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
};
const series = (dates: string[], f: (k: number) => number): Bar[] =>
  dates.map((date, k) => ({ date, open: f(k), high: f(k), low: f(k), close: f(k), volume: 1000 }));
const free = { commission: 0, slippage: 0, sellTax: 0 };

describe("매수 후 보유 비교", () => {
  const dates = days("2022-01-03", 120);
  const data: PriceData = { A: series(dates, () => 1000), B: series(dates, (k) => 1000 + k * 10) };

  it("첫날 시가에 같은 금액으로 나눠 사고 팔지 않는다", () => {
    const r = runBuyAndHold({ data, initialCash: 1_000_000, startDate: dates[0], tickers: ["A", "B"], costs: free })!;
    const first = r.trades.filter((t) => t.date === dates[0]);
    expect(first.map((t) => [t.ticker, t.qty])).toEqual([["A", 500], ["B", 500]]);
    expect(r.trades.every((t) => t.side === "BUY")).toBe(true);
    const last = r.equity.at(-1)!;
    expect(last.equity).toBeCloseTo(500 * 1000 + 500 * (1000 + 119 * 10), 6);
    expect(last.cash).toBeCloseTo(0, 6);
  });

  it("매달 추가 입금도 같은 비율로 사고, 남는 돈은 모아 두었다가 1주가 되면 산다", () => {
    const r = runBuyAndHold({ data, initialCash: 1_000_000, monthlyDeposit: 1500, startDate: dates[0], tickers: ["A", "B"], costs: free })!;
    const s = summarize(r);
    expect(s.deposits).toBe(1500 * 5); // 2~6월 첫 거래일
    // A 는 1000원: 한 달 750원씩 → 두 달에 1주
    const aBuys = r.trades.filter((t) => t.ticker === "A" && t.date !== dates[0]);
    expect(aBuys.reduce((a, t) => a + t.qty, 0)).toBe(Math.floor((750 * 5) / 1000));
    expect(r.equity.at(-1)!.contributed).toBe(1_000_000 + 7500);
    // nav 기준 수익률은 입금 효과를 뺌: A 는 가격이 그대로라 B 상승분 절반 정도만
    expect(s.totalReturn).toBeGreaterThan(0);
  });

  it("전략 결과와 날짜가 맞고, 종목 고르기 규칙을 따른다", () => {
    const res = runBacktest({ data, startDate: dates[20], initialCash: 1_000_000,
      settings: { rebalance: "M", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 1 },
      strategy: () => ({ B: 0.5 }) });
    expect(holdTickers(res, ["A", "B"])).toEqual({ tickers: ["A", "B"], basis: "list" });
    expect(holdTickers(res, null)).toEqual({ tickers: ["B"], basis: "traded" });
    const h = runBuyAndHold({ data, startDate: dates[20], initialCash: 1_000_000, tickers: ["B"] })!;
    expect(h.equity[0].date).toBe(res.equity[0].date);
    expect(h.equity.length).toBe(res.equity.length);
    expect(runBuyAndHold({ data, tickers: ["ZZZ"] })).toBeNull();
  });

  it("상장폐지 종목은 정리해서 남은 종목을 산다", () => {
    const d2: PriceData = { A: series(dates.slice(0, 40), () => 1000), B: series(dates, () => 1000) };
    const r = runBuyAndHold({ data: d2, initialCash: 1_000_000, startDate: dates[0], tickers: ["A", "B"], costs: free })!;
    expect(r.trades.some((t) => t.ticker === "A" && t.reason === "delisted")).toBe(true);
    expect(r.finalPositions).toEqual([{ ticker: "B", qty: 1000, avgPrice: 1000, value: 1_000_000 }]);
  });
});
