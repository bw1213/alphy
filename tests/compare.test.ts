import { describe, expect, it } from "vitest";
import { bestOf, buildCompare, mergeIndices, prepareCompare, savedId } from "@/lib/compare/compare";
import { stats } from "@/lib/engine/metrics";
import { cleanLastState } from "@/lib/strategies/lastState";
import { defaultCycleSpec } from "@/lib/strategies/cycle";
import { STRATEGIES } from "@/lib/strategies";
import type { BacktestResult } from "@/lib/engine/types";
import type { SavedStrategy } from "@/lib/strategies/library";

/** 평일 날짜 n개 */
function days(from: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(from);
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; }
  return out;
}
const fake = (dates: string[], f: (k: number) => number): BacktestResult =>
  ({ equity: dates.map((date, k) => ({ date, equity: f(k), cash: 0, invested: f(k), benchmark: null })), trades: [], finalPositions: [] } as unknown as BacktestResult);

describe("전략 비교", () => {
  const all = days("2020-01-01", 300);
  it("모두 값이 있는 같은 기간으로 맞추고 시작 = 100", () => {
    const a = fake(all, (k) => 100 * 1.001 ** k);
    const late = all.slice(50);
    const b = fake(late, (k) => 200 * (k < 100 ? 1 - k * 0.002 : 0.8 + (k - 100) * 0.001));
    const r = buildCompare([
      { id: "a", name: "A", universe: "", res: a },
      { id: "b", name: "B", universe: "", res: b },
      { id: "c", name: "C", universe: "", error: "코드 오류" },
    ], [])!;
    expect(r.start).toBe(late[0]);
    expect(r.end).toBe(all.at(-1));
    expect(r.lateBy).toBe("B");
    expect(r.rows.map((x) => x.values[0])).toEqual([100, 100]);
    expect(r.errors).toEqual([{ name: "C", error: "코드 오류" }]);
    // A 의 지표는 B 가 시작한 날부터 다시 계산
    const ref = stats(late, late.map((_, k) => 100 * 1.001 ** (k + 50)));
    expect(r.rows[0].stats.cagr).toBeCloseTo(ref.cagr, 10);
    expect(r.rows[1].stats.mdd).toBeCloseTo(-0.2, 6);
    expect(r.rows[1].dd.every((v) => v != null && v <= 0)).toBe(true);
    const best = bestOf(r.rows);
    expect(best.cagr).toBe("a");
    expect(best.mdd).toBe("a");
    expect(best.lossDays).toBe("a");
  });
  it("첫 거래일이 며칠 다른 정도(한국·미국)는 늦었다고 하지 않음, 빈 날은 직전 값", () => {
    const a = fake(all, () => 100);
    const b = fake(all.filter((_, k) => k !== 0 && k !== 10), (k) => 100 + k);
    const r = buildCompare([{ id: "a", name: "A", universe: "", res: a }, { id: "b", name: "B", universe: "", res: b }], [])!;
    expect(r.lateBy).toBeNull();
    expect(r.dates.length).toBe(299);
    // 10번째 날(b 에 없음)은 직전 값
    const k = r.dates.indexOf(all[10]);
    expect(r.rows[1].values[k]).toBe(r.rows[1].values[k - 1]);
  });
  it("S&P 500·KOSPI 를 같은 날짜로, 더 앞선 날부터 있는 지수를 씀", () => {
    const ix = mergeIndices([
      [{ key: "kospi", name: "KOSPI", bars: all.slice(100).map((date) => ({ date, close: 2000 })) }],
      [{ key: "kospi", name: "KOSPI", bars: all.map((date, k) => ({ date, close: 2000 + k })) }, { key: "sp500", name: "S&P 500", bars: all.map((date) => ({ date, close: 5 })) }],
    ]);
    expect(ix.map((x) => x.key)).toEqual(["sp500", "kospi"]);
    expect(ix[1].bars.length).toBe(all.length);
    const r = buildCompare([{ id: "a", name: "A", universe: "", res: fake(all, (k) => 100 + k) }], ix)!;
    expect(r.indices.map((x) => x.name)).toEqual(["S&P 500", "KOSPI"]);
    expect(r.indices[1].values[0]).toBe(100);
    expect(r.indices[1].dd[0]).toBe(0);
  });
  it("모두 실패하면 null", () => {
    expect(buildCompare([{ id: "a", name: "A", universe: "", error: "x" }], [])).toBeNull();
  });
});

describe("비교할 전략 준비", () => {
  const saved: SavedStrategy[] = [
    { name: "코드", code: "return ctx.equal(ctx.universe().slice(0, p.n));", params: '{"n":2}', rebalance: "W", stopLoss: "10", takeProfit: "", warmup: 30, intraday: true,
      universe: { mode: "list", size: 100, pit: false, tickers: "SPY, QQQ" } },
    { name: "적립", code: "", params: "{}", rebalance: "D", stopLoss: "", takeProfit: "", warmup: 0, cycle: defaultCycleSpec() },
    { name: "깨짐", code: "return (", params: "{}", rebalance: "M", stopLoss: "", takeProfit: "", warmup: 0 },
  ];
  it("기본 전략은 화면 파라미터를 씀", () => {
    const b = STRATEGIES[0];
    const k = b.params[0].key;
    const st = prepareCompare(b.id, saved, { [b.id]: { [k]: 7 } });
    expect(st.name).toBe(b.name);
    expect(st.p[k]).toBe(7);
    expect(st.universe).toBeUndefined();
  });
  it("내 전략은 저장된 코드·종목·손절·장중 매도", () => {
    const st = prepareCompare(savedId("코드"), saved);
    expect(st.p).toEqual({ n: 2 });
    expect(st.stopLoss).toBeCloseTo(0.1);
    expect(st.rebalance).toBe("W");
    expect(st.intraday).toBe(true);
    expect(st.universe?.tickers).toBe("SPY, QQQ");
    const c = prepareCompare(savedId("적립"), saved);
    expect(c.needsList).toBe(true);
    expect(c.rebalance).toBe("D");
  });
  it("없거나 깨진 전략은 알아볼 수 있는 오류", () => {
    expect(() => prepareCompare(savedId("없음"), saved)).toThrow(/찾지 못했습니다/);
    expect(() => prepareCompare(savedId("깨짐"), saved)).toThrow(/문법 오류/);
  });
  it("마지막 설정에 고른 전략이 저장됨 (중복·이상한 값 제거)", () => {
    const s = cleanLastState({ sid: "x", compare: ["saved:A", "saved:A", 3, "", "momentum"] });
    expect(s.compare).toEqual(["saved:A", "momentum"]);
    expect(cleanLastState({ sid: "x" }).compare).toEqual([]);
  });
});
