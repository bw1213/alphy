import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedDaily, sameHistory } from "@/lib/data/server";
import { parseMarketSumHtml } from "@/lib/data/naver";
import type { Bar } from "@/lib/engine/types";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-data-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bar = (date: string, close = 100): Bar => ({ date, open: close, high: close, low: close, close, volume: 1 });
/** 평일만, start 이후 */
function series(start: string, end: string, close = 100): Bar[] {
  const out: Bar[] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) out.push(bar(d.toISOString().slice(0, 10), close));
  }
  return out;
}
const todayIso = () => new Date().toISOString().slice(0, 10);

describe("일봉 캐시", () => {
  it("짧은 기간을 받은 뒤 더 긴 기간을 요청하면 다시 받는다 (기간 잘림 방지)", async () => {
    const calls: string[] = [];
    const fetcher = async (_: string, start: string) => { calls.push(start); return series(start, todayIso()); };
    const a = await cachedDaily("005930", "2023-01-02", "naver", fetcher, dir);
    expect(a[0].date).toBe("2023-01-02");
    const b = await cachedDaily("005930", "2016-01-04", "naver", fetcher, dir);
    expect(b[0].date).toBe("2016-01-04");
    // 같은 날 같은(또는 더 짧은) 기간은 캐시 사용
    await cachedDaily("005930", "2020-01-01", "naver", fetcher, dir);
    expect(calls).toEqual(["2023-01-02", "2016-01-04"]);
  });
  it("신규상장 종목(첫 날짜가 요청 시작일보다 늦음)은 다시 받지 않는다", async () => {
    let n = 0;
    const fetcher = async () => { n++; return series("2025-03-03", todayIso()); };
    await cachedDaily("123450", "2016-01-04", "naver", fetcher, dir);
    await cachedDaily("123450", "2016-01-04", "naver", fetcher, dir);
    expect(n).toBe(1);
  });
  it("예전 캐시는 마지막 날짜 근처부터만 받아 이어 붙이고, 수정주가가 바뀌었으면 전체를 다시 받는다", async () => {
    const { promises: fs } = await import("fs");
    const file = path.join(dir, "kis", "005930.json");
    const old = series("2024-01-01", "2024-06-28");
    const write = async () => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify({ fetched: "2024-06-28", from: "2024-01-01", bars: old })); };

    await write();
    let calls: string[] = [];
    const same = async (_: string, start: string) => { calls.push(start); return series(start, "2024-07-31"); };
    const merged = await cachedDaily("005930", "2024-01-01", "kis", same, dir);
    expect(calls).toEqual(["2024-06-18"]); // 마지막 날짜 10일 전부터만
    expect(merged[0].date).toBe("2024-01-01");
    expect(merged[merged.length - 1].date).toBe("2024-07-31");
    expect(new Set(merged.map((b) => b.date)).size).toBe(merged.length);

    await write();
    calls = [];
    const split = async (_: string, start: string) => { calls.push(start); return series(start, "2024-07-31", 50); }; // 액면분할로 과거 가격이 절반
    const full = await cachedDaily("005930", "2024-01-01", "kis", split, dir);
    expect(calls).toEqual(["2024-06-18", "2024-01-01"]);
    expect(full.every((b) => b.close === 50)).toBe(true);
  });
  it("sameHistory: 겹치는 날이 없으면 이어 붙이지 않는다", () => {
    expect(sameHistory([bar("2024-01-02")], [bar("2024-01-03")])).toBe(false);
    expect(sameHistory([bar("2024-01-02")], [bar("2024-01-02"), bar("2024-01-03", 120)])).toBe(true);
  });
});

describe("종목코드", () => {
  it("영문이 섞인 6자리 코드도 인식", () => {
    const html = `<a href="/item/main.naver?code=0126Z0" class="tltle">새종목</a><a href="/item/main.naver?code=005930" class="tltle">삼성전자</a>`;
    expect(parseMarketSumHtml(html).map((x) => x.code)).toEqual(["0126Z0", "005930"]);
  });
});
