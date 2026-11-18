import { describe, expect, it } from "vitest";
import { compareIndices, longestLoss, stats } from "@/lib/engine/metrics";
import { addIndices, type DataResponse } from "@/lib/data/server";
import type { Bar } from "@/lib/engine/types";

const bar = (date: string, close: number): Bar => ({ date, open: close, high: close, low: close, close, volume: 1 });

describe("최장 손실 구간", () => {
  it("고점 회복까지 가장 긴 기간", () => {
    const d = ["2020-01-01", "2020-02-01", "2020-03-01", "2020-04-01", "2020-05-01", "2020-06-01"];
    // 1월 고점 → 4월 회복(91일), 4월 고점 → 끝까지 회복 못 함(61일)
    expect(longestLoss(d, [100, 90, 95, 101, 99, 100])).toBe(91);
    expect(longestLoss(d, [100, 101, 102, 103, 104, 105])).toBe(0);
    expect(longestLoss(d, [100, 50, 60, 70, 80, 90])).toBe(152);
    expect(stats(d, [100, 90, 95, 101, 99, 100]).lossDays).toBe(91);
  });
});

describe("지수 비교", () => {
  const dates = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];
  it("평가 날짜에 맞추고 빈 날은 직전 값, 늦게 시작하면 그날부터", () => {
    const [sp, ks] = compareIndices(dates, [
      { key: "sp500", name: "S&P 500", bars: [bar("2019-12-31", 100), bar("2020-01-03", 110), bar("2020-01-07", 121)] },
      { key: "kospi", name: "KOSPI", bars: [bar("2020-01-06", 50), bar("2020-01-07", 55)] },
    ]);
    expect(sp.values.map((v) => +v!.toFixed(6))).toEqual([100, 110, 110, 121]);
    expect(sp.stats.totalReturn).toBeCloseTo(0.21);
    expect(sp.from).toBe("2020-01-02");
    expect(ks.from).toBe("2020-01-06");
    expect(ks.values[0]).toBeNull();
    expect(ks.values[3]).toBeCloseTo(110);
    expect(ks.annual.get(2020)).toBeCloseTo(0.1);
  });
  it("겹치는 날이 없으면 뺌", () => {
    expect(compareIndices(dates, [{ key: "x", name: "X", bars: [bar("2021-01-01", 1)] }])).toEqual([]);
  });
});

describe("addIndices", () => {
  const base = (over: Partial<DataResponse> = {}): DataResponse => ({ data: {}, names: {}, benchmark: null, warnings: [], ...over });
  const req = { source: "naver" as const, start: "2020-01-01", end: "2020-12-31" };
  it("한국 종목: KOSPI 는 이미 받은 것, S&P 500 은 야후 + 환율로 원화", async () => {
    const out = base({ benchmark: [{ date: "2020-01-02", close: 2000 }], benchmarkName: "KOSPI" });
    const asked: string[] = [];
    await addIndices(out, req, {
      kospi: async () => { throw new Error("부르면 안 됨"); },
      yahoo: async (sym) => { asked.push(sym); return sym === "KRW=X" ? [bar("2019-12-20", 1000)] : [bar("2020-01-02", 3)]; },
    });
    expect(asked.sort()).toEqual(["KRW=X", "^GSPC"]);
    expect(out.indices!.map((x) => x.key)).toEqual(["sp500", "kospi"]);
    expect(out.indices![0].bars[0].close).toBe(3000);
    expect(out.fx).toBeUndefined(); // 한국 종목만이면 미국 비용이 붙지 않게 fx 는 그대로 없음
  });
  it("미국 종목만: S&P 500 은 이미 받은 것, KOSPI 를 더 받음. 실패하면 경고", async () => {
    const out = base({ benchmark: [{ date: "2020-01-02", close: 4000000 }], benchmarkName: "S&P 500", fx: [{ date: "2020-01-01", close: 1200 }] });
    await addIndices(out, req, { kospi: async () => [bar("2020-01-02", 2200)], yahoo: async () => { throw new Error("x"); } });
    expect(out.indices!.map((x) => x.name)).toEqual(["S&P 500", "KOSPI"]);
    const out2 = base({ benchmark: [{ date: "2020-01-02", close: 4000000 }], benchmarkName: "S&P 500" });
    await addIndices(out2, req, { kospi: async () => { throw new Error("403"); }, yahoo: async () => [] });
    expect(out2.indices!.map((x) => x.name)).toEqual(["S&P 500"]);
    expect(out2.warnings.join()).toContain("KOSPI");
  });
  it("가짜 데이터는 지수 없음", async () => {
    const out = base();
    await addIndices(out, { ...req, source: "synthetic" });
    expect(out.indices).toBeUndefined();
  });
});
