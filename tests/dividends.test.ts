import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runBuyAndHold } from "@/lib/engine/buyhold";
import { dividendIndex, dividendTaxFn } from "@/lib/engine/dividends";
import { runBacktest } from "@/lib/engine/engine";
import { summarize } from "@/lib/engine/metrics";
import type { Bar, PriceData } from "@/lib/engine/types";
import { dividendGaps, parseDividendCsv, parseYahooDividends, yahooSymbols } from "@/lib/data/dividends";
import { cachedDividends } from "@/lib/data/server";

const days = (start: string, n: number) => {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  while (out.length < n) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
};
const flat = (dates: string[], px = 1000): Bar[] => dates.map((date) => ({ date, open: px, high: px, low: px, close: px, volume: 1000 }));
const free = { commission: 0, slippage: 0, sellTax: 0 };
const settings = { rebalance: "D" as const, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 1 };

describe("배당 데이터 파싱", () => {
  it("Yahoo chart 응답에서 거래소 현지 날짜·1주당 금액을 읽는다", () => {
    // 2025-06-27 09:00 KST = 00:00 UTC
    const ts = Date.UTC(2025, 5, 27) / 1000;
    const json = { chart: { result: [{ meta: { gmtoffset: 32400 }, events: { dividends: { [ts]: { amount: 367, date: ts }, 1: { amount: 0, date: 1 } } } }] } };
    expect(parseYahooDividends(json)).toEqual([{ date: "2025-06-27", amount: 367 }]);
    expect(parseYahooDividends({ chart: { result: [{ meta: {} }] } })).toEqual([]);
    expect(parseYahooDividends({ chart: { result: null, error: { code: "Not Found" } } })).toBeNull();
  });

  it("미국 장(UTC-5) 시간도 현지 날짜로", () => {
    const ts = Date.UTC(2026, 10, 12, 14, 30) / 1000; // 09:30 ET
    const json = { chart: { result: [{ meta: { gmtoffset: -18000 }, events: { dividends: { a: { amount: 0.27, date: ts } } } }] } };
    expect(parseYahooDividends(json)![0].date).toBe("2026-11-12");
  });

  it("심볼: 한국 6자리는 .KS 다음 .KQ, 미국은 점을 하이픈으로", () => {
    expect(yahooSymbols("069500")).toEqual(["069500.KS", "069500.KQ"]);
    expect(yahooSymbols("0091C0")).toEqual(["0091C0.KS", "0091C0.KQ"]);
    expect(yahooSymbols("AAPL")).toEqual(["AAPL"]);
    expect(yahooSymbols("BRK.B")).toEqual(["BRK-B"]);
  });

  it("CSV: date,code,amount", () => {
    const d = parseDividendCsv("date,code,amount\n2024-04-29,069500,400\n2023-04-27,069500,350\nbad\n");
    expect(d["069500"]).toEqual([{ date: "2023-04-27", amount: 350 }, { date: "2024-04-29", amount: 400 }]);
  });

  it("평소보다 오래 비어 있는 구간을 찾는다 (월배당인데 2년 빔)", () => {
    const m = ["2023-07-28", "2023-08-30", "2023-09-26", "2023-10-30", "2023-11-29", "2023-12-27", "2026-10-29"];
    const divs = m.map((date) => ({ date, amount: 30 }));
    expect(dividendGaps(divs, "2020-01-01", "2026-12-31")).toEqual([{ from: "2023-12-27", to: "2026-10-29" }]);
    expect(dividendGaps(divs, "2027-01-01", "2027-12-31")).toEqual([]);
  });

  it("배당락일이 휴장일이면 다음 거래일로, 데이터 시작 전 배당은 버린다", () => {
    const dates = ["2024-04-26", "2024-04-29", "2024-04-30"];
    const m = dividendIndex(dates, [{ date: "2024-01-01", amount: 1 }, { date: "2024-04-28", amount: 400 }, { date: "2024-05-30", amount: 9 }]);
    expect([...m.entries()]).toEqual([[1, 400]]);
  });

  it("세율: 한국 코드는 지정 세율, 미국 티커는 15%", () => {
    const f = dividendTaxFn(0.154);
    expect(f("069500")).toBe(0.154);
    expect(f("AAPL")).toBe(0.15);
  });
});

describe("엔진 배당 반영", () => {
  const dates = days("2024-01-01", 30);
  const data: PriceData = { A: flat(dates) };
  const exDate = dates[10];
  const dividends = { A: [{ date: exDate, amount: 50 }] };
  const hold = () => ({ A: 1 });

  it("들고 있으면 세후 금액이 현금으로 들어오고 수익률에 반영된다 (입금이 아님)", () => {
    const r = runBacktest({ data, strategy: hold, settings, costs: free, initialCash: 100_000, dividends, dividendTax: 0.154 });
    expect(r.dividends).toHaveLength(1);
    const p = r.dividends![0];
    expect(p).toMatchObject({ date: exDate, ticker: "A", qty: 100, perShare: 50, gross: 5000 });
    expect(p.tax).toBeCloseTo(770, 6);
    expect(p.net).toBeCloseTo(4230, 6);
    const s = summarize(r);
    expect(s.dividendsNet).toBeCloseTo(4230, 6);
    expect(s.deposits).toBe(0);
    expect(s.totalReturn).toBeCloseTo(0.0423, 6);
    // 배당락 전날까지는 그대로
    expect(r.equity[9].equity).toBeCloseTo(100_000, 6);
  });

  it("배당락일 시가에 사면 못 받고, 배당락일 시가에 팔아도 받는다", () => {
    // 신호는 전날 종가 → 다음 날 시가 체결: dates[9] 신호 → dates[10](배당락일) 시가 체결
    const buyOnEx = (ctx: any): Record<string, number> => (ctx.date >= dates[9] ? { A: 1 } : {});
    const r1 = runBacktest({ data, strategy: buyOnEx, settings, costs: free, initialCash: 100_000, dividends });
    expect(r1.trades[0].date).toBe(exDate);
    expect(r1.dividends).toEqual([]);

    const sellOnEx = (ctx: any): Record<string, number> => (ctx.date >= dates[9] ? {} : { A: 1 });
    const r2 = runBacktest({ data, strategy: sellOnEx, settings, costs: free, initialCash: 100_000, dividends });
    expect(r2.trades.at(-1)).toMatchObject({ date: exDate, side: "SELL" });
    expect(r2.dividends).toHaveLength(1);
  });

  it("배당 데이터를 안 주면 예전과 같다", () => {
    const r = runBacktest({ data, strategy: hold, settings, costs: free, initialCash: 100_000 });
    expect(r.dividends).toBeUndefined();
    expect(summarize(r).hasDividendData).toBe(false);
  });

  it("매수 후 보유는 받은 배당으로 같은 종목을 다시 산다", () => {
    const r = runBuyAndHold({ data, initialCash: 100_000, tickers: ["A"], costs: free, dividends, dividendTax: 0 })!;
    expect(r.dividends).toHaveLength(1);
    const re = r.trades.filter((t) => t.date > exDate);
    expect(re).toHaveLength(1);
    expect(re[0]).toMatchObject({ date: dates[11], qty: 5 }); // 5000원 / 1000원
    expect(r.finalPositions[0].qty).toBe(105);
    // 입금이 아니라 수익: 넣은 돈은 그대로, 수익률에 반영
    const s = summarize(r);
    expect(s.deposits).toBe(0);
    expect(r.equity.at(-1)!.contributed).toBe(100_000);
    expect(s.totalReturn).toBeCloseTo(0.05, 6);
  });

  it("매수 후 보유: 배당은 추가 입금처럼 보유 종목에 똑같이 나눠 산다", () => {
    const two: PriceData = { A: flat(dates), B: flat(dates) };
    const r = runBuyAndHold({ data: two, initialCash: 200_000, tickers: ["A", "B"], costs: free, dividends, dividendTax: 0 })!;
    const re = r.trades.filter((t) => t.date > exDate);
    expect(re.map((t) => [t.ticker, t.qty])).toEqual([["A", 2], ["B", 2]]); // A 100주 배당 5,000원 → 2,500원씩, 1주 1,000원
    expect(r.equity.at(-1)!.contributed).toBe(200_000);
  });

  it("전략: 배당 현금은 입금과 같이 다음 매매에 쓰이지만 넣은 돈에는 안 더함", () => {
    const r = runBacktest({ data, strategy: hold, settings: { ...settings, rebalanceBand: 0 }, costs: free, initialCash: 100_000, dividends, dividendTax: 0 });
    const after = r.trades.filter((t) => t.date > exDate && t.side === "BUY");
    expect(after.reduce((a, t) => a + t.qty, 0)).toBe(5);
    expect(r.equity.at(-1)!.contributed).toBe(100_000);
    expect(summarize(r).deposits).toBe(0);
  });
});

describe("배당 이력 캐시", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "div-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("오늘 받은 건 다시 안 받고, 실패하면 예전 캐시를 쓴다", async () => {
    let calls = 0;
    const ok = async () => { calls++; return [{ date: "2024-04-29", amount: 400 }]; };
    expect(await cachedDividends("069500", ok, dir)).toHaveLength(1);
    expect(await cachedDividends("069500", ok, dir)).toHaveLength(1);
    expect(calls).toBe(1);
    const fail = async (): Promise<never> => { throw new Error("HTTP 429"); };
    await expect(cachedDividends("005930", fail, dir)).rejects.toThrow("429");
  });
});

describe("loadData 배당 붙이기", () => {
  const cwd = process.cwd();
  afterEach(() => { process.chdir(cwd); vi.unstubAllGlobals(); vi.resetModules(); });

  it("네이버 시세 + Yahoo 배당, 기간 밖 배당은 자르고 .KS 없으면 .KQ", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "alphy-div-"));
    process.chdir(dir);
    const ds = days("2024-01-01", 200);
    const xml = ds.map((d) => `<item data="${d.replace(/-/g, "")}|100|100|100|100|10" />`).join("");
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("yahoo.com")) {
        const sym = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
        seen.push(sym);
        if (sym === "222220.KS") return new Response(JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } }), { status: 404 });
        const ts = (d: string) => Date.parse(d + "T00:00:00Z") / 1000;
        const ev = { a: { amount: 5, date: ts("2023-04-27") }, b: { amount: 7, date: ts("2024-04-29") } };
        return new Response(JSON.stringify({ chart: { result: [{ meta: { gmtoffset: 32400 }, events: { dividends: ev } }] } }));
      }
      return new Response(xml);
    }));
    try {
      vi.resetModules(); // 캐시 폴더를 임시 폴더로 (위에서 이미 불러온 모듈은 저장소의 .cache 를 씀)
      const { loadData } = await import("@/lib/data/server");
      const r = await loadData({ source: "naver", start: "2024-01-01", end: "2024-12-31", tickers: ["111110", "222220"] });
      expect(r.dividends).toEqual({ "111110": [{ date: "2024-04-29", amount: 7 }], "222220": [{ date: "2024-04-29", amount: 7 }] });
      expect(seen).toContain("222220.KQ");
      expect(r.warnings.join(" ")).toMatch(/2종목의 배당 이력/);
      const off = await loadData({ source: "naver", start: "2024-01-01", end: "2024-12-31", tickers: ["111110"], dividends: false });
      expect(off.dividends).toBeUndefined();
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
