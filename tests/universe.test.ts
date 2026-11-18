import { describe, expect, it } from "vitest";
import { cleanStrategy } from "@/lib/strategies/library";
import { cleanUniverse, universeLabel, universeTickers } from "@/lib/strategies/universe";

const base = { name: "내 전략", code: "return {};", params: "{}", rebalance: "M", warmup: 0 };

describe("전략 저장에 종목 함께", () => {
  it("직접 입력 종목과 상장 전 채우기를 저장·복원", () => {
    const s = cleanStrategy({ ...base, universe: { mode: "list", size: 100, pit: false, tickers: "UPRO, TLT, GLD",
      backfill: { on: true, picks: { UPRO: { proxy: "auto", lev: "1", fee: "0", hedged: false } } } } });
    expect(s.universe?.mode).toBe("list");
    expect(s.universe?.tickers).toBe("UPRO, TLT, GLD");
    expect(s.universe?.backfill?.on).toBe(true);
    expect(universeTickers(s.universe)).toBe("UPRO, TLT, GLD");
    expect(universeLabel(s.universe!)).toBe("UPRO, TLT, GLD");
  });
  it("시가총액 상위 N", () => {
    const u = cleanUniverse({ mode: "top", size: 999, pit: true, tickers: "" })!;
    expect(u.size).toBe(300);
    expect(universeLabel(u)).toBe("시가총액 상위 300 (그때 기준)");
    expect(universeTickers(u)).toBe("");
  });
  it("예전 전략(종목 없음)·빈 목록은 universe 없음", () => {
    expect(cleanStrategy(base).universe).toBeUndefined();
    expect(cleanUniverse({ mode: "list", tickers: " " })).toBeUndefined();
  });
  it("종목이 많으면 줄여서 표시", () => {
    expect(universeLabel(cleanUniverse({ mode: "list", tickers: "1,2,3,4,5,6,7" })!)).toBe("1, 2, 3, 4, 5 외 2개");
  });
});
