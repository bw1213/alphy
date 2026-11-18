import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dueOnLastDay } from "@/lib/engine/engine";
import { runEvening } from "@/lib/auto/evening";
import type { AutoPlan } from "@/lib/auto/store";
import type { DataRequest, DataResponse } from "@/lib/data/server";
import type { Bar } from "@/lib/engine/types";
import type { SavedStrategy } from "@/lib/strategies/library";
import { runBacktest } from "@/lib/engine/engine";
import { STRATEGIES } from "@/lib/strategies";

/** 평일 날짜들 (from~to) */
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); }
  return out;
};

describe("리밸런싱 주기상 마지막 날이 매매할 날인지", () => {
  it("매일은 항상, 매월은 다음 평일이 새 달인 날만", () => {
    expect(dueOnLastDay(days("2026-10-01", "2026-11-17"), "D")).toBe(true);
    expect(dueOnLastDay(days("2026-10-01", "2026-11-17"), "M")).toBe(false);
    expect(dueOnLastDay(days("2026-10-01", "2026-10-30"), "M")).toBe(true); // 금요일, 다음 평일 11-02
    expect(dueOnLastDay(days("2026-10-01", "2026-11-17"), "W")).toBe(false); // 화요일
    expect(dueOnLastDay(days("2026-10-01", "2026-11-20"), "W")).toBe(true); // 금요일
    expect(dueOnLastDay(days("2026-10-01", "2026-12-31"), "Q")).toBe(true);
    expect(dueOnLastDay(days("2026-10-01", "2026-11-30"), "Q")).toBe(false);
  });

  it("휴일 때문에 기간 마지막 날을 놓쳤으면 새 기간 첫 거래일에 맞춤", () => {
    // 2026-10-30(금) 이 휴일이라 데이터는 10-29 다음이 11-02
    const ds = days("2026-10-01", "2026-11-02").filter((d) => d !== "2026-10-30");
    expect(dueOnLastDay(ds, "M")).toBe(true);
    // 놓치지 않았으면(10-30 이 있었으면) 11-02 는 매매할 날이 아님
    expect(dueOnLastDay(days("2026-10-01", "2026-11-02"), "M")).toBe(false);
  });
});

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-due-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("자동 매매 저녁 계산: 주기가 매일이 아닌 전략", () => {
  const today = "2026-11-17"; // 화요일
  const ds = days("2025-06-02", today);
  const mk = (k: number) => ds.map((date, i) => { const c = 10_000 * (1 + k * 0.001 * i); return { date, open: c, high: c, low: c, close: c, volume: 1000 }; });
  const data: Record<string, Bar[]> = { "000001": mk(1), "000002": mk(-0.3) };
  const load = async (_q: DataRequest): Promise<DataResponse> => ({ data, names: {}, benchmark: null, warnings: [] });
  // 매월 두 종목을 반반: 가격이 갈라져 매일 비중이 틀어짐
  const monthly: SavedStrategy = { name: "반반", code: "return { '000001': 0.5, '000002': 0.5 }", params: "{}", rebalance: "M", stopLoss: "", takeProfit: "", warmup: 1 };
  const plan: AutoPlan = { strategy: monthly, label: "반반", tickers: ["000001", "000002"], budget: 10_000_000, startDate: "2025-09-01", enabled: true, updatedAt: "" };

  it("월중에는 비중이 틀어져도 주문을 내지 않음", async () => {
    const r = await runEvening(plan, "manual", { load, now: Date.parse(`${today}T18:00:00+09:00`), env });
    expect(r.status).toBe("ok");
    expect(r.kept).toBe(true);
    expect(r.orders).toHaveLength(0);
  });

  it("달의 마지막 거래일에는 비중을 다시 맞춤", async () => {
    const end = "2026-10-30";
    const cut = Object.fromEntries(Object.entries(data).map(([t, b]) => [t, b.filter((x) => x.date <= end)]));
    const r = await runEvening(plan, "manual", { load: async () => ({ data: cut, names: {}, benchmark: null, warnings: [] }), now: Date.parse(`${end}T18:00:00+09:00`), env });
    expect(r.kept).toBe(false);
    expect(r.orders.length).toBeGreaterThan(0);
  });
});

describe("비중 고정 3종목", () => {
  it("정한 비율 30·50·20 으로 사고, 분기마다만 매매", () => {
    const def = STRATEGIES.find((s) => s.id === "cc_mix")!;
    const p = Object.fromEntries(def.params.map((x) => [x.key, x.default]));
    const ds2 = days("2025-01-02", "2025-12-31");
    const mk = (k: number) => ds2.map((date, i) => { const c = 10_000 * (1 + k * 0.001 * i); return { date, open: c, high: c, low: c, close: c, volume: 1000 }; });
    const res = runBacktest({ data: { "AAA": mk(1), "BBB": mk(0.5), "CCC": mk(0.1) }, strategy: (c) => def.targetWeights(c, p),
      settings: { rebalance: def.rebalance, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: def.warmup(p) }, costs: { commission: 0, slippage: 0, sellTax: 0 }, initialCash: 1e8 });
    const first = res.trades.filter((t) => t.date === res.trades[0].date);
    const amt = (t: string) => first.filter((x) => x.ticker === t).reduce((a, x) => a + x.qty * x.price, 0) / 1e8;
    expect(amt("AAA")).toBeCloseTo(0.3, 2);
    expect(amt("BBB")).toBeCloseTo(0.5, 2);
    expect(amt("CCC")).toBeCloseTo(0.2, 2);
    const tradeDays = new Set(res.trades.map((t) => t.date));
    expect(tradeDays.size).toBeLessThanOrEqual(4);
  });
});
