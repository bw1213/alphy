import { describe, expect, it } from "vitest";
import { cleanSpec, extendBars, guessFromName, rateBars, suggestSpec } from "@/lib/data/backfill";
import { applyBackfill, type BackfillTarget } from "@/lib/data/backfillApply";
import { backfillRequest, chainFor, cleanBackfillState } from "@/lib/data/backfillPick";
import { businessDays } from "@/lib/data/synthetic";
import type { Bar } from "@/lib/engine/types";

const days = businessDays("2020-01-01", "2020-12-31");
/** 매일 r 만큼 오르내리는 시세 */
const walk = (dates: string[], start: number, r: (i: number) => number): Bar[] => {
  let px = start;
  return dates.map((date, i) => {
    if (i) px *= 1 + r(i);
    return { date, open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 100 };
  });
};
const ret = (i: number) => (i % 2 ? 0.01 : -0.008);
const proxy = walk(days, 1000, ret);
const t0 = days[150];
const target = walk(days.slice(150), 50, ret);

describe("extendBars", () => {
  it("배수 1: 지수 움직임 그대로, 상장일 종가에 맞춤", () => {
    const { bars } = extendBars(target, proxy, [], { lev: 1, fee: 0 }, () => 0, days[0]);
    expect(bars.length).toBe(150);
    expect(bars.at(-1)!.date < t0).toBe(true);
    // 채운 마지막 날 → 상장일 수익률 = 지수 수익률
    expect(target[0].close / bars.at(-1)!.close).toBeCloseTo(proxy[150].close / proxy[149].close, 10);
    expect(bars[0].close / bars[1].close).toBeCloseTo(proxy[0].close / proxy[1].close, 10);
  });

  it("배수 2: 하루 수익률 × 2 − 금리 비용 − 보수", () => {
    const rf = 0.0252, fee = 0.252;
    const { bars } = extendBars(target, proxy, [], { lev: 2, fee }, () => rf, days[0]);
    const r = bars[11].close / bars[10].close - 1;
    const pr = proxy[11].close / proxy[10].close - 1;
    expect(r).toBeCloseTo(2 * pr - rf / 252 - fee / 100 / 252, 10);
  });

  it("인버스: 반대로 움직이고 고가·저가가 뒤바뀜", () => {
    const { bars } = extendBars(target, proxy, [], { lev: -1, fee: 0 }, () => 0, days[0]);
    const r = bars[11].close / bars[10].close - 1;
    expect(r).toBeCloseTo(-(proxy[11].close / proxy[10].close - 1), 10);
    for (const b of bars) expect(b.high).toBeGreaterThanOrEqual(b.low);
  });

  it("배수 1이면 지수 배당을 채운 가격 비율대로 넣음", () => {
    const { bars, divs } = extendBars(target, proxy, [{ date: days[20], amount: 10 }], { lev: 1, fee: 0 }, () => 0, days[0]);
    expect(divs).toHaveLength(1);
    expect(divs[0].amount).toBeCloseTo(10 * bars[19].close / proxy[19].close, 10);
  });

  it("시작일보다 앞은 채우지 않고, 지수가 더 짧으면 빈 결과", () => {
    expect(extendBars(target, proxy, [], { lev: 1, fee: 0 }, () => 0, days[100]).bars[0].date).toBe(days[100]);
    expect(extendBars(target, proxy.slice(160), [], { lev: 1, fee: 0 }, () => 0, days[0]).bars).toHaveLength(0);
  });
});

describe("기본 대용", () => {
  it("잘 알려진 ETF", () => {
    expect(suggestSpec("498400")!.chain).toEqual(["069500", "^KS11"]);
    expect(suggestSpec("UPRO")).toMatchObject({ chain: ["SPY", "^GSPC"], lev: 3 });
    expect(suggestSpec("453010")!.chain).toEqual(["RATE:KR"]);
    // 채권·금 ETF 는 상장 전을 국채 펀드·금 선물로
    expect(suggestSpec("IEF")!.chain).toEqual(["VFITX"]);
    expect(suggestSpec("GLD")!.chain).toEqual(["GC=F"]);
  });
  it("이름으로 추정", () => {
    expect(guessFromName("KODEX 200선물인버스2X")).toMatchObject({ chain: ["069500", "^KS11"], lev: -2 });
    expect(guessFromName("ACE 미국S&P500")).toMatchObject({ chain: ["SPY", "^GSPC"], lev: 1 });
    expect(guessFromName("TIGER 미국나스닥100(H)")).toMatchObject({ chain: ["QQQ", "^NDX"], hedged: true });
    expect(guessFromName("KODEX 코스닥150레버리지")).toMatchObject({ chain: ["229200", "^KQ11"], lev: 2 });
    expect(guessFromName("삼성전자")).toBeNull();
  });
  it("요청 값 정리", () => {
    expect(cleanSpec({ chain: ["^gspc", "rm -rf", "SPY"], lev: 9, fee: -1 })).toEqual({ chain: ["^GSPC", "SPY"], lev: 1, fee: 0 });
    expect(cleanSpec({ chain: [] })).toBeNull();
    expect(cleanSpec({ chain: ["GLD", "GC=F"] })!.chain).toEqual(["GLD", "GC=F"]);
  });
  it("화면 선택 → 요청", () => {
    expect(chainFor("069500")).toEqual(["069500", "^KS11"]);
    const st = cleanBackfillState({ on: true, picks: { A: { proxy: "none" }, B: { proxy: "^NDX", lev: "3", fee: "0.9" } } });
    expect(backfillRequest(st, ["A", "B", "C"])).toEqual({ A: null, B: { chain: ["^NDX"], lev: 3, fee: 0.9 }, C: "auto" });
    expect(backfillRequest({ ...st, on: false }, ["A"])).toBeUndefined();
  });
});

describe("applyBackfill", () => {
  const fx = days.map((date) => ({ date, close: 1000 }));
  it("한국 ETF 를 한국 지수로, 미국 ETF 를 미국 지수(달러→원화)로 채움", async () => {
    const out: BackfillTarget = {
      data: { "069500": target.map((b) => ({ ...b })), SPY: target.map((b) => ({ ...b, open: b.open * 1000, high: b.high * 1000, low: b.low * 1000, close: b.close * 1000 })), "005930": walk(days, 100, ret) },
      dividends: { "069500": [], SPY: [] }, fx, warnings: [],
    };
    await applyBackfill(out, { start: days[0], end: days.at(-1)!, backfill: { "*": "auto" } }, {
      loadTickers: async () => ({ data: {} }),
      yahoo: async () => proxy,
    });
    expect(out.data["069500"][0].date).toBe(days[0]);
    expect(out.data.SPY[0].date).toBe(days[0]);
    expect(out.data["005930"]).toHaveLength(days.length); // 처음부터 있던 종목은 그대로
    // 미국 종목은 원화 값 (환율 1000, 지수별 배당 가정만 조금 다름)
    expect(out.data.SPY[0].close / out.data["069500"][0].close).toBeCloseTo(1000, -1);
    expect(out.backfilled!.map((n) => n.ticker).sort()).toEqual(["069500", "SPY"]);
    expect(out.warnings[0]).toContain("상장 전 기간을 지수로 채웠습니다");
  });

  it("따라갈 지수를 모르면 경고만, 채우지 않음(null)이면 그대로", async () => {
    const out: BackfillTarget = { data: { "000001": target.map((b) => ({ ...b })), "069500": target.map((b) => ({ ...b })) }, warnings: [] };
    await applyBackfill(out, { start: days[0], end: days.at(-1)!, backfill: { "069500": null } }, { loadTickers: async () => ({ data: {} }), yahoo: async () => proxy });
    expect(out.data["069500"][0].date).toBe(t0);
    expect(out.data["000001"][0].date).toBe(t0);
    expect(out.warnings.join()).toContain("000001");
  });

  it("금리 대용: 기준금리만큼 매일 오름", async () => {
    const out: BackfillTarget = { data: { "453010": target.map((b) => ({ ...b })) }, warnings: [] };
    await applyBackfill(out, { start: days[0], end: days.at(-1)!, backfill: { "*": "auto" } }, { loadTickers: async () => ({ data: {} }), yahoo: async () => [] });
    const b = out.data["453010"];
    expect(b[0].date).toBe(days[0]);
    expect(b[0].close).toBeLessThan(b[149].close);
    expect(rateBars([["2000-01-01", 2]], "2020-01-01", "2020-12-31").length).toBeGreaterThan(250);
  });

  it("선물(GC=F)은 종목이 아니라 야후 시세로 받음", async () => {
    const asked: string[] = [];
    const out: BackfillTarget = { data: { GLD: target.map((b) => ({ ...b })) }, warnings: [], fx: days.map((date) => ({ date, close: 1000 })) };
    await applyBackfill(out, { start: days[0], end: days.at(-1)!, backfill: { "*": "auto" } }, {
      loadTickers: async (codes) => { asked.push(...codes); return { data: {} }; },
      yahoo: async (sym) => { asked.push("yahoo:" + sym); return sym === "GC=F" ? proxy : []; },
    });
    expect(asked).toContain("yahoo:GC=F");
    expect(asked).not.toContain("GC=F");
    expect(out.data.GLD[0].date).toBe(days[0]);
  });
});

