import { describe, expect, it } from "vitest";
import { runBacktest } from "@/lib/engine/engine";
import { dividendTaxFn } from "@/lib/engine/dividends";
import type { Bar } from "@/lib/engine/types";
import { cleanResult, runIsolated, type SandboxJob } from "@/lib/sandbox/run";
import { runStrategyCode } from "@/lib/sandbox";
import { compileStrategy, STRATEGIES } from "@/lib/strategies";
import { runEvening } from "@/lib/auto/evening";
import { cleanPlan } from "@/lib/auto/store";

function bars(n: number, fn: (i: number) => number): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse("2020-01-01");
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) { const c = fn(out.length); out.push({ date: d.toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }); }
    t += 864e5;
  }
  return out;
}
const data = { "069500": bars(400, (i) => 10_000 + i * 10), "005930": bars(400, (i) => 50_000 + Math.sin(i / 9) * 3000) };
const opts = { data, settings: { rebalance: "M" as const, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: 60 }, initialCash: 10_000_000 };
const job = (code: string, params = {}): SandboxJob => ({ opts, taxKr: 0.154, code, params });

describe("전략 코드 격리 실행", () => {
  it("기본 전략 코드를 격리 공간에서 돌려도 본체와 같은 결과", async () => {
    const b = STRATEGIES.find((s) => s.id === "momentum")!;
    const p = { ...Object.fromEntries(b.params.map((x) => [x.key, x.default])), marketMa: 0, lookback: 40, skip: 0, minValueEok: 0 };
    const fn = compileStrategy(b.code);
    const here = runBacktest({ ...opts, dividendTax: dividendTaxFn(0.154), strategy: (ctx) => fn(ctx, p) });
    const there = await runIsolated(job(b.code, p));
    expect(there.equity.at(-1)!.equity).toBeCloseTo(here.equity.at(-1)!.equity, 6);
    expect(there.trades.length).toBe(here.trades.length);
    expect(there.signal?.picks).toEqual(here.signal?.picks);
  });

  it("서버 자원에 닿을 수 없음", async () => {
    const probe = `ctx.state.r = [typeof process, typeof require, typeof fetch, typeof module, typeof setTimeout,
      (() => { try { return typeof ctx.constructor.constructor("return process")(); } catch (e) { return "err"; } })(),
      (() => { try { return typeof Function("return this")().process; } catch (e) { return "err"; } })()].join(","); return {};`;
    const r = await runIsolated(job(probe));
    expect(String(r.state?.r).split(",").every((x) => x === "undefined" || x === "err")).toBe(true);
  });

  it("끝나지 않는 코드·메모리 폭탄은 멈춤", async () => {
    await expect(runIsolated(job("while (true) {}"), { timeoutMs: 1000, memoryMb: 64 })).rejects.toThrow(/초 안에/);
    await expect(runIsolated(job("const a = []; while (true) a.push(new Array(1e6).fill(1));"), { timeoutMs: 20_000, memoryMb: 64 })).rejects.toThrow(/메모리|초 안에/);
  }, 30_000);

  it("결과는 다시 검사: 모르는 종목·말이 안 되는 수량은 거부", () => {
    const ok = { equity: [{ date: "2020-01-01", equity: 100, cash: 100, invested: 0, benchmark: null }], trades: [], finalPositions: [], signal: null };
    expect(cleanResult(ok, job("")).equity[0].equity).toBe(100);
    expect(() => cleanResult({ ...ok, finalPositions: [{ ticker: "HACK", qty: 1, avgPrice: 1, value: 1 }] }, job(""))).toThrow(/모르는 종목/);
    expect(() => cleanResult({ ...ok, finalPositions: [{ ticker: "069500", qty: 1e9, avgPrice: 1, value: 1e9 }] }, job(""))).toThrow(/평가액보다/);
    expect(() => cleanResult({ ...ok, signal: { date: "x", kept: false, picks: [{ ticker: "069500", weight: 5, close: 1 }] } }, job(""))).toThrow(/비중/);
    const r = cleanResult({ ...ok, extra: () => 1, equity: [{ ...ok.equity[0], evil: "x" }] }, job(""));
    expect(Object.keys(r.equity[0])).not.toContain("evil");
    expect(Object.keys(r)).not.toContain("extra");
  });

  it("실행기 컨테이너가 없으면 본체 안 격리 공간에서 실행", async () => {
    const r = await runStrategyCode(job("return { '069500': 1 };"));
    expect(r.finalPositions[0]?.ticker).toBe("069500");
  });

  it("가족 계정의 코드 전략도 저녁 계산은 격리 공간에서", async () => {
    const s = { name: "내 코드", code: "globalThis.__ran = 1; return { '069500': 1 };", params: "{}", rebalance: "M" as const, stopLoss: "", takeProfit: "", warmup: 1 };
    const plan = cleanPlan({ strategy: "saved:내 코드", tickers: "069500", budget: 1_000_000, startDate: "2020-03-02" }, "mom", "2026-11-24", [s]);
    const last = data["069500"].at(-1)!.date;
    const r = await runEvening(plan, "manual", { load: async () => ({ data: { "069500": data["069500"] }, names: {}, benchmark: null, warnings: [] }), now: Date.parse(`${last}T18:00:00+09:00`), env: { ALPHY_CONFIG_DIR: "/nonexistent" } });
    expect(r.status).toBe("ok");
    expect(r.targets?.[0]?.ticker).toBe("069500");
    expect((globalThis as any).__ran).toBeUndefined();
  });
});
