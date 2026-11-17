import { describe, expect, it } from "vitest";
import { deflateRawSync } from "zlib";
import { isKrTicker, isUsTicker, marketOf, normalizeTicker, parseTickers, yahooSymbol } from "@/lib/data/market";
import { fxAt, parseYahooChart, toKrw } from "@/lib/data/yahoo";
import { firstFileInZip, parseUsMaster } from "@/lib/data/usMaster";
import { buyFeeRate, sellFeeRate } from "@/lib/engine/costs";
import { runBacktest } from "@/lib/engine/engine";
import { runBuyAndHold } from "@/lib/engine/buyhold";
import { businessDays, syntheticSeries } from "@/lib/data/synthetic";
import type { RunSettings } from "@/lib/engine/types";

describe("종목 코드 시장 구분", () => {
  it("한국 6자리(첫 글자 숫자)와 미국 티커를 나눈다", () => {
    expect(marketOf("005930")).toBe("KR");
    expect(marketOf("0126Z0")).toBe("KR");
    expect(marketOf("AAPL")).toBe("US");
    expect(marketOf("BRK.B")).toBe("US");
    expect(isKrTicker("AAPL")).toBe(false);
    expect(isUsTicker("069500")).toBe(false);
    expect(marketOf("12AB!")).toBeNull();
  });
  it("입력 정리: 소문자·BRK/B·BRK-B → BRK.B, 잘못된 값·중복 제거", () => {
    expect(normalizeTicker(" aapl ")).toBe("AAPL");
    expect(normalizeTicker("BRK/B")).toBe("BRK.B");
    expect(normalizeTicker("brk-b")).toBe("BRK.B");
    expect(normalizeTicker("12345")).toBe("");
    expect(parseTickers("005930, aapl AAPL, spy,, 12ab!")).toEqual(["005930", "AAPL", "SPY"]);
    expect(yahooSymbol("BRK.B")).toBe("BRK-B");
  });
});

describe("야후 시세 · 원화 환산", () => {
  const json = {
    chart: { result: [{
      meta: { currency: "USD", gmtoffset: -18000, shortName: "Apple Inc.", exchangeName: "NMS", instrumentType: "EQUITY" },
      // 2025-01-02, 2025-01-03 09:30 뉴욕, 중간에 값 없는 날 하나
      timestamp: [1735828200, 1735914600, 1736173800],
      events: { dividends: { "1735914600": { amount: 0.25, date: 1735914600 } } },
      indicators: { quote: [{ open: [100, 101, null], high: [102, 103, null], low: [99, 100, null], close: [101.000001, 102, null], volume: [1000, 2000, null] }] },
    }], error: null },
  };
  it("뉴욕 날짜로 일봉, 빈 값은 건너뜀, 배당 이벤트도 읽음", () => {
    const c = parseYahooChart(json);
    expect(c.bars.map((b) => b.date)).toEqual(["2025-01-02", "2025-01-03"]);
    expect(c.bars[0].close).toBe(101);
    expect(c.dividends).toEqual([{ date: "2025-01-03", amount: 0.25 }]);
    expect(c.currency).toBe("USD");
  });
  it("없는 티커는 오류", () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { description: "No data found" } } })).toThrow("No data found");
  });
  it("그날 환율(없으면 직전 환율)로 원화로 바꾼다", () => {
    const fx = [{ date: "2025-01-02", close: 1400 }, { date: "2025-01-06", close: 1450 }];
    const bars = [
      { date: "2025-01-01", open: 1, high: 1, low: 1, close: 1, volume: 1 }, // 환율보다 앞 → 첫 환율
      { date: "2025-01-03", open: 10, high: 11, low: 9, close: 10, volume: 1 }, // 환율 없는 날 → 직전(1400)
      { date: "2025-01-06", open: 10, high: 10, low: 10, close: 2, volume: 1 },
    ];
    expect(toKrw(bars, fx).map((b) => b.close)).toEqual([1400, 14000, 2900]);
    expect(toKrw(bars, fx)[1].high).toBe(15400);
    expect(fxAt(fx, "2025-01-05")).toBe(1400);
    expect(fxAt(fx, "2025-02-01")).toBe(1450);
  });
});

describe("한국투자증권 미국 종목 마스터", () => {
  const text = [
    "US\t22\tNAS\t나스닥\tAAPL\tNASAAPL\t애플\tAPPLE INC\t2\tUSD",
    "US\t21\tNYS\t뉴욕\tBRK/B\tNYSBRK/B\t버크셔 해서웨이 B\tBERKSHIRE HATHAWAY INC\t2\tUSD",
    "US\t23\tAMS\t아멕스\tSPY\tAMSSPY\t\tSTATE STREET SPDR S&P 500 ETF\t3\tUSD",
    "US\t22\tNAS\t나스닥\tXYZW\tNASXYZW\t워런트\tSOME WARRANT\t4\tUSD",
  ].join("\r\n");
  it("한글 이름·종류를 읽고 주식·ETF 만 남긴다", () => {
    expect(parseUsMaster(text, "NASDAQ")).toEqual([
      { code: "AAPL", name: "애플", nameEn: "APPLE INC", market: "NASDAQ", type: "stock" },
      { code: "BRK.B", name: "버크셔 해서웨이 B", nameEn: "BERKSHIRE HATHAWAY INC", market: "NASDAQ", type: "stock" },
      { code: "SPY", name: "STATE STREET SPDR S&P 500 ETF", nameEn: "STATE STREET SPDR S&P 500 ETF", market: "NASDAQ", type: "etf" },
    ]);
  });
  it("zip 첫 파일을 꺼낸다 (deflate)", () => {
    const body = Buffer.from("hello 미국", "utf8");
    const comp = deflateRawSync(body);
    const name = Buffer.from("A.COD");
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    const cdOff = 30 + name.length + comp.length;
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(body.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
    const zip = Buffer.concat([local, name, comp, cd, name, eocd]);
    expect(firstFileInZip(zip).toString("utf8")).toBe("hello 미국");
  });
});

describe("미국 종목 비용", () => {
  const costs = { commission: 0.00015, slippage: 0, sellTax: 0.002, us: { commission: 0.0025, fx: 0.001 } };
  it("미국은 수수료+환전, 거래세 없음 / 한국은 그대로", () => {
    expect(buyFeeRate(costs, "AAPL")).toBeCloseTo(0.0035);
    expect(sellFeeRate(costs, "AAPL", 2026)).toBeCloseTo(0.0035);
    expect(buyFeeRate(costs, "005930")).toBeCloseTo(0.00015);
    expect(sellFeeRate(costs, "005930", 2026)).toBeCloseTo(0.00215);
  });
  it("us 설정이 없으면 모든 종목을 한국 규칙으로 (가짜 데이터 S00000 등)", () => {
    const { us, ...kr } = costs; void us;
    expect(buyFeeRate(kr, "AAPL")).toBeCloseTo(0.00015);
    expect(sellFeeRate(kr, "S00000", 2026)).toBeCloseTo(0.00215);
  });
  it("엔진·매수 후 보유가 종목별 비용을 쓴다", () => {
    const dates = businessDays("2024-01-01", "2024-06-30");
    const KR = syntheticSeries(dates, 3), US = KR.map((b) => ({ ...b }));
    const base: RunSettings = { rebalance: "D", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 0 };
    const buyOnce = (t: string) => runBacktest({ data: { [t]: t === "AAPL" ? US : KR }, settings: base, costs, initialCash: 1e8,
      strategy: (c) => (c.held().length ? null : { [t]: 1 }) });
    const fee = (t: string) => buyOnce(t).trades[0];
    expect(fee("AAPL").fee / (fee("AAPL").qty * fee("AAPL").price)).toBeCloseTo(0.0035);
    expect(fee("005930").fee / (fee("005930").qty * fee("005930").price)).toBeCloseTo(0.00015);
    const h = runBuyAndHold({ data: { AAPL: US }, costs, initialCash: 1e8, tickers: ["AAPL"] })!;
    expect(h.trades[0].fee / (h.trades[0].qty * h.trades[0].price)).toBeCloseTo(0.0035);
  });
});

describe("한국·미국 휴일이 다른 종목 섞기", () => {
  it("중간에 빠진 날은 직전 종가로 채우고 매매 안 함, 상장 전·폐지 후는 비움", async () => {
    const { buildPanel } = await import("@/lib/engine/context");
    const bar = (date: string, c: number) => ({ date, open: c, high: c, low: c, close: c, volume: 10 });
    const P = buildPanel({
      KR: [bar("2025-01-02", 100), bar("2025-01-03", 101), bar("2025-01-06", 102)],
      US: [bar("2025-01-03", 10), bar("2025-01-07", 12)], // 01-06 은 미국 휴일로 가정, 01-02 는 상장 전
    });
    const k = P.index.get("US")!;
    expect(P.dates).toEqual(["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"]);
    expect(Number.isNaN(P.close[k][0])).toBe(true); // 상장 전
    expect(P.close[k][2]).toBe(10); // 휴일 → 직전 종가
    expect(P.volume[k][2]).toBe(0); // 매매 안 됨
    const kr = P.index.get("KR")!;
    expect(Number.isNaN(P.close[kr][3])).toBe(true); // 마지막 시세 뒤는 비움 (상장폐지 판단용)
  });
});

describe("한국투자증권 해외 시세", () => {
  it("해외주식 기간별시세·환율 응답을 일봉으로 읽고, BRK.B 는 BRK/B 로 보낸다", async () => {
    const { parseOverseasDaily, parseOverseasChart, kisUsSymbol, kisUsDaily } = await import("@/lib/kis/market");
    expect(kisUsSymbol("BRK.B")).toBe("BRK/B");
    expect(parseOverseasDaily([
      { xymd: "20250103", clos: "243.36", open: "243.36", high: "244.18", low: "241.89", tvol: "40244114" },
      { xymd: "20250102", clos: "243.85", open: "248.93", high: "249.10", low: "241.82", tvol: "55740731" },
      { xymd: "", clos: "0" },
    ])).toEqual([
      { date: "2025-01-02", open: 248.93, high: 249.1, low: 241.82, close: 243.85, volume: 55740731 },
      { date: "2025-01-03", open: 243.36, high: 244.18, low: 241.89, close: 243.36, volume: 40244114 },
    ]);
    expect(parseOverseasChart([{ stck_bsop_date: "20250102", ovrs_nmix_prpr: "1470.5", ovrs_nmix_oprc: "0", ovrs_nmix_hgpr: "1475", ovrs_nmix_lwpr: "1465", acml_vol: "" }]))
      .toEqual([{ date: "2025-01-02", open: 1470.5, high: 1475, low: 1465, close: 1470.5, volume: 0 }]);
    // 거래소를 모르면 순서대로 시도, 100일씩 과거로 넘겨 받음
    const calls: Record<string, string>[] = [];
    const client = { call: async ({ query }: any) => {
      calls.push(query);
      if (query.EXCD !== "NYS") return { body: { output2: [] } };
      const rows = query.BYMD >= "20250103" ? [{ xymd: "20250103", clos: "2", open: "2", high: "2", low: "2", tvol: "1" }, { xymd: "20250102", clos: "1", open: "1", high: "1", low: "1", tvol: "1" }]
        : query.BYMD >= "20241231" ? [{ xymd: "20241231", clos: "3", open: "3", high: "3", low: "3", tvol: "1" }] : [];
      return { body: { output2: rows } };
    } } as any;
    const bars = await kisUsDaily(client, "BRK.B", "2024-12-01", "2025-01-10");
    expect(bars.map((b) => b.date)).toEqual(["2024-12-31", "2025-01-02", "2025-01-03"]);
    expect(calls[0]).toMatchObject({ EXCD: "NAS", SYMB: "BRK/B", MODP: "1", GUBN: "0" });
    await expect(kisUsDaily(client, "ZZZZ", "2024-12-01", "2025-01-10", ["NAS"])).rejects.toThrow("한국투자증권 해외 시세 없음");
  });
});

describe("한국투자증권 미국 시세: 분할만 반영", () => {
  it("원래 가격과 수정주가를 비교해 분할을 찾고, 배당 조정은 분할로 보지 않는다", async () => {
    const { detectSplits, applySplits, kisUsSplitOnlyDaily } = await import("@/lib/kis/market");
    const bar = (date: string, c: number, v = 100) => ({ date, open: c, high: c, low: c, close: c, volume: v });
    // 01-06 에 4:1 분할, 01-03 에 배당락(수정주가만 그 전 가격이 1% 낮음)
    const raw = [bar("2025-01-02", 400), bar("2025-01-03", 404), bar("2025-01-06", 102), bar("2025-01-07", 103)];
    const adj = [bar("2025-01-02", 99), bar("2025-01-03", 101), bar("2025-01-06", 102), bar("2025-01-07", 103)];
    const splits = detectSplits(raw, adj);
    expect(splits).toEqual([{ date: "2025-01-06", ratio: 4 }]);
    const so = applySplits(raw, splits);
    expect(so.map((b) => b.close)).toEqual([100, 101, 102, 103]); // 배당은 가격에 안 들어감 (수정주가는 99)
    expect(so.map((b) => b.volume)).toEqual([400, 400, 100, 100]);
    // 병합(1:8)도
    expect(detectSplits([bar("2025-01-02", 10), bar("2025-01-03", 80)], [bar("2025-01-02", 80), bar("2025-01-03", 80)])).toEqual([{ date: "2025-01-03", ratio: 0.125 }]);
    // 두 번 받아(MODP 0, 1) 합침
    const mods: string[] = [];
    const client = { call: async ({ query }: any) => {
      mods.push(query.MODP);
      if (query.BYMD < "20250107") return { body: { output2: [] } };
      const src = query.MODP === "0" ? raw : adj;
      return { body: { output2: src.map((b) => ({ xymd: b.date.replace(/-/g, ""), clos: String(b.close), open: String(b.open), high: String(b.high), low: String(b.low), tvol: String(b.volume) })) } };
    } } as any;
    const out = await kisUsSplitOnlyDaily(client, "TEST", "2025-01-01", "2025-01-10", ["NAS"]);
    expect(out.map((b) => b.close)).toEqual([100, 101, 102, 103]);
    expect(new Set(mods)).toEqual(new Set(["0", "1"]));
  });
});
