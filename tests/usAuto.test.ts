import { describe, expect, it } from "vitest";
import { nyClock, planMarket, US_SESSION } from "@/lib/auto/session";
import { parseUsBalance, parseUsOrders, usdTick, usOrderBody, usOrderTrId } from "@/lib/kis/overseas";
import { morningFollow, morningStart, pickReport, formatDay, type Broker } from "@/lib/auto/morning";
import { intradayCheck, intradayStart } from "@/lib/auto/intraday";
import { cleanPlan, type AutoPlan } from "@/lib/auto/store";
import type { EveningReport, SellLevel } from "@/lib/auto/evening";
import type { DayOrder } from "@/lib/kis/orders";
import { defaultCycleSpec } from "@/lib/strategies/cycle";

describe("미국 시장 시계", () => {
  it("뉴욕 시간: 겨울은 한국보다 14시간, 서머타임은 13시간 늦음", () => {
    // 2026-11-17 23:32 한국 = 09:32 뉴욕 (겨울)
    expect(nyClock(Date.parse("2026-11-17T23:32:00+09:00"))).toEqual({ date: "2026-11-17", hm: "09:32", dow: 2 });
    // 2026-07-01 22:32 한국 = 09:32 뉴욕 (서머타임)
    expect(nyClock(Date.parse("2026-07-01T22:32:00+09:00"))).toEqual({ date: "2026-07-01", hm: "09:32", dow: 3 });
    // 한국 토요일 새벽 = 뉴욕 금요일 오후
    expect(nyClock(Date.parse("2026-11-21T05:00:00+09:00"))).toMatchObject({ date: "2026-11-20", hm: "15:00", dow: 5 });
  });
  it("대상 종목이 모두 미국이면 미국 운용, 섞으면 저장 못 함", () => {
    expect(planMarket({ tickers: ["AAPL", "BRK.B"] })).toBe("US");
    expect(planMarket({ tickers: ["069500"] })).toBe("KR");
    expect(planMarket({ tickers: [] })).toBe("KR");
    const lib = [{ name: "적립", code: "return lib.cycle(ctx, p)", params: "{}", rebalance: "D" as const, stopLoss: "", takeProfit: "", warmup: 1, cycle: defaultCycleSpec() }];
    expect(() => cleanPlan({ strategy: "saved:적립", tickers: "AAPL, 069500", budget: 1_000_000 }, "owner", "2026-11-17", lib)).toThrow(/섞을 수 없습니다/);
    expect(cleanPlan({ strategy: "saved:적립", tickers: "AAPL, SPY", budget: 1_000_000 }, "owner", "2026-11-17", lib).tickers).toEqual(["AAPL", "SPY"]);
  });
});

describe("해외 주문 API 형식", () => {
  it("거래ID, 주문 본문, 호가 단위", () => {
    expect([usOrderTrId("real", "buy"), usOrderTrId("real", "sell"), usOrderTrId("mock", "buy"), usOrderTrId("mock", "sell")]).toEqual(["TTTT1002U", "TTTT1006U", "VTTT1002U", "VTTT1001U"]);
    const body = usOrderBody({ CANO: "12345678", ACNT_PRDT_CD: "01" }, { ticker: "BRK.B", exchange: "NYSE", side: "sell", qty: 3, price: 412.3456 });
    expect(body).toMatchObject({ OVRS_EXCG_CD: "NYSE", PDNO: "BRK/B", ORD_QTY: "3", OVRS_ORD_UNPR: "412.35", ORD_DVSN: "00", SLL_TYPE: "00" });
    expect(usOrderBody({ CANO: "1", ACNT_PRDT_CD: "01" }, { ticker: "AAPL", exchange: "NASD", side: "buy", qty: 1, price: 200 }).SLL_TYPE).toBe("");
    expect(usdTick(0.123456)).toBe(0.1235);
  });
  it("잔고·체결 내역 읽기", () => {
    const b = parseUsBalance("mock", [{ ovrs_pdno: "BRK/B", ovrs_item_name: "버크셔", ovrs_cblc_qty: "5", ord_psbl_qty: "3", pchs_avg_pric: "400.5", now_pric2: "410", ovrs_stck_evlu_amt: "2050", frcr_evlu_pfls_amt: "47.5", evlu_pfls_rt: "2.37" }, { ovrs_pdno: "X", ovrs_cblc_qty: "0" }]);
    expect(b.holdings).toHaveLength(1);
    expect(b.holdings[0]).toMatchObject({ code: "BRK.B", qty: 5, sellable: 3, avgPrice: 400.5 });
    const o = parseUsOrders([{ odno: "0030138295", pdno: "AAPL", sll_buy_dvsn_cd: "02", ft_ord_qty: "10", ft_ccld_qty: "4", nccs_qty: "6", ft_ccld_unpr3: "201.25", ft_ord_unpr3: "202" }]);
    expect(o[0]).toMatchObject({ orderNo: "0030138295", code: "AAPL", side: "buy", qty: 10, filledQty: 4, openQty: 6, avgPrice: 201.25, cancelled: false });
  });
});

// ---------------- 자동 주문 ----------------
const plan: AutoPlan = { builtin: "x", label: "미국 적립", tickers: ["AAPL"], budget: 3_000_000, startDate: "2026-11-01", enabled: true, updatedAt: "2026-11-10T00:00:00Z" };
const ny = (date: string, hm: string) => Date.parse(`${date}T${hm}:00-05:00`);
const D = "2026-11-17";
const report = (over: Partial<EveningReport> = {}): EveningReport => ({
  runDate: D, ranAt: "2026-11-17T09:00:00Z", trigger: "schedule", status: "ok", label: "미국 적립", market: "US", fx: 1400, intraday: true, warnings: [],
  orders: [{ ticker: "AAPL", name: "애플", side: "buy", qty: 2, price: 280_000, amount: 560_000, curQty: 0, targetQty: 2 }], sellLevels: [], ...over,
});
function fake(prices: Record<string, number>, held: Record<string, number> = {}) {
  const orders: DayOrder[] = [];
  const calls: string[] = [];
  let n = 0;
  const b: Broker & { calls: string[]; prices: Record<string, number>; fill: (px: number) => void } = {
    env: "mock", calls, prices,
    balance: async () => ({ env: "mock", holdings: Object.entries(held).map(([code, qty]) => ({ code, name: code, qty, avgPrice: 0, price: 0, value: 0, pnl: 0, pnlRate: 0 })), cash: 0, stockValue: 0, totalValue: 0, pnl: 0 }),
    buyable: async () => 1e9,
    place: async (o) => {
      calls.push(`${o.side} ${o.code} ${o.qty}`);
      const no = String(++n);
      orders.push({ orderNo: no, orgNo: "", code: o.code, name: o.code, side: o.side, qty: o.qty, filledQty: 0, openQty: o.qty, avgPrice: 0, price: 0, time: "", cancelled: false });
      return { env: "mock", orderNo: no, orderTime: "", message: "ok" };
    },
    orders: async () => orders.map((o) => ({ ...o })),
    cancel: async (o) => { calls.push(`cancel ${o.orderNo}`); return ""; },
    openDay: async () => null,
    quote: async (c) => prices[c] ?? 0,
    fill: (px) => { for (const x of orders) { x.filledQty = x.qty; x.openQty = 0; x.avgPrice = px; } },
  };
  return b;
}

describe("미국 자동 주문", () => {
  it("한국 저녁에 계산한 주문을 같은 날짜(뉴욕)의 장 시작에 냄", async () => {
    // 한국 종목 운용은 오늘 계산을 오늘 쓰지 않지만 미국은 씀
    expect(pickReport([report()], plan, D).report).toBeNull();
    expect(pickReport([report()], plan, D, true).report?.runDate).toBe(D);
    const b = fake({ AAPL: 200 });
    let d = await morningStart(plan, [report()], b, ny(D, US_SESSION.orderAt), {}, "US");
    expect(d).toMatchObject({ date: D, market: "US", phase: "placed" });
    expect(b.calls).toEqual(["buy AAPL 2"]);
    expect(d.log[0]).toMatch(/^09:32 .*지정가/);
    b.fill(201.5);
    d = await morningFollow(d, b, ny(D, "09:36"), US_SESSION.cutoff);
    expect(d.phase).toBe("done");
    expect(formatDay(d, true)).toContain("체결 평균 $201.50");
  });
  it("저녁 계산이 한국 종목 것이면 미국 주문을 내지 않음", async () => {
    const d = await morningStart(plan, [report({ market: undefined })], fake({ AAPL: 200 }), ny(D, "09:32"), {}, "US");
    expect(d.phase).toBe("skipped");
    expect(d.reason).toMatch(/시장이 달라/);
  });
  it("장중 매도: 달러로 바꾼 가격과 달러 현재가를 비교", async () => {
    const lv: SellLevel = { ticker: "AAPL", name: "애플", price: 252_000, usd: 180, close: 280_000, gap: -10, kind: "drop", label: "하락 매도", qty: 1 };
    const b = fake({ AAPL: 190 }, { AAPL: 2 });
    let d = await intradayStart(plan, [report({ sellLevels: [lv] })], b, ny(D, "09:35"), "US");
    expect(d).toMatchObject({ market: "US", fx: 1400 });
    ({ day: d } = await intradayCheck(d, b, ny(D, "09:40")));
    expect(b.calls).toHaveLength(0);
    b.prices.AAPL = 179.5;
    const r = await intradayCheck(d, b, ny(D, "11:00"));
    expect(b.calls).toEqual(["sell AAPL 1"]);
    expect(r.messages[0]).toContain("$179.50");
    expect(r.messages[0]).toContain("$180.00");
    // 뉴욕 15:50 이후엔 새로 안 팖
    const late = fake({ AAPL: 100 }, { AAPL: 2 });
    const d2 = await intradayStart(plan, [report({ sellLevels: [lv] })], late, ny(D, "09:35"), "US");
    await intradayCheck(d2, late, ny(D, "15:55"));
    expect(late.calls).toHaveLength(0);
  });
  it("환율을 몰라 달러 가격이 없으면 감시하지 않음", async () => {
    const lv: SellLevel = { ticker: "AAPL", name: "애플", price: 252_000, close: 280_000, gap: -10, kind: "drop", label: "하락 매도", qty: 1 };
    const d = await intradayStart(plan, [report({ sellLevels: [lv] })], fake({ AAPL: 100 }), ny(D, "09:35"), "US");
    expect(d.done).toBe(true);
  });
});
