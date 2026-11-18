import { describe, expect, it } from "vitest";
import { runBacktest } from "@/lib/engine/engine";
import { businessDays } from "@/lib/data/synthetic";
import { STRATEGIES } from "@/lib/strategies";
import type { Bar } from "@/lib/engine/types";

const dates = businessDays("2020-01-01", "2021-12-31");
/** 하루 drift 만큼 오르고 ±wig 로 번갈아 출렁이는 시세 */
const walk = (drift: number, wig: number): Bar[] => {
  let px = 100;
  return dates.map((date, i) => {
    if (i) px *= 1 + drift + (i % 2 ? wig : -wig);
    return { date, open: px, high: px, low: px, close: px, volume: 1e6 };
  });
};
const def = (id: string) => STRATEGIES.find((s) => s.id === id)!;
const defaults = (id: string) => Object.fromEntries(def(id).params.map((x) => [x.key, x.default]));
const run = (id: string, data: Record<string, Bar[]>, p = defaults(id)) => runBacktest({
  data, strategy: (ctx) => def(id).targetWeights(ctx, p),
  settings: { rebalance: def(id).rebalance, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: def(id).warmup(p) },
  costs: { commission: 0, slippage: 0, sellTax: 0 }, initialCash: 1e8,
});
const firstBuys = (res: ReturnType<typeof run>) => {
  const d = res.trades[0].date;
  const out: Record<string, number> = {};
  for (const t of res.trades.filter((x) => x.date === d)) out[t.ticker] = (out[t.ticker] ?? 0) + t.qty * t.price / 1e8;
  return out;
};

describe("모멘텀 상위 N 회전", () => {
  it("모멘텀 상위 3종목을 똑같이, 떨어지는 종목은 안 삼", () => {
    const res = run("rotation", { A: walk(0.003, 0.005), B: walk(0.002, 0.005), C: walk(0.001, 0.005), D: walk(-0.001, 0.005) });
    const w = firstBuys(res);
    expect(Object.keys(w).sort()).toEqual(["A", "B", "C"]);
    for (const t of ["A", "B", "C"]) expect(w[t]).toBeCloseTo(1 / 3, 1);
    expect(res.trades.some((t) => t.ticker === "D")).toBe(false);
  });
  it("다 떨어지면 현금", () => {
    const res = run("rotation", { A: walk(-0.001, 0.005), B: walk(-0.002, 0.005) });
    expect(res.trades).toHaveLength(0);
  });
});

describe("추세 + 위험 균형", () => {
  it("덜 출렁이는 종목에 더 많이, 내리막 종목은 현금, 합계 100% 이하", () => {
    const res = run("trend_parity", { CALM: walk(0.0005, 0.003), WILD: walk(0.001, 0.012), DOWN: walk(-0.001, 0.003) });
    const w = firstBuys(res);
    expect(w.DOWN).toBeUndefined();
    expect(w.CALM).toBeGreaterThan(w.WILD * 3);
    const sum = w.CALM + w.WILD;
    expect(sum).toBeLessThanOrEqual(1.001);
  });
  it("목표 변동성을 낮추면 덜 담음", () => {
    const data = { CALM: walk(0.0005, 0.003), WILD: walk(0.001, 0.012) };
    const sum = (res: ReturnType<typeof run>) => Object.values(firstBuys(res)).reduce((a, b) => a + b, 0);
    expect(sum(run("trend_parity", data, { ...defaults("trend_parity"), target: 3 }))).toBeLessThan(sum(run("trend_parity", data)));
  });
});
