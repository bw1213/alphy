import { describe, expect, it } from "vitest";
import { defaultSpec, generate, METRICS, normalizeSpec, type BuilderSpec } from "@/lib/strategies/builder";
import { compileStrategy } from "@/lib/strategies";
import { cleanStrategy } from "@/lib/strategies/library";
import { runBacktest } from "@/lib/engine/engine";
import { syntheticData } from "@/lib/data/synthetic";
import { paramVariants } from "@/lib/engine/validate";

const d = syntheticData(30, "2021-01-01", "2023-12-29");
const run = (spec: BuilderSpec, overrides: Record<string, number> = {}) => {
  const g = generate(spec);
  const fn = compileStrategy(g.code);
  const p = { ...g.params, ...overrides };
  return runBacktest({ data: d.data, benchmark: d.benchmark, startDate: "2022-06-01",
    settings: { rebalance: "M", stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: g.warmup },
    strategy: (c) => fn(c, p) });
};

describe("조건 고르기 → 전략", () => {
  it("기본 조건: 코드가 컴파일되고 조건대로 고른다", () => {
    const spec = defaultSpec();
    const g = generate(spec);
    expect(g.params).toEqual({ topK: 10, marketMa: 120, c1n: 20, c1v: 10, c2n: 60, c2v: 0, rankN: 120 });
    expect(g.warmup).toBe(122);
    expect(g.summary).toHaveLength(4);
    const res = run(spec);
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.signal).not.toBeNull();
    expect(res.signal!.picks.length).toBeLessThanOrEqual(10);
  });
  it("모든 지표가 조건과 순위 기준으로 오류 없이 돈다", () => {
    for (const m of METRICS) {
      const spec: BuilderSpec = { marketMa: 0, topK: 5,
        filters: [{ metric: m.id, n: m.defaults.n, m: m.defaults.m, op: ">=", value: -1e9 }], // 항상 참 → 지표 계산만 확인
        rank: { metric: m.id, n: m.defaults.n, m: m.defaults.m, dir: "asc" } };
      const res = run(spec);
      expect(res.signal!.picks.length, m.id).toBe(5);
      expect(Number.isFinite(res.equity.at(-1)!.equity), m.id).toBe(true);
    }
  });
  it("거르기 조건이 실제로 적용된다", () => {
    const base: BuilderSpec = { marketMa: 0, topK: 30, filters: [], rank: { metric: "ret", n: 60, m: 0, dir: "desc" } };
    const all = run(base).signal!.picks.map((p) => p.ticker);
    const up = run({ ...base, filters: [{ metric: "ret", n: 60, m: 0, op: ">=", value: 0 }] }).signal!.picks;
    const down = run({ ...base, filters: [{ metric: "ret", n: 60, m: 0, op: "<=", value: 0 }] }).signal!.picks;
    expect(all.length).toBe(30);
    expect(up.length).toBeGreaterThan(0);
    expect(down.length).toBeGreaterThan(0);
    expect(up.length + down.length).toBe(30);
    expect(run({ ...base, filters: [{ metric: "price", n: 0, m: 0, op: "<=", value: 0 }] }).signal!.picks).toEqual([]);
  });
  it("높은 순 / 낮은 순", () => {
    const mk = (dir: "desc" | "asc"): BuilderSpec => ({ marketMa: 0, topK: 1, filters: [], rank: { metric: "price", n: 0, m: 0, dir } });
    const hi = run(mk("desc")).signal!.picks[0], lo = run(mk("asc")).signal!.picks[0];
    expect(hi.close).toBeGreaterThan(lo.close);
  });
  it("숫자가 파라미터로 빠져서 바꿔 돌릴 수 있다 (민감도 검사)", () => {
    const g = generate(defaultSpec());
    expect(paramVariants(g.params).map((v) => v.key)).toContain("rankN");
    expect(run(defaultSpec(), { topK: 3 }).signal!.picks.length).toBeLessThanOrEqual(3);
  });
  it("이상한 입력은 안전한 범위로 정리", () => {
    const s = normalizeSpec({ marketMa: -5, topK: 999, filters: [{ metric: "없는지표", n: "abc", op: "??", value: "x" }, ...Array(20).fill({ metric: "rsi" })], rank: { metric: "maCross", n: 0, m: 9999, dir: "up" } });
    expect(s.marketMa).toBe(0);
    expect(s.topK).toBe(50);
    expect(s.filters).toHaveLength(8);
    expect(s.filters[0]).toEqual({ metric: "ret", n: 120, m: 0, op: ">=", value: 0 });
    expect(s.rank).toEqual({ metric: "maCross", n: 1, m: 500, dir: "desc" });
    expect(normalizeSpec(null)).toEqual(defaultSpec());
  });
  it("보관함에 조건과 함께 저장된다", () => {
    const g = generate(defaultSpec());
    const saved = cleanStrategy({ name: "조건 전략", code: g.code, params: JSON.stringify(g.params), rebalance: "M", warmup: g.warmup, builder: { ...defaultSpec(), topK: 7 } });
    expect(saved.builder!.topK).toBe(7);
    expect(cleanStrategy({ name: "코드 전략", code: "return {};", params: "{}" }).builder).toBeUndefined();
  });
});
