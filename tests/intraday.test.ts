import { describe, expect, it } from "vitest";
import { CYCLE_CODE, cycleParams, cycleWarmup, defaultCycleSpec, normalizeCycleSpec, type CycleSpec } from "@/lib/strategies/cycle";
import { compileStrategy } from "@/lib/strategies";
import { runBacktest } from "@/lib/engine/engine";
import { businessDays } from "@/lib/data/synthetic";
import type { Bar, PriceData, RunSettings } from "@/lib/engine/types";

const days = businessDays("2024-01-01", "2030-12-31");
/** [시가, 고가, 저가, 종가] 목록 → 일봉 */
const bars = (rows: [number, number, number, number][]): Bar[] =>
  rows.map(([open, high, low, close], k) => ({ date: days[k], open, high, low, close, volume: 1000 }));
const flat = (n: number, p: number): [number, number, number, number][] => Array.from({ length: n }, () => [p, p, p, p]);
const noCost = { commission: 0, slippage: 0, sellTax: 0 };
const base: RunSettings = { rebalance: "D", stopLoss: null, takeProfit: null, rebalanceBand: 0, warmup: 1 };
const buyOnce = () => (c: any) => (c.i === 0 ? { A: 1 } : null);

describe("장중 매도: 손절·익절", () => {
  // 0일 신호 → 1일 시가 10000 매수. 3일째 장중 저가 8500 (종가 9500)
  const rows = [...flat(3, 10000), [10000, 10000, 8500, 9500], ...flat(3, 9500)] as [number, number, number, number][];
  it("저가가 손절 가격에 닿은 날 그 가격에 판다", () => {
    const r = runBacktest({ data: { A: bars(rows) }, strategy: buyOnce(), costs: noCost, initialCash: 1_000_000,
      settings: { ...base, stopLoss: 0.1, intraday: true } });
    const s = r.trades.find((t) => t.side === "SELL")!;
    expect(s.date).toBe(days[3]);
    expect(s.price).toBe(9000);
    expect(s.reason).toBe("stop_loss");
  });
  it("끄면 종가가 손절 아래일 때만 다음 날 시가에 판다 (여기선 종가 -5% 라 안 팖)", () => {
    const r = runBacktest({ data: { A: bars(rows) }, strategy: buyOnce(), costs: noCost, initialCash: 1_000_000,
      settings: { ...base, stopLoss: 0.1 } });
    expect(r.trades.filter((t) => t.side === "SELL")).toHaveLength(0);
  });
  it("시가가 이미 손절 가격 아래면 시가에 판다", () => {
    const gap = [...flat(3, 10000), [8000, 8200, 7900, 8100], ...flat(2, 8100)] as [number, number, number, number][];
    const r = runBacktest({ data: { A: bars(gap) }, strategy: buyOnce(), costs: noCost, initialCash: 1_000_000,
      settings: { ...base, stopLoss: 0.1, intraday: true } });
    expect(r.trades.find((t) => t.side === "SELL")!.price).toBe(8000);
  });
  it("익절은 고가가 닿으면 그 가격에", () => {
    const up = [...flat(3, 10000), [10000, 13000, 10000, 11000], ...flat(2, 11000)] as [number, number, number, number][];
    const r = runBacktest({ data: { A: bars(up) }, strategy: buyOnce(), costs: noCost, initialCash: 1_000_000,
      settings: { ...base, takeProfit: 0.2, intraday: true } });
    const s = r.trades.find((t) => t.side === "SELL")!;
    expect([s.date, s.price, s.reason]).toEqual([days[3], 12000, "take_profit"]);
  });
});

describe("장중 매도: 전략이 걸어 둔 매도 가격", () => {
  it("ctx.stops 가격에 닿으면 그 수량만 팔고 ctx.filled 로 알려 준다", () => {
    const seen: any[] = [];
    const strat = (c: any) => {
      if (Object.keys(c.filled).length) seen.push({ i: c.i, ...c.filled.A });
      if (c.positions.A) c.stops.A = [{ below: 9000, qty: 30, note: "테스트 매도" }];
      return c.i === 0 ? { A: 1 } : null;
    };
    const rows = [...flat(3, 10000), [10000, 10000, 8800, 9500], ...flat(3, 9500)] as [number, number, number, number][];
    const r = runBacktest({ data: { A: bars(rows) }, strategy: strat, costs: noCost, initialCash: 1_000_000,
      settings: { ...base, intraday: true } });
    const sells = r.trades.filter((t) => t.side === "SELL");
    expect(sells).toHaveLength(1);
    expect([sells[0].date, sells[0].qty, sells[0].price, sells[0].note]).toEqual([days[3], 30, 9000, "테스트 매도"]);
    expect(seen).toEqual([{ i: 3, n: 1, qty: 30, price: 9000 }]);
    // 마지막 날 신호에 내일 걸 매도 가격이 실림
    expect(r.signal!.stops!.A[0].below).toBe(9000);
  });
});

describe("적립 전략 장중 매도", () => {
  const run = (spec: CycleSpec, data: PriceData, intraday: boolean) => {
    const fn = compileStrategy(CYCLE_CODE);
    const p = cycleParams(spec);
    return runBacktest({ data, initialCash: 10_000_000, costs: noCost,
      settings: { rebalance: "D", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: cycleWarmup(spec), intraday },
      strategy: (c) => fn(c, p) });
  };
  const spec = normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "M", days: 20, unit: "pct", value: 50 },
    drop: { unit: "pct", value: 10, step: 5, maxSteps: 3, peakDays: 0 }, sell: { unit: "pct", value: 10 } });
  // 10000 에서 사고, 하루 장중 8400 까지 빠졌다가 9500 으로 마감, 그 뒤 9500 유지
  const rows = [...flat(5, 10000), [10000, 10000, 8400, 9500], ...flat(5, 9500)] as [number, number, number, number][];

  it("최고가 -10%(9000)·-15%(8500) 가격에 그날 장중에 판다", () => {
    const r = run(spec, { A: bars(rows) }, true);
    const sells = r.trades.filter((t) => t.side === "SELL");
    expect(sells.map((t) => [t.date, t.price])).toEqual([[days[5], 9000], [days[5], 8500]]);
    // 총자산 10% 씩 (1천만 원 → 약 100만 원)
    expect(sells[0].qty * sells[0].price).toBeGreaterThanOrEqual(1_000_000);
    expect(sells[0].qty * sells[0].price).toBeLessThan(1_010_000);
    // 다음 날엔 단계가 넘어가 -20% 가격(8000)을 건다
    expect(r.signal!.stops!.A[0].below).toBe(8000);
  });
  it("끄면 종가(-5%)로는 팔지 않는다", () => {
    const r = run(spec, { A: bars(rows) }, false);
    expect(r.trades.filter((t) => t.side === "SELL")).toHaveLength(0);
  });
});
