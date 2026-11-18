import { describe, expect, it } from "vitest";
import { runBacktest } from "@/lib/engine/engine";
import { businessDays, syntheticSeries } from "@/lib/data/synthetic";
import { STRATEGIES } from "@/lib/strategies";
import type { Bar } from "@/lib/engine/types";

const def = STRATEGIES.find((s) => s.id === "lev_mix")!;
const p = Object.fromEntries(def.params.map((x) => [x.key, x.default]));
const dates = businessDays("2020-01-01", "2021-12-31");
/** 변동을 k배로 키운 시세 (레버리지 ETF 흉내) */
const amplify = (bars: Bar[], k: number): Bar[] => {
  let px = 100;
  return bars.map((b, i) => {
    if (i) px *= 1 + k * (b.close / bars[i - 1].close - 1);
    return { ...b, open: px, high: px, low: px, close: px };
  });
};
const base = syntheticSeries(dates, 7);
const data = { LEV: amplify(base, 3), BOND: syntheticSeries(dates, 8).map((b) => ({ ...b })), GOLD: syntheticSeries(dates, 9) };
const run = () => runBacktest({
  data, strategy: (ctx) => def.targetWeights(ctx, p),
  settings: { rebalance: def.rebalance, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: def.warmup(p) },
  costs: { commission: 0, slippage: 0, sellTax: 0 }, initialCash: 1e8,
});

describe("레버리지 분산", () => {
  it("가장 많이 출렁이는 종목에 50%, 나머지는 25%씩", () => {
    const res = run();
    const first = res.trades.filter((t) => t.date === res.trades[0].date);
    const amt = (t: string) => first.filter((x) => x.ticker === t).reduce((a, x) => a + x.qty * x.price, 0);
    expect(amt("LEV") / 1e8).toBeCloseTo(0.5, 1);
    expect(amt("BOND") / 1e8).toBeCloseTo(0.25, 1);
    expect(amt("GOLD") / 1e8).toBeCloseTo(0.25, 1);
  });

  it("분기에 한 번만 매매하고, 그 밖의 날은 신호가 '유지'", () => {
    const res = run();
    const days = [...new Set(res.trades.map((t) => t.date))];
    const quarters = new Set(days.map((d) => `${d.slice(0, 4)}-${Math.ceil(Number(d.slice(5, 7)) / 3)}`));
    expect(days.length).toBe(quarters.size);
    expect(days.length).toBeGreaterThanOrEqual(5);
    // 마지막 날(분기 첫 거래일이 아님) 신호는 매매 안 함 → 자동 매매가 매일 사고팔지 않음
    expect(res.signal?.kept).toBe(true);
  });
});
