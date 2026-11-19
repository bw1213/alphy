import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { DataRequest, DataResponse } from "@/lib/data/server";
import type { Bar } from "@/lib/engine/types";
import { formatReport, padTrailing, runEvening, type EveningReport } from "@/lib/auto/evening";
import { morningStart, unfinishedItems, type Broker, type MorningDay } from "@/lib/auto/morning";
import { intradayStart } from "@/lib/auto/intraday";
import { cleanPlan, type AutoPlan } from "@/lib/auto/store";
import { isMixed, planMarkets, reportMarkets } from "@/lib/auto/session";
import { mixDue } from "@/lib/auto/scheduler";
import type { SavedStrategy } from "@/lib/strategies/library";
import type { DayOrder } from "@/lib/kis/orders";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-mix-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const kstAt = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);
const nyAt = (date: string, hm: string) => Date.parse(`${date}T${hm}:00-05:00`);

function bars(end: string, n: number, px: number): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse(end);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift({ date: d.toISOString().slice(0, 10), open: px, high: px, low: px, close: px, volume: 1000 });
    t -= 864e5;
  }
  return out;
}

const half: SavedStrategy = { name: "반반", code: "return { '069500': 0.5, SPY: 0.5 }", params: "{}", rebalance: "D", stopLoss: "", takeProfit: "", warmup: 1 };
const mixPlan = (over: Partial<AutoPlan> = {}): AutoPlan => ({ strategy: half, label: "반반", tickers: ["069500", "SPY"], budget: 10_000_000, startDate: "2026-11-16", enabled: true, updatedAt: "", ...over });

describe("섞은 운용 구분", () => {
  it("종목 시장으로 운용 시장을 정함, 섞어도 저장됨", () => {
    expect(planMarkets({ tickers: ["SPY", "069500"] })).toEqual(["KR", "US"]);
    expect(planMarkets({ tickers: [] })).toEqual(["KR"]);
    expect(isMixed({ tickers: ["SPY", "AAPL"] })).toBe(false);
    expect(isMixed({ tickers: ["SPY", "069500"] })).toBe(true);
    expect(reportMarkets({ market: "US" })).toEqual(["US"]);
    expect(reportMarkets({ markets: ["KR", "US"] })).toEqual(["KR", "US"]);
    expect(cleanPlan({ strategy: "saved:반반", tickers: "SPY, 069500", budget: 1_000_000 }, "owner", "2026-11-17", [half]).tickers).toEqual(["SPY", "069500"]);
  });

  it("섞은 운용 계산은 한국 아침 07:00~22:00, 일요일 빼고, 실패하면 10분 뒤 3번까지", () => {
    expect(mixDue(kstAt("2026-11-17", "06:59"), {})).toBe(false);
    expect(mixDue(kstAt("2026-11-17", "07:00"), {})).toBe(true);
    expect(mixDue(kstAt("2026-11-17", "22:00"), {})).toBe(false);
    expect(mixDue(kstAt("2026-11-15", "08:00"), {})).toBe(false);
    expect(mixDue(kstAt("2026-11-21", "08:00"), {})).toBe(true);
    const done = { mix: { date: "2026-11-17", attempts: 1, lastTry: kstAt("2026-11-17", "07:00"), done: true } };
    expect(mixDue(kstAt("2026-11-17", "09:00"), done)).toBe(false);
    const failed = { mix: { ...done.mix, done: false } };
    expect(mixDue(kstAt("2026-11-17", "07:05"), failed)).toBe(false);
    expect(mixDue(kstAt("2026-11-17", "07:10"), failed)).toBe(true);
  });
});

describe("섞은 운용 계산", () => {
  const load = (data: Record<string, Bar[]>, seen?: DataRequest[]) => async (q: DataRequest): Promise<DataResponse> => {
    seen?.push(q);
    return { data, names: { "069500": "KODEX 200", SPY: "SPDR S&P 500" }, benchmark: null, warnings: [], fx: [{ date: "2026-11-16", close: 1400 }] };
  };

  it("어제까지 두 시장 종가로 계산하고 주문을 시장별로 나눠 알림", async () => {
    const seen: DataRequest[] = [];
    const data = { "069500": bars("2026-11-16", 300, 40_000), SPY: bars("2026-11-16", 300, 700_000) };
    const r = await runEvening(mixPlan(), "schedule", { load: load(data, seen), now: kstAt("2026-11-17", "07:00"), env });
    expect(seen[0].end).toBe("2026-11-16");
    expect(r).toMatchObject({ status: "ok", markets: ["KR", "US"], fx: 1400, dataDate: "2026-11-16" });
    expect(r.orders.map((o) => `${o.side} ${o.ticker}`).sort()).toEqual(["buy 069500", "buy SPY"]);
    const text = formatReport(r);
    expect(text).toContain("한국 장 시작(09:00) 주문 1건");
    expect(text).toContain("미국 장 시작(뉴욕 09:32) 주문 1건");
    expect(text).not.toContain("저녁 계산");
  });

  it("한쪽 시장이 쉬었으면 직전 종가로 채워 계산, 새 시세가 없으면 건너뜀", async () => {
    const data = { "069500": bars("2026-11-16", 300, 40_000), SPY: bars("2026-11-13", 300, 700_000) };
    const r = await runEvening(mixPlan(), "schedule", { load: load(data), now: kstAt("2026-11-17", "07:00"), env });
    expect(r.status).toBe("ok");
    expect(r.orders.some((o) => o.ticker === "SPY")).toBe(true);
    expect(r.warnings.join(" ")).toContain("미국 시장이 2026-11-16에 쉬어");
    const again = await runEvening(mixPlan(), "schedule", { load: load(data), now: kstAt("2026-11-18", "07:00"), env, prevDataDate: "2026-11-16" });
    expect(again.status).toBe("holiday");
  });

  it("padTrailing: 끝이 모자란 종목만 거래량 0 으로 채우고 원본은 그대로", () => {
    const data = { A: bars("2026-11-16", 3, 10), B: bars("2026-11-13", 3, 20), C: bars("2026-10-01", 3, 30) };
    const out = padTrailing(data);
    expect(out.B.at(-1)).toMatchObject({ date: "2026-11-16", close: 20, volume: 0 });
    expect(data.B.at(-1)!.date).toBe("2026-11-13");
    expect(out.A).toBe(data.A);
    expect(out.C).toBe(data.C);
  });

  it("지난번에 못 한 주문은 목표 보유와의 차이로 다시, 목표에 닿을 때까지", async () => {
    const data = { "069500": bars("2026-11-16", 300, 40_000), SPY: bars("2026-11-16", 300, 700_000) };
    const plan = mixPlan({ startDate: "2026-10-27", strategy: { ...half, rebalance: "M" } });
    const holdings = async () => ({ env: "mock" as const, holdings: [{ code: "SPY", name: "SPY", qty: 7, avgPrice: 0, price: 0, value: 0, pnl: 0, pnlRate: 0 }] });
    const r = await runEvening(plan, "schedule", { load: load(data), now: kstAt("2026-11-17", "07:00"), env, holdings,
      unfinished: [{ ticker: "069500", side: "buy", qty: 500, retry: 0 }, { ticker: "SPY", side: "buy", qty: 3, retry: 0 }] });
    const kr = r.orders.find((o) => o.ticker === "069500")!;
    expect(kr).toMatchObject({ side: "buy", retry: 1 });
    expect(kr.qty).toBe(124);
    expect(kr.note).toContain("지난번에 못 한 주문 다시");
    expect(r.orders.find((o) => o.ticker === "SPY")).toBeUndefined();
    const again = await runEvening(plan, "schedule", { load: load(data), now: kstAt("2026-11-17", "07:00"), env, holdings,
      unfinished: [{ ticker: "069500", side: "buy", qty: 50, retry: 5 }] });
    expect(again.orders.find((o) => o.ticker === "069500")).toMatchObject({ side: "buy", qty: 124, retry: 6 });
  });
});

function fake(cash: number, held: Record<string, number> = {}) {
  const orders: DayOrder[] = [];
  const calls: string[] = [];
  let n = 0;
  const b: Broker & { calls: string[] } = {
    env: "mock", calls,
    balance: async () => ({ env: "mock", holdings: Object.entries(held).map(([code, qty]) => ({ code, name: code, qty, avgPrice: 0, price: 0, value: 0, pnl: 0, pnlRate: 0 })), cash, stockValue: 0, totalValue: 0, pnl: 0 }),
    buyable: async () => cash,
    place: async (o) => {
      calls.push(`${o.side} ${o.code} ${o.qty}`);
      const no = String(++n).padStart(10, "0");
      orders.push({ orderNo: no, orgNo: "1", code: o.code, name: o.code, side: o.side, qty: o.qty, filledQty: 0, openQty: o.qty, avgPrice: 0, price: 0, time: "", cancelled: false });
      return { env: "mock", orderNo: no, orderTime: "", message: "ok", orgNo: "1" };
    },
    orders: async () => orders.map((o) => ({ ...o })),
    cancel: async () => "",
    openDay: async () => null,
    quote: async () => 500,
  };
  return b;
}

describe("섞은 운용 주문", () => {
  const report = (over: Partial<EveningReport> = {}): EveningReport => ({
    runDate: "2026-11-17", ranAt: "2026-11-16T22:00:00Z", trigger: "schedule", status: "ok", label: "반반", markets: ["KR", "US"], dataDate: "2026-11-16", fx: 1400, intraday: true, warnings: [],
    orders: [
      { ticker: "069500", name: "KODEX 200", side: "buy", qty: 10, price: 40_000, amount: 400_000, curQty: 0, targetQty: 10 },
      { ticker: "SPY", name: "SPDR", side: "buy", qty: 2, price: 700_000, amount: 1_400_000, curQty: 0, targetQty: 2 },
    ],
    sellLevels: [
      { ticker: "069500", name: "KODEX 200", price: 36_000, close: 40_000, gap: -10, kind: "stop_loss", label: "손절" },
      { ticker: "SPY", name: "SPDR", price: 630_000, close: 700_000, gap: -10, kind: "stop_loss", label: "손절", usd: 450 },
    ],
    ...over,
  });

  it("같은 날 아침 계산을 한국 장은 한국 종목만, 미국 장은 미국 종목만 주문", async () => {
    const kr = fake(1e9);
    const d = await morningStart(mixPlan(), [report()], kr, kstAt("2026-11-17", "08:40"), {}, "KR");
    expect(kr.calls).toEqual(["buy 069500 10"]);
    expect(d.reportData).toBe("2026-11-16");
    const us = fake(1e9);
    const u = await morningStart(mixPlan(), [report()], us, nyAt("2026-11-17", "09:32"), {}, "US");
    expect(us.calls).toEqual(["buy SPY 2"]);
    expect(u.market).toBe("US");
  });

  it("장중 감시도 그 시장 종목 가격만", async () => {
    const kr = await intradayStart(mixPlan(), [report()], fake(0), kstAt("2026-11-17", "09:00"), "KR");
    expect(kr.levels.map((l) => l.ticker)).toEqual(["069500"]);
    const us = await intradayStart(mixPlan(), [report()], fake(0), nyAt("2026-11-17", "09:35"), "US");
    expect(us.levels.map((l) => l.ticker)).toEqual(["SPY"]);
  });

  it("이미 주문한 계산(같은 시세 날짜)으로는 다시 주문하지 않음", async () => {
    const prev: MorningDay = { date: "2026-11-17", reportDate: "2026-11-17", reportData: "2026-11-16", label: "반반", phase: "done", log: [],
      items: [{ ticker: "069500", name: "K", side: "buy", planned: 10, qty: 10, status: "filled", orderNo: "1", filledQty: 10, avgPrice: 40_000, price: 40_000 }] };
    const kr = fake(1e9);
    const d = await morningStart(mixPlan(), [report({ ranAt: "2026-11-17T05:00:00Z", trigger: "manual" })], kr, kstAt("2026-11-18", "08:40"), {}, "KR", [prev]);
    expect(d.phase).toBe("skipped");
    expect(d.reason).toContain("이미 주문했습니다");
    expect(kr.calls).toEqual([]);
    const us = fake(1e9);
    await morningStart(mixPlan(), [report()], us, nyAt("2026-11-18", "09:32"), {}, "US", [prev]);
    expect(us.calls).toEqual(["buy SPY 2"]);
  });

  it("끝나지 않은 주문 찾기: 시장별 마지막 기록에서, 긴급 정지·팔 주식 없음은 빼고", () => {
    const item = (over: Partial<MorningDay["items"][number]>) => ({ ticker: "069500", name: "K", side: "buy" as const, planned: 10, qty: 10, status: "skipped" as const, filledQty: 0, avgPrice: 0, price: 1, ...over });
    const day = (date: string, items: MorningDay["items"], over: Partial<MorningDay> = {}): MorningDay => ({ date, label: "반반", phase: "done", log: [], items, ...over });
    const days = [
      day("2026-11-16", [item({ ticker: "A" })]),
      day("2026-11-17", [item({}), item({ ticker: "B", status: "partial", filledQty: 4, retry: 1 }), item({ ticker: "C", status: "filled", filledQty: 10 }), item({ ticker: "D", side: "sell", error: "계좌에 팔 주식이 없습니다." })]),
      day("2026-11-17", [item({ ticker: "SPY" })], { market: "US" }),
    ];
    expect(unfinishedItems(days, "반반", "KR", "2026-11-17")).toEqual([
      { ticker: "069500", side: "buy", qty: 10, retry: 0 },
      { ticker: "B", side: "buy", qty: 6, retry: 1 },
    ]);
    expect(unfinishedItems(days, "반반", "US", "2026-11-17")).toEqual([{ ticker: "SPY", side: "buy", qty: 10, retry: 0 }]);
    expect(unfinishedItems(days, "다른 전략", "KR", "2026-11-17")).toEqual([]);
    expect(unfinishedItems([day("2026-11-17", [item({})], { phase: "stopped" })], "반반", "KR", "2026-11-17")).toEqual([]);
    expect(unfinishedItems(days, "반반", "KR", "2026-11-30")).toEqual([]);
  });
});
