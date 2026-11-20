import { mkdtempSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { KisClient } from "@/lib/kis/client";
import { kisMinuteDay, parseMinuteRows, type MinuteBar } from "@/lib/kis/minute";
import { cachedMinuteDays, settled, type MinuteDay } from "@/lib/intraday/data";
import { aggregate, krTick, prepareDays, run, settle, type Costs } from "@/lib/intraday/engine";
import { INTRADAY_STRATEGIES } from "@/lib/intraday/strategies";
import { normalizeRequest, runStudy } from "@/lib/intraday/study";

const strat = (id: string) => INTRADAY_STRATEGIES.find((s) => s.id === id)!;
const free: Costs = { commission: 0, sellTax: () => 0, slippage: 0, tick: () => 0 };

/** 09:00~15:19 장중 1분봉 + 15:30 종가 봉. path(i) = i 번째 분의 종가 */
function day(date: string, path: (i: number) => number, open?: number): MinuteDay {
  const bars: MinuteBar[] = [];
  let prev = open ?? path(0);
  for (let i = 0; i < 380; i++) {
    const t = 900 + Math.floor(i / 60) * 100 + (i % 60);
    if (t >= 1520) break;
    const c = path(i);
    bars.push([t, prev, Math.max(prev, c), Math.min(prev, c), c, 100]);
    prev = c;
  }
  bars.push([1530, prev, prev, prev, prev, 1000]);
  return { date, bars };
}

describe("1분봉 받기", () => {
  it("응답 행을 시각순 봉으로 바꾸고 다른 날 행은 버림", () => {
    const rows = [
      { stck_bsop_date: "20261118", stck_cntg_hour: "153000", stck_prpr: "100", stck_oprc: "99", stck_hgpr: "101", stck_lwpr: "98", cntg_vol: "5" },
      { stck_bsop_date: "20261117", stck_cntg_hour: "153000", stck_prpr: "90", stck_oprc: "90", stck_hgpr: "90", stck_lwpr: "90", cntg_vol: "1" },
    ];
    expect(parseMinuteRows(rows, "20261118")).toEqual([[1530, 99, 101, 98, 100, 5]]);
  });

  it("120건씩 과거로 넘기며 하루치를 모음", async () => {
    const all = Array.from({ length: 381 }, (_, i) => {
      const t = 900 + Math.floor(i / 60) * 100 + (i % 60);
      return { stck_bsop_date: "20261118", stck_cntg_hour: `${String(t).padStart(4, "0")}00`, stck_prpr: String(100 + i), stck_oprc: "100", stck_hgpr: "999", stck_lwpr: "1", cntg_vol: "1" };
    });
    const hours: string[] = [];
    const f = (async (u: string) => {
      const url = new URL(u);
      if (url.pathname === "/oauth2/tokenP") return new Response(JSON.stringify({ access_token: "T", expires_in: 86400 }));
      const h = url.searchParams.get("FID_INPUT_HOUR_1")!;
      hours.push(h);
      const rows = all.filter((r) => r.stck_cntg_hour <= h).reverse().slice(0, 120);
      return new Response(JSON.stringify({ rt_cd: "0", output2: rows }));
    }) as unknown as typeof fetch;
    const c = new KisClient({ env: "real", appKey: "k", appSecret: "s" }, { fetch: f, cacheDir: null, sleep: async () => {}, minIntervalMs: 0 });
    const bars = await kisMinuteDay(c, "005930", "20261118");
    expect(bars).toHaveLength(381);
    expect(bars[0][0]).toBe(900);
    expect(bars.at(-1)![0]).toBe(1520);
    expect(hours[0]).toBe("163000");
    expect(hours.length).toBeLessThanOrEqual(5);
  });

  it("지난 날만 캐시하고 다시 안 받음", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "minute-"));
    let calls = 0;
    const fetchDay = async () => { calls++; return [[900, 1, 1, 1, 1, 1]] as MinuteBar[]; };
    const now = Date.parse("2026-11-20T03:00:00Z");
    await cachedMinuteDays("005930", ["2026-11-19", "2026-11-20"], fetchDay, { cacheDir: dir, now });
    expect(calls).toBe(2);
    await cachedMinuteDays("005930", ["2026-11-19", "2026-11-20"], fetchDay, { cacheDir: dir, now });
    expect(calls).toBe(3);
    expect(readdirSync(path.join(dir, "minute", "005930"))).toEqual(["2026-11.json"]);
    expect(settled("2026-11-20", Date.parse("2026-11-20T07:50:00Z"))).toBe(true);
  });
});

describe("단타 엔진", () => {
  it("호가 단위", () => {
    expect(krTick(55000, false)).toBe(100);
    expect(krTick(55000, true)).toBe(5);
    expect(krTick(1500, true)).toBe(1);
  });

  it("비용: 시장가는 1호가 불리, 동시호가는 슬리피지만, 주식은 매도세", () => {
    const c: Costs = { commission: 0.00015, sellTax: () => 0.002, slippage: 0, tick: () => 10 };
    const r = settle({ inPrice: 10000, inKind: "market", outPrice: 10000, outKind: "auction" }, c, 2026);
    expect(r.gross).toBe(0);
    expect(r.net).toBeCloseTo(10000 * (1 - 0.00015 - 0.002) / (10010 * 1.00015) - 1, 10);
  });

  it("5분봉으로 묶기", () => {
    const d = day("2026-11-18", (i) => 100 + i);
    const five = aggregate(d.bars.slice(0, -1), 5);
    expect(five[0]).toEqual([900, 100, 104, 100, 104, 500]);
    expect(five).toHaveLength(Math.ceil((d.bars.length - 1) / 5));
  });

  it("장 마감 동시호가 봉을 따로 두고 전날 종가를 이어 줌", () => {
    const days = prepareDays([day("2026-11-17", () => 100), day("2026-11-18", () => 110)]);
    expect(days[1].prevClose).toBe(100);
    expect(days[1].bars[days[1].lastCont][0]).toBe(1519);
    expect(days[1].bars.at(-1)![0]).toBe(1530);
  });

  it("시가 범위 돌파: 범위 고가를 넘으면 사서 종가에 팜", () => {
    const d = prepareDays([day("2026-11-18", (i) => (i < 15 ? 100 : 101 + (i > 30 ? 4 : 0)))]);
    const r = run(d, strat("orb").rule, { range: 15, stop: "low", until: 300 }, free);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].inPrice).toBe(101);
    expect(r.trades[0].outPrice).toBe(105);
  });

  it("시가 범위 돌파: 범위 저가 아래로 가면 손절", () => {
    const d = prepareDays([day("2026-11-18", (i) => (i < 15 ? 100 : i < 20 ? 102 : 95))]);
    const r = run(d, strat("orb").rule, { range: 15, stop: "low", until: 300 }, free);
    expect(r.trades[0].outKind).toBe("stop");
    expect(r.trades[0].outPrice).toBe(100);
  });

  it("갭 하락 되돌림: 전날 종가를 회복하면 그 가격에 팜", () => {
    const d = prepareDays([day("2026-11-17", () => 100), day("2026-11-18", (i) => (i < 60 ? 97 : 101), 97)]);
    const r = run(d, strat("gap_down").rule, { gap: 2, target: "fill", stop: false }, free);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ inPrice: 97, outPrice: 100, outKind: "limit" });
  });

  it("밤사이 보유는 다음 날 손익으로 셈", () => {
    const d = prepareDays([day("2026-11-17", () => 100), day("2026-11-18", () => 110, 110)]);
    const r = run(d, strat("overnight").rule, {}, free);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].date).toBe("2026-11-18");
    expect(r.equity).toEqual([1, 1.1]);
  });
});

describe("단타 전략 찾기", () => {
  it("요청 정리: 기간은 최근 1년 안, 종목 6개까지", () => {
    const r = normalizeRequest({ tickers: ["069500", "x", "005930"], start: "2020-01-01" }, Date.parse("2026-11-20T03:00:00Z"));
    expect(r.tickers).toEqual(["069500", "005930"]);
    expect(r.start).toBe("2025-11-19");
    expect(r.barMinutes).toBe(5);
  });

  it("고르는 구간에서 고른 파라미터를 확인 구간에 그대로 적용하고 지수와 함께 보여 줌", async () => {
    const dates = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString().slice(0, 10));
    const rep = await runStudy({ tickers: ["069500"], start: dates[0], end: dates.at(-1) }, {
      daily: async () => ({ dates: { "069500": dates }, names: { "069500": "KODEX 200" }, indices: [{ key: "kospi", name: "KOSPI", bars: dates.map((d, i) => ({ date: d, close: 100 + i })) }], warnings: [] }),
      minute: async (_c, ds) => ds.map((d, k) => day(d, (i) => 100 + k + (i % 7) * 0.5, 100 + k)),
      info: () => ({ etf: true }),
    });
    expect(rep.tickers).toHaveLength(1);
    const t = rep.tickers[0];
    expect(t.name).toBe("KODEX 200");
    expect(t.costs.sellTax).toBe(0);
    expect(t.strategies.map((s) => s.id)).toContain("orb");
    for (const s of t.strategies) expect(s.pick.to < s.check.from).toBe(true);
    expect(rep.split!.pickTo < rep.split!.checkFrom).toBe(true);
    expect(rep.indices[0].name).toBe("KOSPI");
    expect(rep.indices[0].all!.totalReturn).toBeGreaterThan(0);
  });

  it("장 마감 처리 전인 오늘은 빼고 계산", async () => {
    const dates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 8, 22) + i * 864e5).toISOString().slice(0, 10));
    const seen: string[][] = [];
    const rep = await runStudy({ tickers: ["069500"] }, {
      daily: async () => ({ dates: { "069500": dates }, names: {}, indices: [], warnings: [] }),
      minute: async (_c, ds) => { seen.push(ds); return ds.map((d) => day(d, () => 100)); },
      info: () => ({ etf: true }),
    }, undefined, Date.parse("2026-11-20T03:00:00Z"));
    expect(seen[0].at(-1)).toBe("2026-11-19");
    expect(rep.tickers[0].to).toBe("2026-11-19");
  });
});

import { regularSession } from "@/lib/intraday/engine";
import { DEFAULT_DAYTRADE, normalizeDayTrade, screenDays, stockCosts, tradeDay } from "@/lib/intraday/screen";
import { runDayTrade } from "@/lib/intraday/daytrade";
import { loadDayTrades, saveDayTrade } from "@/lib/intraday/store";

const dBar = (date: string, o: number, c: number, v = 1e6) => ({ date, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: v });
const dates40 = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString().slice(0, 10));

/** 30일 10000원 → 이틀 동안 8000원까지 하락 → 마지막 날 갭 하락 시가 */
function fallingStock(lastOpen: number) {
  return dates40.map((d, i) => (i < 37 ? dBar(d, 10000, 10000) : i < 39 ? dBar(d, 9000, i === 37 ? 9000 : 8000) : dBar(d, lastOpen, lastOpen)));
}

describe("날마다 종목 고르는 단타", () => {
  it("과매도 + 갭 하락 종목만, 갭이 큰 순으로 고름", () => {
    const daily = new Map([["A00000", fallingStock(7400)], ["B00000", fallingStock(7000)], ["C00000", fallingStock(7900)]]);
    const picks = screenDays(daily, { ...DEFAULT_DAYTRADE, minValue: 0, maxPicks: 1 }, dates40[39], dates40[39]);
    expect(picks.get(dates40[39])!.map((p) => p.code)).toEqual(["B00000"]);
    const all = screenDays(daily, { ...DEFAULT_DAYTRADE, minValue: 0 }, dates40[39], dates40[39]);
    expect(all.get(dates40[39])!.map((p) => p.code)).toEqual(["B00000", "A00000"]);
  });

  it("09시에 연 날은 15:30 봉에서 자름 (뒤에 붙는 시간외 봉 무시)", () => {
    const bars: MinuteBar[] = [[900, 1, 1, 1, 1, 1], [1519, 1, 1, 1, 1, 1], [1530, 2, 2, 2, 2, 1], [1600, 3, 3, 3, 3, 1]];
    expect(regularSession(bars).at(-1)![0]).toBe(1530);
    const late: MinuteBar[] = [[1000, 1, 1, 1, 1, 1], [1630, 2, 2, 2, 2, 1]];
    expect(regularSession(late)).toHaveLength(2);
  });

  it("시가 매수 → 익절가를 넘으면 그 가격에, 손절이 먼저면 손절", () => {
    const free = stockCosts(0, 0, () => 0);
    const up = day("2026-11-18", (i) => (i < 30 ? 100 : 104), 100).bars;
    const t = tradeDay({ code: "A", date: "2026-11-18", gap: -0.06, prevClose: 106, open: 100 }, up, DEFAULT_DAYTRADE, { ...free, tick: () => 0 }, 2026)!;
    expect(t).toMatchObject({ exit: "익절", sell: 103 });
    expect(t.net).toBeCloseTo(0.03, 10);
    const down = day("2026-11-18", (i) => (i < 30 ? 100 : 96), 100).bars;
    expect(tradeDay({ code: "A", date: "2026-11-18", gap: -0.06, prevClose: 106, open: 100 }, down, DEFAULT_DAYTRADE, { ...free, tick: () => 0 }, 2026)!.exit).toBe("손절");
  });

  it("백테스트: 고른 날만 종목당 비율로 자산에 반영하고 지수와 함께", async () => {
    const cal = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 1) + i * 864e5).toISOString().slice(0, 10));
    const rep = await runDayTrade({ spec: { minValue: 0, weight: 50 }, start: cal[0], end: cal.at(-1) }, {
      stocks: () => [{ code: "A00000", name: "에이" }],
      daily: async () => [...dates40.slice(0, 37).map((d) => dBar(d, 10000, 10000)), dBar("2026-07-08", 9000, 9000), dBar("2026-07-09", 8000, 8000), dBar(cal[5], 7000, 7300)],
      calendar: async () => ({ dates: cal, indices: [{ key: "kospi", name: "KOSPI", bars: cal.map((d, i) => ({ date: d, close: 100 + i })) }] }),
      minute: async (_c, d) => day(d, (i) => (i < 30 ? 7000 : 7300), 7000).bars,
    }, undefined, Date.parse("2026-11-20T03:00:00Z"));
    expect(rep.result.trades).toBe(1);
    expect(rep.trades[0]).toMatchObject({ code: "A00000", name: "에이", exit: "익절" });
    expect(rep.result.totalReturn).toBeCloseTo(0.5 * rep.trades[0].net, 10);
    expect(rep.indices[0].name).toBe("KOSPI");
  });

  it("내 단타 전략 저장·덮어쓰기", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dt-"));
    const e = { ALPHY_CONFIG_DIR: dir };
    saveDayTrade({ name: "[Claude] 테스트", spec: { gap: 7 } }, {}, e);
    expect(() => saveDayTrade({ name: "[Claude] 테스트", spec: {} }, {}, e)).toThrow();
    saveDayTrade({ name: "[Claude] 테스트", spec: { gap: 6 } }, { overwrite: true }, e);
    const list = loadDayTrades(undefined, e);
    expect(list).toHaveLength(1);
    expect(list[0].spec).toEqual(normalizeDayTrade({ gap: 6 }));
  });
});
