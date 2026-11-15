import { describe, expect, it } from "vitest";
import { buildCandidates, maxWarmup } from "@/lib/finder/candidates";
import { evaluate, isNeighbor, score, walkForward } from "@/lib/finder/search";
import { runBacktest } from "@/lib/engine/engine";
import { runBuyAndHold } from "@/lib/engine/buyhold";
import { compileStrategy } from "@/lib/strategies";
import { businessDays, syntheticSeries } from "@/lib/data/synthetic";
import type { PriceData } from "@/lib/engine/types";

const free = { commission: 0, slippage: 0, sellTax: 0 };

describe("전략 찾기 후보", () => {
  it("종목 수에 맞게 후보를 만든다 (1종목엔 비중 고정이 없음)", () => {
    const one = buildCandidates(["A"]);
    const three = buildCandidates(["A", "B", "C"]);
    expect(one.some((c) => c.family === "fixed")).toBe(false);
    expect(three.filter((c) => c.family === "fixed").length).toBe(8);
    expect(three.length).toBeLessThanOrEqual(120);
    expect(new Set(three.map((c) => c.id)).size).toBe(three.length);
    expect(maxWarmup(three)).toBeGreaterThanOrEqual(251);
  });

  it("모든 후보 코드가 실행된다", () => {
    const dates = businessDays("2018-01-01", "2021-12-31");
    const data: PriceData = { A: syntheticSeries(dates, 1), B: syntheticSeries(dates, 2) };
    for (const c of buildCandidates(["A", "B"])) {
      const fn = compileStrategy(c.code);
      const res = runBacktest({
        data, startDate: "2019-06-01", costs: free,
        settings: { rebalance: c.rebalance, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: c.warmup },
        strategy: (ctx) => fn(ctx, c.params),
      });
      expect(res.equity.length).toBeGreaterThan(100);
    }
  });

  it("이평선 위 보유: 계속 오르는 종목은 들고, 계속 내리는 종목은 안 산다", () => {
    const dates = businessDays("2020-01-01", "2021-06-30");
    const bar = (date: string, p: number) => ({ date, open: p, high: p, low: p, close: p, volume: 1000 });
    const data: PriceData = {
      UP: dates.map((d, k) => bar(d, 1000 * 1.001 ** k)),
      DN: dates.map((d, k) => bar(d, 1000 * 0.999 ** k)),
    };
    const c = buildCandidates(["UP", "DN"]).find((x) => x.family === "trend" && x.params.ma === 50 && x.params.splitMode === 1 && x.rebalance === "W")!;
    const fn = compileStrategy(c.code);
    const res = runBacktest({
      data, startDate: "2020-06-01", costs: free,
      settings: { rebalance: c.rebalance, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: c.warmup },
      strategy: (ctx) => fn(ctx, c.params),
    });
    expect(res.trades.some((t) => t.ticker === "DN")).toBe(false);
    expect(res.finalPositions.map((p) => p.ticker)).toEqual(["UP"]);
  });
});

describe("전략 찾기 평가", () => {
  const dates = businessDays("2016-01-01", "2023-12-31");
  const data: PriceData = { A: syntheticSeries(dates, 11), B: syntheticSeries(dates, 12) };
  const cands = buildCandidates(["A", "B"]);
  const runs = cands.map((c) => {
    const fn = compileStrategy(c.code);
    return { c, res: runBacktest({
      data, startDate: "2017-03-01", costs: free,
      settings: { rebalance: c.rebalance, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: c.warmup },
      strategy: (ctx) => fn(ctx, c.params),
    }) };
  });
  const hold = runBuyAndHold({ data, startDate: "2017-03-01", tickers: ["A", "B"], costs: free });

  it("앞 구간 성적으로만 순위를 매긴다", () => {
    const r = evaluate(runs, hold, { objective: "cagr", testRatio: 0.3, maxDrawdown: 0.25 });
    expect(r.tried).toBe(cands.length);
    expect(r.best.rank).toBe(1);
    for (let k = 1; k < r.rows.length; k++) expect(r.rows[k - 1].score).toBeGreaterThanOrEqual(r.rows[k].score);
    expect(r.best.train.cagr).toBe(Math.max(...r.rows.map((x) => x.train.cagr)));
    expect(r.splitDate > r.start && r.splitDate < r.end).toBe(true);
    expect(r.hold).not.toBeNull();
    expect(r.checks.length).toBeGreaterThanOrEqual(4);
    expect(["high", "mid", "low"]).toContain(r.verdict);
  });

  it("낙폭 기준을 넘은 설정은 뒤로 보낸다", () => {
    const r = evaluate(runs, hold, { objective: "capped", testRatio: 0.3, maxDrawdown: 0.1 });
    const firstBad = r.rows.findIndex((x) => x.train.mdd < -0.1);
    const lastGood = r.rows.map((x) => x.train.mdd >= -0.1).lastIndexOf(true);
    if (firstBad >= 0 && lastGood >= 0) expect(lastGood).toBeLessThan(firstBad);
  });

  it("해마다 다시 고르기는 그해 이전 데이터만으로 고른다", () => {
    const d = businessDays("2018-01-01", "2021-12-31");
    // X 는 2020년까지 오르다 2021년에 급락, Y 는 늘 평평 → 2021년엔 X 를 골라야 함(그 전엔 X 가 1등이었으므로)
    const xs = d.map((date, k) => (date < "2021-01-01" ? 100 * 1.001 ** k : 100 * 1.001 ** d.findIndex((z) => z >= "2021-01-01") * 0.998 ** (k - d.findIndex((z) => z >= "2021-01-01"))));
    const ys = d.map(() => 100);
    const mk = (name: string): any => ({ id: name, family: "fixed", name, code: "", params: {}, rebalance: "M", warmup: 1 });
    const w = walkForward(d, [{ c: mk("X"), v: xs }, { c: mk("Y"), v: ys }], ys, { objective: "cagr", testRatio: 0.3, maxDrawdown: 0.25, minTrainDays: 400 })!;
    const y2021 = w.years.find((y) => y.year === 2021)!;
    expect(y2021.pick).toBe("X");
    expect(y2021.ret).toBeLessThan(0);
  });

  it("이웃 설정과 점수", () => {
    const [a, b] = cands.filter((c) => c.family === "trend" && c.rebalance === "W" && c.params.splitMode === 0);
    expect(isNeighbor(a, b)).toBe(true);
    expect(isNeighbor(a, a)).toBe(false);
    const s = { totalReturn: 0.5, cagr: 0.2, mdd: -0.3, volatility: 0.2, sharpe: 1, sortino: 1, calmar: 0.2 / 0.3 };
    expect(score(s, "cagr", 0.25)).toBe(0.2);
    expect(score(s, "capped", 0.25)).toBeLessThan(0);
    expect(score(s, "calmar", 0.25)).toBeCloseTo(0.2 / 0.3);
  });

  it("기간이 너무 짧으면 알려 준다", () => {
    const short = runs.map(({ c, res }) => ({ c, res: { ...res, equity: res.equity.slice(0, 100) } }));
    expect(() => evaluate(short, null, { objective: "cagr", testRatio: 0.3, maxDrawdown: 0.25 })).toThrow(/짧습니다/);
  });
});
