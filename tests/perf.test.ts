import { describe, expect, it } from "vitest";
import { accountLoss, addPoint, perfFor, rebase, summarize, type PerfFile } from "@/lib/auto/perf";
import { keepRealConfirm, type AutoPlan } from "@/lib/auto/store";
import { morningStart } from "@/lib/auto/morning";

const plan: AutoPlan = { builtin: "momentum", label: "모멘텀", tickers: ["A"], budget: 1_000_000, startDate: "2026-11-01", enabled: true, updatedAt: "" };

describe("매일 성과 기록", () => {
  it("첫날 계좌 평가액이 기준, 그 뒤 차이가 손익", () => {
    let f: PerfFile = perfFor(null, plan, "mock");
    f = addPoint(f, { date: "2026-11-02", total: 10_000_000, cash: 10_000_000, stock: 0, strategy: 1_000_000 });
    f = addPoint(f, { date: "2026-11-03", total: 10_030_000, cash: 9_000_000, stock: 1_030_000, strategy: 1_020_000 });
    expect(f.base).toEqual({ date: "2026-11-02", total: 10_000_000 });
    expect(f.points.map((p) => p.pnl)).toEqual([0, 30_000]);
    const s = summarize(f)!;
    expect(s.pnlPct).toBeCloseTo(3);
    expect(s.strategyPct).toBeCloseTo(2);
    expect(s.gap).toBeCloseTo(1);
    // 같은 날 다시 계산하면 그날 줄만 바뀜
    f = addPoint(f, { date: "2026-11-03", total: 10_010_000, strategy: 1_020_000 });
    expect(f.points).toHaveLength(2);
    expect(f.points[1].pnl).toBe(10_000);
    expect(accountLoss(f, 9_800_000, plan.budget)).toBeCloseTo(20);
  });
  it("계좌를 못 읽은 날은 전략만 기록, 운용이 바뀌면 새로 시작", () => {
    let f = addPoint(perfFor(null, plan, "mock"), { date: "2026-11-02", strategy: 1_000_000 });
    expect(f.base).toBeUndefined();
    expect(summarize(f)!.pnl).toBeUndefined();
    f = addPoint(f, { date: "2026-11-03", total: 5_000_000, strategy: 1_000_000 });
    expect(perfFor(f, plan, "mock")).toBe(f);
    expect(perfFor(f, plan, "real").points).toHaveLength(0);
    expect(perfFor(f, { ...plan, budget: 2_000_000 }, "mock").points).toHaveLength(0);
  });
  it("기준 다시 잡기: 입금해도 손익은 그대로", () => {
    let f = addPoint(perfFor(null, plan, "mock"), { date: "2026-11-02", total: 10_000_000, strategy: 1_000_000 });
    f = addPoint(f, { date: "2026-11-03", total: 10_050_000, strategy: 1_000_000 });
    f = rebase(f, 15_050_000, "2026-11-04"); // 500만 원 입금
    f = addPoint(f, { date: "2026-11-04", total: 15_060_000, strategy: 1_000_000 });
    expect(f.points.at(-1)!.pnl).toBe(60_000);
  });
});

describe("실전 전환 확인", () => {
  const confirmed = { ...plan, realConfirmedAt: "2026-11-10T00:00:00Z" };
  it("같은 전략·종목이고 금액이 안 늘면 유지, 아니면 다시 확인", () => {
    expect(keepRealConfirm(confirmed, { ...plan, budget: 500_000 }).realConfirmedAt).toBeTruthy();
    expect(keepRealConfirm(confirmed, { ...plan, budget: 2_000_000 }).realConfirmedAt).toBeUndefined();
    expect(keepRealConfirm(confirmed, { ...plan, tickers: ["B"] }).realConfirmedAt).toBeUndefined();
    expect(keepRealConfirm(confirmed, { ...plan, builtin: "x", label: "다른" }).realConfirmedAt).toBeUndefined();
    expect(keepRealConfirm(plan, plan).realConfirmedAt).toBeUndefined();
  });
  it("실전 계좌인데 확인이 없으면 아침 주문을 내지 않음", async () => {
    const b: any = { env: "real", openDay: async () => null, balance: async () => { throw new Error("부르면 안 됨"); } };
    const d = await morningStart(plan, [], b, Date.parse("2026-11-17T08:40:00+09:00"));
    expect(d.phase).toBe("skipped");
    expect(d.reason).toMatch(/실전 전환/);
  });
});

describe("손익 처음부터", () => {
  it("지금 평가액을 손익 0 기준으로, 예전 계좌 손익은 지움", async () => {
    const { resetBase, summarize } = await import("@/lib/auto/perf");
    const f = { key: "k", budget: 1_000_000, base: { date: "2026-11-16", total: 500_000_000 }, points: [
      { date: "2026-11-16", strategy: 1_000_000, total: 500_000_000, cash: 0, stock: 0, pnl: 0 },
      { date: "2026-11-17", strategy: 1_010_000, total: 171_762_571, cash: 0, stock: 0, pnl: -328_237_429 },
    ] };
    const r = resetBase(f, 500_100_000, "2026-11-17");
    expect(r.base).toEqual({ date: "2026-11-17", total: 500_100_000 });
    expect(r.points.every((p) => p.pnl == null)).toBe(true);
    expect(summarize(r)?.pnl).toBeUndefined();
  });
});
