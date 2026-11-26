import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDistributionAdjusted, undoDistributionAdjust } from "@/lib/data/distAdjust";
import type { Bar, Dividend } from "@/lib/engine/types";

const dates = ["2025-01-27", "2025-01-28", "2025-01-30", "2025-01-31", "2025-02-27", "2025-02-28", "2025-04-28", "2025-04-29", "2025-04-30", "2025-05-30"];
const raw = [10_000, 10_100, 9_950, 10_050, 10_300, 10_200, 10_500, 10_200, 10_250, 10_400];
const divs: Dividend[] = [{ date: "2025-01-30", amount: 100 }, { date: "2025-04-29", amount: 300 }];
const bar = (date: string, c: number): Bar => ({ date, open: c, high: c, low: c, close: c, volume: 10 });

/** 네이버처럼 배당락일 전 가격에 (P − D) / P 를 곱한 수정주가 */
function naverAdjusted(): Bar[] {
  const f = raw.map(() => 1);
  for (const d of divs) {
    const i = dates.indexOf(d.date);
    const k = (raw[i - 1] - d.amount) / raw[i - 1];
    for (let j = 0; j < i; j++) f[j] *= k;
  }
  return dates.map((d, i) => bar(d, raw[i] * f[i]));
}

describe("분배금 반영 수정주가 되돌리기", () => {
  it("네이버 방식 수정주가를 원래 가격으로 되돌린다", () => {
    const back = undoDistributionAdjust(naverAdjusted(), divs);
    back.forEach((b, i) => expect(b.close).toBeCloseTo(raw[i], 6));
    expect(back[0].open).toBeCloseTo(raw[0], 6);
  });

  it("배당이 없으면 그대로", () => {
    const b = dates.map((d, i) => bar(d, raw[i]));
    expect(undoDistributionAdjust(b, [])).toBe(b);
  });

  it("원주가 월 종가와 비교해 분배금 반영 여부를 판단", () => {
    const monthly: Record<string, number> = {};
    dates.forEach((d, i) => { monthly[d.slice(0, 7)] = raw[i]; });
    const adj = naverAdjusted();
    expect(isDistributionAdjusted(adj, undoDistributionAdjust(adj, divs), monthly)).toBe(true);
    const plain = dates.map((d, i) => bar(d, raw[i]));
    expect(isDistributionAdjusted(plain, undoDistributionAdjust(plain, divs), monthly)).toBe(false);
    expect(isDistributionAdjusted(plain, plain, {})).toBeNull();
  });
});

describe("loadData: 국내 ETF 분배금 이중 반영 막기", () => {
  const cwd = process.cwd();
  afterEach(() => { process.chdir(cwd); vi.unstubAllGlobals(); vi.resetModules(); });

  async function load(dividends: boolean) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "alphy-dist-"));
    process.chdir(dir);
    const ds: string[] = [];
    for (const d = new Date("2024-01-02T00:00:00Z"); ds.length < 300; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) ds.push(d.toISOString().slice(0, 10));
    const ex = "2024-04-29", D = 300;
    // 원래 가격은 늘 10,000원, 네이버 수정주가는 배당락 전날까지 (P − D) / P 를 곱한 값 (끝 날짜 뒤의 분배금도 반영)
    const px = (d: string) => (d < ex ? 10_000 - D : 10_000);
    const xml = ds.map((d) => `<item data="${d.replace(/-/g, "")}|${px(d)}|${px(d)}|${px(d)}|${px(d)}|10" />`).join("");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("yahoo.com")) {
        const ev = { a: { amount: D, date: Date.parse(ex + "T00:00:00Z") / 1000 } };
        return new Response(JSON.stringify({ chart: { result: [{ meta: { gmtoffset: 0 }, events: { dividends: ev } }] } }));
      }
      return new Response(xml);
    }));
    try {
      vi.resetModules();
      const { loadData } = await import("@/lib/data/server");
      return await loadData({ source: "naver", start: "2024-01-02", end: "2024-03-29", tickers: ["069500", "005930"], dividends, indices: false }, { kisDividendCred: null });
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("ETF 는 끝 날짜 뒤 분배금까지 되돌려 원래 가격, 주식은 그대로", async () => {
    for (const dividends of [true, false]) {
      const r = await load(dividends);
      expect(r.data["069500"].every((b) => Math.abs(b.close - 10_000) < 1e-6)).toBe(true);
      expect(r.data["005930"][0].close).toBe(9_700);
      expect(r.warnings.join(" ")).toMatch(/069500: 시세에 분배금이 이미 들어 있어/);
      if (!dividends) expect(r.dividends).toBeUndefined();
    }
  }, 20000);
});
