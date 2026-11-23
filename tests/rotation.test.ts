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

describe("모멘텀 회전 (조절 많은 버전)", () => {
  const data = () => ({ A: walk(0.003, 0.005), B: walk(0.002, 0.005), C: walk(0.001, 0.005), D: walk(-0.001, 0.005) });
  it("기본값은 모멘텀 상위 N 회전과 같은 매매", () => {
    const a = run("rotation", data()), b = run("rotation_plus", data());
    expect(b.trades.map((t) => [t.date, t.ticker, t.qty])).toEqual(a.trades.map((t) => [t.date, t.ticker, t.qty]));
  });
  it("피난처: 남는 몫을 가장 덜 출렁이는 오르는 종목에", () => {
    const d = { UP: walk(0.003, 0.01), SAFE: walk(0.0002, 0.001), DOWN: walk(-0.002, 0.01) };
    const w = firstBuys(run("rotation_plus", d, { ...defaults("rotation_plus"), topK: 3, minMom: 5, safe: 1 }));
    expect(w.UP).toBeCloseTo(1 / 3, 1);
    expect(w.SAFE).toBeCloseTo(2 / 3, 1);
    expect(w.DOWN).toBeUndefined();
  });
  it("변동성 목표를 낮추면 덜 담음", () => {
    const sum = (res: ReturnType<typeof run>) => Object.values(firstBuys(res)).reduce((a, b) => a + b, 0);
    const d = { A: walk(0.003, 0.02), B: walk(0.002, 0.02), C: walk(0.001, 0.02) };
    expect(sum(run("rotation_plus", d, { ...defaults("rotation_plus"), volT: 10 }))).toBeLessThan(sum(run("rotation_plus", d)) - 0.2);
  });
  it("변동성 목표 기간을 늘리면 그 전의 큰 출렁임도 반영", () => {
    const sum = (res: ReturnType<typeof run>) => Object.values(firstBuys(res)).reduce((a, b) => a + b, 0);
    let px = 100;
    const calmLate = dates.map((date, i) => { if (i) px *= 1.002 + (i % 2 ? 1 : -1) * (i < 190 ? 0.03 : 0.003); return { date, open: px, high: px, low: px, close: px, volume: 1e6 }; });
    const d = { A: calmLate };
    const p = { ...defaults("rotation_plus"), topK: 1, volT: 20 };
    expect(sum(run("rotation_plus", d, { ...p, volDays: 120 }))).toBeLessThan(sum(run("rotation_plus", d, p)) - 0.2);
  });
  it("여러 설정 평균: 종목 수 N·N-1 로 고른 비중의 평균", () => {
    const w = firstBuys(run("rotation_plus", data(), { ...defaults("rotation_plus"), topK: 2, ens: 1 }));
    expect(w.A).toBeCloseTo(0.75, 1);
    expect(w.B).toBeCloseTo(0.25, 1);
    expect(w.C).toBeUndefined();
  });
});
