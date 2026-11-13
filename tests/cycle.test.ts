import { describe, expect, it } from "vitest";
import { CYCLE_CODE, cycleParams, cycleWarmup, defaultCycleSpec, describeCycle, normalizeCycleSpec, type CycleSpec } from "@/lib/strategies/cycle";
import { compileStrategy } from "@/lib/strategies";
import { cleanStrategy } from "@/lib/strategies/library";
import { runBacktest } from "@/lib/engine/engine";
import { businessDays, syntheticData } from "@/lib/data/synthetic";
import { paramVariants } from "@/lib/engine/validate";
import { summarize } from "@/lib/engine/metrics";
import { HOLD, type Bar, type PriceData } from "@/lib/engine/types";

/** 가격 경로를 일봉으로 (시가 = 전일 종가, 거래량 있음) */
function series(prices: number[], start = "2024-01-01"): Bar[] {
  const dates = businessDays(start, "2030-12-31").slice(0, prices.length);
  return prices.map((c, k) => {
    const o = k ? prices[k - 1] : c;
    return { date: dates[k], open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 1000 };
  });
}
// 60일 상승(10000→13000), 40일 하락(→7800, -40%), 바닥 20일, 40일 회복
const path = [
  ...Array.from({ length: 60 }, (_, k) => 10000 + k * 50),
  ...Array.from({ length: 40 }, (_, k) => 12950 - k * 130),
  ...Array.from({ length: 20 }, () => 7800),
  ...Array.from({ length: 40 }, (_, k) => 7800 + k * 60),
];
const run = (spec: CycleSpec, data: PriceData = { A: series(path) }, cash = 10_000_000) => {
  const fn = compileStrategy(CYCLE_CODE);
  const p = cycleParams(spec);
  return runBacktest({ data, initialCash: cash,
    settings: { rebalance: "D", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: cycleWarmup(spec) },
    costs: { commission: 0, slippage: 0, sellTax: 0 },
    strategy: (c) => fn(c, p) });
};

describe("적립 매수 + 하락 시 분할 매도", () => {
  it("상승 구간엔 매달 적립하고, 하락하면 단계별로 팔고, 안정되면 다시 산다", () => {
    // 매월 30%, -10% 에 20% 매도, 5%p 마다 추가(최대 3번), 반등 5% + 10일 신저가 없음
    const spec = normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "M", days: 20, unit: "pct", value: 30 }, sell: { unit: "pct", value: 15 } });
    const res = run(spec);
    const buys = res.trades.filter((t) => t.side === "BUY");
    const sells = res.trades.filter((t) => t.side === "SELL");
    // 상승 60일(1월~3월 말) 동안 1·2·3월 적립 (작은 금액도 밴드에 걸리지 않고 체결)
    const early = buys.filter((t) => t.date < "2024-03-26");
    expect(early.length).toBe(3);
    for (const t of early) expect(t.qty * t.price).toBeGreaterThan(2_500_000);
    // 고점 12950 → -10% 에서 첫 매도, -15%, -20%, -25% 에서 추가 매도 = 4번 (최대 3번 추가)
    expect(sells.length).toBe(4);
    // 하락 대응 중(첫 매도~재개 전)에는 사지 않음
    const firstSell = sells[0].date, lastSell = sells.at(-1)!.date;
    const resume = buys.find((t) => t.date > lastSell)!;
    expect(resume).toBeDefined();
    expect(buys.filter((t) => t.date > firstSell && t.date < resume.date)).toHaveLength(0);
    // 재개는 바닥(7800)에서 5% 이상 반등(8190 이상) 후
    expect(resume.price).toBeGreaterThanOrEqual(8190 * 0.99);
    // 매도 규모: 총자산의 약 15%씩
    const eqAt = (d: string) => res.equity.find((e) => e.date >= d)!.equity;
    const v = sells[0].qty * sells[0].price;
    expect(v / eqAt(sells[0].date)).toBeGreaterThan(0.12);
    expect(v / eqAt(sells[0].date)).toBeLessThan(0.18);
  });

  it("정액 매수·정액 매도, 원 단위 하락 기준", () => {
    const spec = normalizeCycleSpec({
      buy: { period: "days", days: 10, unit: "won", value: 150_000 },
      drop: { unit: "won", value: 1500, step: 1000, maxSteps: 0, peakDays: 0 },
      sell: { unit: "won", value: 200_000 },
      stable: { rebound: 0, calmDays: 5, ma: 0 },
    });
    const res = run(spec);
    const buys = res.trades.filter((t) => t.side === "BUY");
    expect(buys[0].qty * buys[0].price).toBeLessThanOrEqual(150_000);
    expect(buys[0].qty * buys[0].price).toBeGreaterThan(130_000);
    // 10영업일 간격 (총자산의 1.5%라 리밸런싱 밴드 2%보다 작아도 체결)
    expect(buys.filter((t) => t.date < "2024-03-26").length).toBe(6);
    const sells = res.trades.filter((t) => t.side === "SELL");
    expect(sells.length).toBeGreaterThan(1);
    for (const t of sells.slice(0, -1)) expect(t.qty * t.price).toBeLessThan(260_000);
  });

  it("최대 매도 횟수 0 이면 계속 떨어질 때 다 팔 때까지 판다", () => {
    const spec = normalizeCycleSpec({ ...defaultCycleSpec(), drop: { unit: "pct", value: 10, step: 3, maxSteps: 0, peakDays: 0 }, sell: { unit: "pct", value: 30 } });
    const res = run(spec);
    const firstSell = res.trades.find((t) => t.side === "SELL")!.date;
    const bottom = res.equity.find((e) => e.date > firstSell && e.invested === 0);
    expect(bottom).toBeDefined();
  });

  it("여러 종목: 종목마다 따로 돌고, 손대지 않는 종목은 그대로 둔다", () => {
    const flat = Array.from({ length: path.length }, (_, k) => 5000 + (k % 2) * 10); // 계속 같은 가격 근처 → 매도 없음
    const res = run(defaultCycleSpec(), { A: series(path), B: series(flat) });
    const bSells = res.trades.filter((t) => t.ticker === "B" && t.side === "SELL");
    expect(bSells).toHaveLength(0); // A 를 팔 때 B 는 HOLD 라 안 팔림
    expect(res.trades.filter((t) => t.ticker === "A" && t.side === "SELL").length).toBeGreaterThan(0);
  });

  it("현금이 모자라면 있는 만큼만 사고 비중 합이 100%를 넘지 않는다", () => {
    const spec = normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "W", days: 5, unit: "pct", value: 40 } });
    const res = run(spec);
    for (const e of res.equity) expect(e.cash).toBeGreaterThanOrEqual(-1);
  });

  it("마지막 날 신호는 HOLD 를 지금 비중으로 보여준다", () => {
    const res = run(defaultCycleSpec());
    expect(res.signal).not.toBeNull();
    for (const p of res.signal!.picks) expect(p.weight).toBeGreaterThanOrEqual(0);
    expect(res.signal!.picks.some((p) => p.weight === HOLD)).toBe(false);
  });

  it("실제 같은 랜덤 데이터에서도 오류 없이 돈다", () => {
    const d = syntheticData(3, "2020-01-01", "2023-12-29");
    const res = run(defaultCycleSpec(), d.data);
    expect(Number.isFinite(res.equity.at(-1)!.equity)).toBe(true);
    expect(res.trades.length).toBeGreaterThan(0);
  });

  it("입력값 정리·저장·민감도 검사", () => {
    const s = normalizeCycleSpec({ buy: { unit: "pct", value: 500 }, stable: { rebound: 0, calmDays: 0, ma: 0 } });
    expect(s.buy.value).toBe(100);
    expect(s.stable.calmDays).toBe(10); // 안정화 조건이 하나도 없으면 기본 하나를 켬
    expect(describeCycle(s)).toHaveLength(4);
    const saved = cleanStrategy({ name: "적립", code: CYCLE_CODE, params: JSON.stringify(cycleParams(s)), rebalance: "D", warmup: 2, cycle: s });
    expect(saved.cycle).toEqual(s);
    const keys = new Set(paramVariants(cycleParams(defaultCycleSpec())).map((v) => v.key));
    expect([...keys].some((k) => k.endsWith("Mode"))).toBe(false);
    expect(keys.has("dropValue")).toBe(true);
  });
});

describe("매달 추가 입금", () => {
  const flat = Array.from({ length: 130 }, () => 10000);
  const base = (deposit: number, prices = flat) => runBacktest({
    data: { A: series(prices) }, initialCash: 10_000_000, monthlyDeposit: deposit,
    settings: { rebalance: "M", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 1 },
    costs: { commission: 0, slippage: 0, sellTax: 0 },
    strategy: () => ({ A: 1 }),
  });

  it("매월 첫 거래일에 들어오고, 수익률은 입금 효과를 뺀다", () => {
    const res = base(1_000_000);
    const last = res.equity.at(-1)!;
    const months = new Set(res.equity.map((e) => e.date.slice(0, 7))).size;
    expect(last.contributed).toBe(10_000_000 + (months - 1) * 1_000_000);
    expect(last.equity).toBeCloseTo(last.contributed!, -1); // 가격이 그대로라 손익 0
    const s = summarize(res);
    expect(s.totalReturn).toBeCloseTo(0, 6); // 입금이 수익으로 잡히지 않음
    expect(s.deposits).toBe((months - 1) * 1_000_000);
    expect(s.contributed).toBeCloseTo(res.equity[0].equity + s.deposits, 6);
    expect(s.final).toBe(last.equity);
    // 입금된 돈은 다음 리밸런싱에 투자됨
    expect(res.trades.filter((t) => t.side === "BUY").length).toBeGreaterThan(1);
  });

  it("입금이 있어도 같은 가격 흐름이면 수익률은 거의 같다", () => {
    const up = Array.from({ length: 130 }, (_, k) => 10000 * 1.002 ** k);
    const a = summarize(base(0, up)), b = summarize(base(2_000_000, up));
    expect(Math.abs(a.totalReturn - b.totalReturn)).toBeLessThan(0.01);
    expect(b.final).toBeGreaterThan(a.final);
  });

  it("입금이 없으면 nav 와 평가액이 같다", () => {
    for (const e of base(0).equity) expect(e.nav).toBe(e.equity);
  });

  it("적립·분할 매도 전략은 입금된 현금으로 다음 적립을 한다", () => {
    const fn = compileStrategy(CYCLE_CODE);
    const p = cycleParams(normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "M", days: 20, unit: "won", value: 1_000_000 } }));
    const res = runBacktest({ data: { A: series(flat) }, initialCash: 1_000_000, monthlyDeposit: 1_000_000,
      settings: { rebalance: "D", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 2 },
      costs: { commission: 0, slippage: 0, sellTax: 0 }, strategy: (c) => fn(c, p) });
    const buys = res.trades.filter((t) => t.side === "BUY");
    expect(buys.length).toBeGreaterThanOrEqual(5); // 첫 달 + 이후 매달
  });
});

describe("적립·분할 매도: 투자 비율과 리밸런싱", () => {
  const rise = Array.from({ length: 200 }, (_, k) => 10000 * 1.004 ** k); // 계속 오름 → 매도 신호 없음
  it("주식 비중 상한까지만 적립한다", () => {
    const spec = normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "W", days: 5, unit: "pct", value: 20 }, limit: { maxInvest: 50, rebalance: "off" } });
    const res = run(spec, { A: series(Array.from({ length: 120 }, () => 10000)) });
    for (const e of res.equity) expect(e.invested / e.equity).toBeLessThanOrEqual(0.505);
    expect(res.equity.at(-1)!.invested / res.equity.at(-1)!.equity).toBeGreaterThan(0.45);
  });
  it("리밸런싱을 켜면 올라서 넘친 비중을 주기마다 팔아 맞춘다", () => {
    const spec = normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "W", days: 5, unit: "pct", value: 30 }, limit: { maxInvest: 50, rebalance: "M" } });
    const off = run(normalizeCycleSpec({ ...spec, limit: { maxInvest: 50, rebalance: "off" } }), { A: series(rise) });
    const on = run(spec, { A: series(rise) });
    const w = (r: typeof on) => r.equity.at(-1)!.invested / r.equity.at(-1)!.equity;
    expect(w(off)).toBeGreaterThan(0.53); // 리밸런싱 없으면 오른 만큼 비중이 커짐
    expect(w(on)).toBeLessThan(w(off));
    expect(on.trades.some((t) => t.side === "SELL")).toBe(true);
    for (const t of on.trades.filter((x) => x.side === "SELL")) expect(t.date.slice(8)).toMatch(/0[1-5]/); // 월초에만 판다
  });
  it("예전에 저장한 값(투자 비율 없음)은 제한 없음으로", () => {
    const { limit, ...old } = defaultCycleSpec();
    expect(normalizeCycleSpec(old).limit).toEqual({ maxInvest: 100, rebalance: "off" });
    expect(describeCycle(normalizeCycleSpec(old))).toHaveLength(4);
    expect(describeCycle(normalizeCycleSpec({ ...old, limit: { maxInvest: 70, rebalance: "Q" } }))).toHaveLength(5);
  });
});

describe("거래 내역의 매매 이유", () => {
  it("리밸런싱을 끄면 리밸런싱 거래가 없고, 모든 거래에 실제 이유가 붙는다", () => {
    const spec = normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "M", days: 20, unit: "pct", value: 30 }, sell: { unit: "pct", value: 15 } });
    const res = run(spec);
    expect(res.trades.length).toBeGreaterThan(0);
    for (const t of res.trades) {
      expect(t.note, `${t.date} ${t.side}`).toBeTruthy();
      expect(t.note).not.toContain("리밸런싱");
    }
    const notes = res.trades.map((t) => t.note!);
    expect(notes).toContain("적립 매수");
    expect(notes.some((n) => n.startsWith("하락 매도"))).toBe(true);
    expect(notes.some((n) => n.startsWith("추가 매도"))).toBe(true);
    expect(notes).toContain("안정화 후 다시 적립");
  });
  it("리밸런싱을 켜면 비중 맞추기 매도에 리밸런싱이라고 표시된다", () => {
    const rise = Array.from({ length: 200 }, (_, k) => 10000 * 1.004 ** k);
    const spec = normalizeCycleSpec({ ...defaultCycleSpec(), buy: { period: "W", days: 5, unit: "pct", value: 30 }, limit: { maxInvest: 50, rebalance: "M" } });
    const sells = run(spec, { A: series(rise) }).trades.filter((t) => t.side === "SELL");
    expect(sells.length).toBeGreaterThan(0);
    for (const t of sells) expect(t.note).toMatch(/^리밸런싱 \(주식 비중/);
  });
  it("이유를 남기지 않는 전략은 예전처럼 note 가 없다", () => {
    const d = syntheticData(5, "2021-01-01", "2022-12-30");
    const res = runBacktest({ data: d.data, settings: { rebalance: "M", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 21 },
      strategy: (c) => c.equal(c.topBy((t) => c.ret(t, 20), 2)) });
    expect(res.trades.every((t) => t.note === undefined)).toBe(true);
  });
});
