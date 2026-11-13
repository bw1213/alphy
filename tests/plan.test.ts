import { describe, expect, it } from "vitest";
import { buildPlan } from "@/lib/trade/plan";
import { runBacktest } from "@/lib/engine/engine";
import { businessDays, syntheticSeries } from "@/lib/data/synthetic";
import type { RunSettings } from "@/lib/engine/types";

const base: RunSettings = { rebalance: "M", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 0 };

describe("추천 종목(마지막 날 신호)", () => {
  const dates = businessDays("2023-01-01", "2023-06-15"); // 월말이 아닌 날에 끝남
  const A = syntheticSeries(dates, 1), B = syntheticSeries(dates, 2);

  it("리밸런싱 날이 아니어도 마지막 날 기준 목표 비중을 돌려준다", () => {
    const seen: string[] = [];
    const res = runBacktest({ data: { A, B }, settings: base, strategy: (c) => { seen.push(c.date); return { A: 0.6, B: 0.4, ZZZ: 0.5 }; } });
    expect(seen.at(-1)).toBe(dates.at(-1));
    expect(res.signal!.date).toBe(dates.at(-1));
    expect(res.signal!.kept).toBe(false);
    // 유니버스 밖 종목은 빠지고, 가중치 큰 순
    expect(res.signal!.picks.map((p) => [p.ticker, p.weight])).toEqual([["A", 0.6], ["B", 0.4]]);
    expect(res.signal!.picks[0].close).toBe(A.at(-1)!.close);
    // 마지막 날 신호는 체결되지 않는다
    expect(res.trades.every((t) => t.date <= dates.at(-1)!)).toBe(true);
  });
  it("{} 는 전량 현금, null 은 백테스트 보유 유지", () => {
    expect(runBacktest({ data: { A }, settings: base, strategy: () => ({}) }).signal!.picks).toEqual([]);
    const res = runBacktest({ data: { A }, settings: { ...base, rebalance: "D" }, strategy: (c) => (c.held().length ? null : { A: 1 }) });
    expect(res.signal!.kept).toBe(true);
    expect(res.signal!.picks[0].ticker).toBe("A");
    expect(res.signal!.picks[0].weight).toBeGreaterThan(0.9);
  });
  it("워밍업이 안 끝났으면 신호 없음", () => {
    expect(runBacktest({ data: { A }, settings: { ...base, warmup: 9999 }, strategy: () => ({ A: 1 }) }).signal).toBeNull();
  });
});

describe("주문 목록", () => {
  const picks = [{ ticker: "005930", name: "삼성전자", weight: 0.5 }, { ticker: "000660", name: "SK하이닉스", weight: 0.5 }];
  it("목표 수량과 보유의 차이만큼, 매도 먼저", () => {
    const p = buildPlan({
      picks, prices: { "005930": 70_000, "000660": 200_000 }, budget: 10_000_000, sellOthers: true,
      holdings: [{ code: "005930", qty: 100, price: 70_000 }, { code: "035420", name: "NAVER", qty: 10, price: 180_000 }],
    });
    expect(p.orders.map((o) => [o.code, o.side, o.qty])).toEqual([
      ["005930", "sell", 29],   // 목표 71주(5,000,000/70,000) ← 100주
      ["035420", "sell", 10],   // 추천 외 전량
      ["000660", "buy", 25],
    ]);
    expect(p.orders[1].other).toBe(true);
    expect(p.buyAmount).toBe(5_000_000);
    expect(p.sellAmount).toBe(29 * 70_000 + 10 * 180_000);
  });
  it("추천 외 종목을 남기는 옵션, 이미 맞으면 주문 없음, 가격 없으면 건너뜀", () => {
    const holdings = [{ code: "005930", qty: 71, price: 70_000 }, { code: "035420", qty: 10, price: 180_000 }];
    const p = buildPlan({ picks, prices: { "005930": 70_000 }, budget: 10_000_000, sellOthers: false, holdings });
    expect(p.orders).toEqual([]);
    expect(p.skipped).toEqual(["000660"]);
  });
  it("전량 현금 신호면 보유 종목 모두 매도", () => {
    const p = buildPlan({ picks: [], prices: {}, budget: 1e7, sellOthers: true, holdings: [{ code: "005930", qty: 3, price: 70_000 }] });
    expect(p.orders.map((o) => [o.side, o.qty])).toEqual([["sell", 3]]);
  });
});
