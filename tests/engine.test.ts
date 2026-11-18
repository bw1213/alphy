import { describe, expect, it } from "vitest";
import { runBacktest, rebalanceDays } from "@/lib/engine/engine";
import { summarize } from "@/lib/engine/metrics";
import { businessDays, syntheticData, syntheticSeries } from "@/lib/data/synthetic";
import { parseFchart, parseMarketSumHtml } from "@/lib/data/naver";
import { STRATEGIES, compileStrategy } from "@/lib/strategies";
import type { RunSettings } from "@/lib/engine/types";

const base: RunSettings = { rebalance: "D", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 0 };
const noCost = { commission: 0, slippage: 0, sellTax: 0 };

describe("engine", () => {
  const dates = businessDays("2020-01-01", "2021-12-31");
  const A = syntheticSeries(dates, 1);

  it("매수 후 보유 = 가격 변화와 일치", () => {
    const res = runBacktest({ data: { A }, strategy: (c) => (c.held().length ? null : { A: 1 }), settings: base, costs: noCost, initialCash: 1e8 });
    const px = A[1].open; // 첫날 신호 → 다음날 시가
    const sh = Math.floor(1e8 / px);
    expect(res.equity.at(-1)!.equity).toBeCloseTo(1e8 - sh * px + sh * A.at(-1)!.close, 3);
    expect(res.trades).toHaveLength(1);
  });

  it("비용이 있으면 자산이 줄어든다", () => {
    const run = (costs: any) => runBacktest({ data: { A }, strategy: (c) => (c.held().length ? null : { A: 1 }), settings: base, costs, initialCash: 1e8 });
    expect(run({ commission: 0.00015, slippage: 0.001, sellTax: 0.002 }).equity.at(-1)!.equity)
      .toBeLessThan(run(noCost).equity.at(-1)!.equity);
  });

  it("미래 데이터를 볼 수 없고 거래정지일엔 체결 안 됨", () => {
    const B = A.map((b) => ({ ...b }));
    B[1].volume = 0;
    let peek = 0;
    const res = runBacktest({ data: { A: B }, settings: base, strategy: (c) => {
      peek = Math.max(peek, Number.isNaN(c.close("A", -1)) ? 0 : 1);
      return { A: 0.5 };
    } });
    expect(peek).toBe(0);
    expect(res.trades[0].date).toBe(B[2].date);
  });

  it("손절 규칙", () => {
    const C = A.map((b, k) => ({ ...b, open: k < 5 ? 100 : 80, close: k < 4 ? 100 : 80, high: 100, low: 80 }));
    const res = runBacktest({ data: { C }, settings: { ...base, stopLoss: 0.1 }, costs: noCost,
      strategy: (c) => (c.dayIndex === 0 ? { C: 1 } : null) });
    expect(res.trades.some((t) => t.reason === "stop_loss")).toBe(true);
  });

  it("월말 리밸런싱 날짜", () => {
    const r = rebalanceDays(["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-29"], "M");
    expect([...r]).toEqual([1, 3]);
  });
});

describe("strategies", () => {
  const { data, benchmark } = syntheticData(30, "2019-01-01", "2022-12-31");
  for (const s of STRATEGIES) {
    it(`${s.id} 실행`, () => {
      const p = Object.fromEntries(s.params.map((x) => [x.key, x.default]));
      const res = runBacktest({ data, benchmark, strategy: (c) => s.targetWeights(c, p),
        settings: { ...base, rebalance: s.rebalance, stopLoss: s.stopLoss, takeProfit: s.takeProfit, warmup: s.warmup(p) }, startDate: "2020-01-01" });
      const sum = summarize(res);
      expect(res.equity[0].date >= "2020-01-01").toBe(true);
      expect(Number.isFinite(sum.cagr)).toBe(true);
      expect(res.trades.length).toBeGreaterThan(0);
    });
  }
  it("사용자 코드 컴파일", () => {
    const fn = compileStrategy("return ctx.equal(ctx.topBy((t) => ctx.ret(t, 20), p.k));");
    const res = runBacktest({ data, strategy: (c) => fn(c, { k: 3 }), settings: { ...base, rebalance: "M", warmup: 21 } });
    expect(res.trades.length).toBeGreaterThan(0);
  });
});

describe("naver parser", () => {
  it("fchart XML", () => {
    const xml = `<chartdata symbol="005930"><item data="20240102|78200|79800|78200|79600|17142847" /><item data="20240103|78500|78800|77000|77000|21753644" /></chartdata>`;
    const b = parseFchart(xml);
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({ date: "2024-01-02", open: 78200, high: 79800, low: 78200, close: 79600, volume: 17142847 });
  });
  it("시총 페이지 HTML", () => {
    const html = `<a href="/item/main.naver?code=005930" class="tltle">삼성전자</a><a href="/item/main.naver?code=000660" class="tltle">SK하이닉스</a>`;
    expect(parseMarketSumHtml(html).map((x) => x.code)).toEqual(["005930", "000660"]);
  });
});
