import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBacktest, DELIST_AFTER_DAYS } from "@/lib/engine/engine";
import { paramVariants, rollingReturns, splitStats, summarizeSensitivity } from "@/lib/engine/validate";
import { businessDays, syntheticSeries } from "@/lib/data/synthetic";
import { buildPitUniverse, parseKrxDaily, parseListings, snapshotDates } from "@/lib/data/krx";
import { parseUniverseCsv } from "@/lib/data/server";
import type { EquityPoint, RunSettings } from "@/lib/engine/types";

const base: RunSettings = { rebalance: "D", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 0 };
const noCost = { commission: 0, slippage: 0, sellTax: 0 };

describe("시점별 유니버스", () => {
  const dates = businessDays("2022-01-03", "2022-12-30");
  const A = syntheticSeries(dates, 1), B = syntheticSeries(dates, 2), C = syntheticSeries(dates, 3);

  it("전략은 그 날짜 시점의 목록에 있는 종목만 본다", () => {
    const seen = new Map<string, string>();
    runBacktest({
      data: { A, B, C }, settings: base,
      universe: [{ date: "2021-12-31", tickers: ["A", "B", "ZZZ"] }, { date: "2022-07-01", tickers: ["B", "C"] }],
      strategy: (c) => { seen.set(c.date, c.tickers.join("")); return c.equal(c.tickers); },
    });
    expect(seen.get("2022-01-03")).toBe("AB");      // 데이터에 없는 종목은 빠짐
    expect(seen.get("2022-06-30")).toBe("AB");
    expect(seen.get("2022-07-01")).toBe("BC");
    expect(seen.get("2022-12-29")).toBe("BC");
  });
  it("목록이 없으면 전체 종목", () => {
    let n = 0;
    runBacktest({ data: { A, B, C }, settings: base, strategy: (c) => { n = c.tickers.length; return null; } });
    expect(n).toBe(3);
  });
  it("목록에서 빠진 종목은 다음 리밸런싱에 팔린다", () => {
    const res = runBacktest({
      data: { A, B }, settings: base, costs: noCost,
      universe: [{ date: "2021-12-31", tickers: ["A"] }, { date: "2022-07-01", tickers: ["B"] }],
      strategy: (c) => c.equal(c.tickers),
    });
    expect(res.finalPositions.map((p) => p.ticker)).toEqual(["B"]);
    expect(res.trades.find((t) => t.ticker === "A" && t.side === "SELL")!.date).toBe("2022-07-04");
  });
});

describe("상장폐지", () => {
  const dates = businessDays("2022-01-03", "2022-12-30");
  const A = syntheticSeries(dates, 1);
  const cut = 100;
  const D = syntheticSeries(dates, 5).slice(0, cut); // 중간에 시세가 끊김

  it("시세가 끊긴 종목은 마지막 종가에 청산되고 현금으로 돌아온다", () => {
    const res = runBacktest({ data: { A, D }, settings: base, costs: noCost, initialCash: 1e8,
      strategy: (c) => (c.dayIndex === 0 ? { D: 1 } : null) });
    const sell = res.trades.find((t) => t.reason === "delisted")!;
    expect(sell.ticker).toBe("D");
    expect(sell.date).toBe(dates[cut]);
    expect(sell.price).toBe(D[cut - 1].close);
    expect(res.finalPositions).toEqual([]);
    const last = res.equity.at(-1)!;
    expect(last.invested).toBe(0);
    expect(last.equity).toBeCloseTo(last.cash, 6);
  });
  it("끝에서 며칠 비는 정도(수집 지연)는 상장폐지로 보지 않는다", () => {
    const E = syntheticSeries(dates, 6).slice(0, dates.length - DELIST_AFTER_DAYS);
    const res = runBacktest({ data: { A, E }, settings: base, costs: noCost, strategy: (c) => (c.dayIndex === 0 ? { E: 1 } : null) });
    expect(res.trades.some((t) => t.reason === "delisted")).toBe(false);
    expect(res.finalPositions.map((p) => p.ticker)).toEqual(["E"]);
  });
});

describe("검증 지표", () => {
  const eq = (vals: number[]): EquityPoint[] => vals.map((v, k) => ({
    date: new Date(Date.UTC(2020, 0, 1) + k * 864e5).toISOString().slice(0, 10), equity: v, cash: 0, invested: v, benchmark: 100 + k,
  }));
  it("앞·뒤 구간을 따로 계산하고 경계일을 공유", () => {
    // 앞 700일은 매일 +0.1%, 뒤 300일은 제자리
    const vals = Array.from({ length: 1000 }, (_, k) => 100 * 1.001 ** Math.min(k, 700));
    const s = splitStats(eq(vals))!;
    expect(s.first.end).toBe(s.second.start);
    expect(s.splitDate).toBe(s.second.start);
    expect(s.first.cagr).toBeGreaterThan(0.3);
    expect(s.second.cagr).toBeCloseTo(0, 6);
    expect(s.second.bench).not.toBeNull();
    expect(splitStats(eq(vals.slice(0, 100)))).toBeNull();
  });
  it("1년 구간 수익률 분포", () => {
    const up = Array.from({ length: 600 }, (_, k) => 100 * 1.002 ** k);
    const r = rollingReturns(up)!;
    expect(r.n).toBe(600 - 252);
    expect(r.hit).toBe(1);
    expect(r.worst).toBeCloseTo(1.002 ** 252 - 1, 6);
    expect(rollingReturns(up.slice(0, 260))).toBeNull();
    const flat = rollingReturns(Array(600).fill(100))!;
    expect(flat.hit).toBe(0);
    expect(flat.positive).toBe(0);
  });
  it("파라미터 ±20%: 정수는 정수로, 0·문자열·안 바뀌는 값은 제외", () => {
    const v = paramVariants({ lookback: 120, topK: 2, off: 0, ratio: 0.95, name: "x" as any, one: 1 });
    expect(v.map((x) => [x.key, x.value])).toEqual([["lookback", 96], ["lookback", 144], ["ratio", 0.76], ["ratio", 1.14]]);
  });
  it("민감도 요약", () => {
    const s = summarizeSensitivity({ label: "b", cagr: 0.35, mdd: -0.2 }, [
      { label: "a", cagr: 0.1, mdd: -0.3 }, { label: "c", cagr: 0.4, mdd: -0.2 }, { label: "d", cagr: NaN, mdd: NaN },
    ]);
    expect(s.worst).toBe(0.1);
    expect(s.best).toBe(0.4);
    expect(s.hit).toBe(0.5);
  });
});

describe("KRX", () => {
  it("전종목 시세: 보통주만, 시총 큰 순", () => {
    const rows = parseListings({ OutBlock_1: [
      { ISU_SRT_CD: "000660", ISU_CD: "KR7000660001", ISU_ABBRV: "SK하이닉스", MKTCAP: "100,000,000", TDD_CLSPRC: "140,000" },
      { ISU_SRT_CD: "005930", ISU_CD: "KR7005930003", ISU_ABBRV: "삼성전자", MKTCAP: "400,000,000", TDD_CLSPRC: "70,000" },
      { ISU_SRT_CD: "005935", ISU_CD: "KR7005931001", ISU_ABBRV: "삼성전자우", MKTCAP: "50,000,000", TDD_CLSPRC: "60,000" },
      { ISU_SRT_CD: "123450", ISU_CD: "KR7123450000", ISU_ABBRV: "어떤스팩1호", MKTCAP: "1,000", TDD_CLSPRC: "2,000" },
      { ISU_SRT_CD: "111110", ISU_CD: "KR7111110006", ISU_ABBRV: "휴장일", MKTCAP: "-", TDD_CLSPRC: "-" },
    ] });
    expect(rows.map((r) => r.code)).toEqual(["005930", "000660"]);
    expect(rows[0]).toMatchObject({ isin: "KR7005930003", marketCap: 400_000_000, close: 70_000 });
    expect(parseListings({})).toEqual([]);
  });
  it("개별종목 시세: 오름차순, 거래정지일은 종가로 채움", () => {
    const bars = parseKrxDaily({ output: [
      { TRD_DD: "2024/01/03", TDD_CLSPRC: "1,000", TDD_OPNPRC: "0", TDD_HGPRC: "0", TDD_LWPRC: "0", ACC_TRDVOL: "0" },
      { TRD_DD: "2024/01/02", TDD_CLSPRC: "1,000", TDD_OPNPRC: "990", TDD_HGPRC: "1,010", TDD_LWPRC: "980", ACC_TRDVOL: "12,345" },
    ] });
    expect(bars).toEqual([
      { date: "2024-01-02", open: 990, high: 1010, low: 980, close: 1000, volume: 12345 },
      { date: "2024-01-03", open: 1000, high: 1000, low: 1000, close: 1000, volume: 0 },
    ]);
  });
  it("분기 말 날짜: 시작 직전 분기 말부터", () => {
    expect(snapshotDates("2023-02-10", "2023-10-05")).toEqual(["2022-12-31", "2023-03-31", "2023-06-30", "2023-09-30"]);
    expect(snapshotDates("2023-11-01", "2024-01-15")).toEqual(["2023-09-30", "2023-12-31"]);
  });
  it("시점별 목록: 휴장일이면 앞 날짜로, 한 번이라도 든 종목을 모두 모음", async () => {
    const mk = (code: string, cap: number) => ({ code, isin: "KR7" + code, name: "N" + code, marketCap: cap, close: 1 });
    const asked: string[] = [];
    const u = await buildPitUniverse("2023-02-10", "2023-07-05", 2, async (d) => {
      asked.push(d);
      if (d === "2022-12-31") return [];   // 12/31 휴장
      if (d < "2023-01-01") return [mk("000010", 9), mk("000020", 8), mk("000030", 7)];
      if (d < "2023-04-01") return [mk("000010", 9), mk("000030", 8), mk("000020", 7)];
      return [mk("000040", 9), mk("000010", 8)];
    });
    expect(asked.slice(0, 2)).toEqual(["2022-12-31", "2022-12-30"]);
    expect(u.snapshots).toEqual([
      { date: "2022-12-30", tickers: ["000010", "000020"] },
      { date: "2023-03-31", tickers: ["000010", "000030"] },
      { date: "2023-06-30", tickers: ["000040", "000010"] },
    ]);
    expect([...u.listings.keys()].sort()).toEqual(["000010", "000020", "000030", "000040"]);
    await expect(buildPitUniverse("2023-02-10", "2023-03-01", 2, async () => [])).rejects.toThrow(/하나도/);
  });
  it("universe.csv", () => {
    const u = parseUniverseCsv("date,code,name\n2023-03-31,005930,삼성전자\n2022-12-30,000660\n2023-03-31,000660,SK하이닉스\n\n");
    expect(u.snapshots).toEqual([{ date: "2022-12-30", tickers: ["000660"] }, { date: "2023-03-31", tickers: ["005930", "000660"] }]);
    expect(u.names).toEqual({ "005930": "삼성전자", "000660": "SK하이닉스" });
  });
});

describe("loadData: 시점별 목록 + 상장폐지 종목은 KRX 시세", () => {
  let dir = "";
  const cwd = process.cwd();
  afterEach(() => { process.chdir(cwd); vi.unstubAllGlobals(); vi.resetModules(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("네이버에 없는 종목은 KRX 로 받는다", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "alphy-pit-"));
    process.chdir(dir);
    const days = businessDays("2022-06-01", "2023-06-30");
    const xml = (ds: string[]) => ds.map((d) => `<item data="${d.replace(/-/g, "")}|100|100|100|100|10" />`).join("");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      if (url.includes("data.krx.co.kr")) {
        const f = new URLSearchParams(init.body);
        if (f.get("bld")!.endsWith("MDCSTAT01501")) {
          const d = f.get("trdDd")!;
          const rows = d < "20230101"
            ? [{ ISU_SRT_CD: "000010", ISU_CD: "KR7000010009", ISU_ABBRV: "살아남음", MKTCAP: "900" }, { ISU_SRT_CD: "000020", ISU_CD: "KR7000020008", ISU_ABBRV: "폐지됨", MKTCAP: "800" }]
            : [{ ISU_SRT_CD: "000010", ISU_CD: "KR7000010009", ISU_ABBRV: "살아남음", MKTCAP: "900" }];
          return new Response(JSON.stringify({ OutBlock_1: /(0930|1230|0331|0630)$/.test(d) ? rows : [] }));
        }
        expect(f.get("isuCd")).toBe("KR7000020008");
        return new Response(JSON.stringify({ output: days.slice(0, 150).map((d) => ({ TRD_DD: d.replace(/-/g, "/"), TDD_CLSPRC: "50", TDD_OPNPRC: "50", TDD_HGPRC: "50", TDD_LWPRC: "50", ACC_TRDVOL: "5" })) }));
      }
      const sym = new URL(url).searchParams.get("symbol");
      return new Response(sym === "000020" ? "" : xml(days));
    }));
    const { loadData } = await import("@/lib/data/server");
    const r = await loadData({ source: "naver", start: "2022-11-01", end: "2023-06-30", universeSize: 2, pit: true });
    expect(r.universe!.map((u) => [u.date, u.tickers.length])).toEqual([["2022-09-30", 2], ["2022-12-30", 2], ["2023-03-31", 1], ["2023-06-30", 1]]);
    expect(Object.keys(r.data).sort()).toEqual(["000010", "000020"]);
    expect(r.names["000020"]).toBe("폐지됨");
    expect(r.data["000020"].at(-1)!.close).toBe(50);
    expect(r.warnings.join(" ")).toMatch(/1종목은 네이버에 시세가 없어/);
  }, 20000);
});
