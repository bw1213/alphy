import { describe, expect, it } from "vitest";
import { universeLabel, withCode } from "../lib/strategies/universe";

describe("종목 이름 (코드) 표시", () => {
  it("이름을 알면 이름 (코드), 모르면 코드만", () => {
    expect(withCode("TIGER 미국S&P500", "360750")).toBe("TIGER 미국S&P500 (360750)");
    expect(withCode(undefined, "UPRO")).toBe("UPRO");
    expect(withCode("UPRO", "UPRO")).toBe("UPRO");
  });
  it("내 전략 대상 종목 설명에 이름을 붙임", () => {
    const names: Record<string, string> = { "360750": "TIGER 미국S&P500" };
    expect(universeLabel({ mode: "list", size: 100, pit: false, tickers: "360750, UPRO" }, (c) => names[c])).toBe("TIGER 미국S&P500 (360750), UPRO");
  });
});
