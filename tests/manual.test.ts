import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataRequest, DataResponse } from "@/lib/data/server";
import type { Bar } from "@/lib/engine/types";
import { defaultCycleSpec } from "@/lib/strategies/cycle";
import type { SavedStrategy } from "@/lib/strategies/library";
import {
  applyTrade, cleanAccount, estimateFee, loadAccounts, loadManualLog, loadTrades, recordTrade, saveAccounts, undoLastTrade, type ManualAccount,
} from "@/lib/manual/store";
import { formatManual, manualEveningFor, runManual } from "@/lib/manual/evening";
import { addSnapshot, kisViewOf, loadHistory, refreshHistory, KIS_ID } from "@/lib/manual/value";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-manual-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);
function bars(end: string, n: number, fn: (i: number) => number): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse(end);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift({ date: d.toISOString().slice(0, 10), open: 0, high: 0, low: 0, close: 0, volume: 1000 });
    t -= 864e5;
  }
  out.forEach((b, i) => { const c = fn(i); Object.assign(b, { open: c, high: c * 1.01, low: c * 0.99, close: c }); });
  return out;
}
const loader = (data: Record<string, Bar[]>, fx?: number) => async (_q: DataRequest): Promise<DataResponse> =>
  ({ data, names: { "069500": "KODEX 200", "005930": "삼성전자" }, benchmark: null, warnings: [], ...(fx ? { fx: [{ date: "2026-11-16", close: fx }] } : {}) });

const cycleStrategy: SavedStrategy = { name: "적립", code: "return lib.cycle(ctx, p)", params: "{}", rebalance: "D", stopLoss: "", takeProfit: "", warmup: 1, cycle: defaultCycleSpec() };
const customStrategy: SavedStrategy = { name: "내 코드", code: "return {}", params: "{}", rebalance: "M", stopLoss: "", takeProfit: "", warmup: 1 };
const today = "2026-11-16";
const rates = { commission: 0.015, sellTax: 0.2, usCommission: 0.25, usFx: 0.1 };

const account = (over: Partial<ManualAccount> = {}): ManualAccount =>
  cleanAccount({ name: "토스", broker: "토스증권", cash: 1_000_000, positions: [], plan: { strategy: "saved:적립", tickers: "069500", budget: 1_000_000, startDate: today }, ...over }, null, "owner", today, [cycleStrategy]);

describe("수동 계좌 저장", () => {
  it("보유 종목을 합치고 0주는 뺌, 전략은 장중 매도 없이", () => {
    const a = cleanAccount({ name: " 토스 미국 ", broker: "토스증권", cash: "1,000,000", positions: [
      { ticker: "069500", qty: 10, avgPrice: 40000 }, { ticker: " 069500 ", qty: 10, avgPrice: 50000 }, { ticker: "005930", qty: 0, avgPrice: 1 },
    ], plan: { strategy: "saved:적립", tickers: "069500, QQQ", budget: 2_000_000, startDate: "2030-01-01" } }, null, "owner", today, [cycleStrategy]);
    expect(a.name).toBe("토스 미국");
    expect(a.cash).toBe(1_000_000);
    expect(a.positions).toEqual([{ ticker: "069500", qty: 20, avgPrice: 45000 }]);
    // 수동 계좌는 한국·미국 종목을 섞어도 됨
    expect(a.plan?.tickers).toEqual(["069500", "QQQ"]);
    expect(a.plan?.intraday).toBe(false);
    expect(a.plan?.startDate).toBe(today);
  });

  it("검사: 이름·수량·코드 전략 권한", () => {
    expect(() => cleanAccount({ name: "", cash: 0 }, null, "owner", today, [])).toThrow(/이름/);
    expect(() => cleanAccount({ name: "a", positions: [{ ticker: "069500", qty: 1.5, avgPrice: 1 }] }, null, "owner", today, [])).toThrow(/정수/);
    expect(() => cleanAccount({ name: "a", plan: { strategy: "saved:내 코드", budget: 1_000_000 } }, null, "kim", today, [customStrategy])).toThrow(/관리자/);
    // 전략 없이 계좌만
    expect(cleanAccount({ name: "a", plan: { strategy: "" } }, null, "kim", today, []).plan).toBeNull();
  });
});

describe("체결 기록", () => {
  it("매수는 평균단가·예수금, 매도는 수량·예수금을 바꾸고 되돌릴 수 있음", () => {
    saveAccounts([account({ positions: [{ ticker: "069500", qty: 10, avgPrice: 40000 }] } as any)], "owner", env);
    const id = loadAccounts("owner", env)[0].id;
    recordTrade("owner", id, { ticker: "069500", side: "buy", qty: 10, price: 50000, fee: 0 }, rates, today, env);
    let a = loadAccounts("owner", env)[0];
    expect(a.positions[0]).toMatchObject({ qty: 20, avgPrice: 45000 });
    expect(a.cash).toBe(500_000);
    // 수수료를 비우면 어림 (매도: 수수료 0.015% + 거래세 0.2%)
    const { trade } = recordTrade("owner", id, { ticker: "069500", side: "sell", qty: 5, price: 60000 }, rates, today, env);
    expect(trade.fee).toBe(estimateFee("069500", "sell", 300_000, rates));
    expect(trade.fee).toBe(645);
    a = loadAccounts("owner", env)[0];
    expect(a.positions[0]).toMatchObject({ qty: 15, avgPrice: 45000 });
    expect(a.cash).toBe(500_000 + 300_000 - 645);
    expect(() => recordTrade("owner", id, { ticker: "069500", side: "sell", qty: 99, price: 1 }, rates, today, env)).toThrow(/팔 수 없습니다/);
    // 되돌리기: 최근 것부터
    undoLastTrade("owner", id, env);
    undoLastTrade("owner", id, env);
    a = loadAccounts("owner", env)[0];
    expect(a.positions[0]).toMatchObject({ qty: 10, avgPrice: 40000 });
    expect(a.cash).toBe(1_000_000);
    expect(loadTrades("owner", env)).toHaveLength(0);
  });

  it("전부 팔면 보유에서 빠지고, 되돌리면 평균단가도 돌아옴", () => {
    const a = account({ positions: [{ ticker: "069500", qty: 3, avgPrice: 40000 }] } as any);
    const sold = applyTrade(a, { ticker: "069500", side: "sell", qty: 3, price: 41000, fee: 0 });
    expect(sold.positions).toHaveLength(0);
    saveAccounts([a], "owner", env);
    recordTrade("owner", a.id, { ticker: "069500", side: "sell", qty: 3, price: 41000, fee: 0 }, rates, today, env);
    undoLastTrade("owner", a.id, env);
    expect(loadAccounts("owner", env)[0].positions[0]).toMatchObject({ qty: 3, avgPrice: 40000 });
  });
});

describe("저녁 안내", () => {
  it("기록한 보유와 예수금 기준으로 다음 거래일 할 일을 계산", async () => {
    const data = { "069500": bars(today, 300, () => 40_000) };
    const a = account();
    const r = (await runManual(a, "manual", { load: loader(data), now: at(today, "18:00"), env }))!;
    expect(r.status).toBe("ok");
    expect(r.account).toBe("manual");
    expect(r.holdingsFrom).toBe("account");
    expect(r.intraday).toBe(false);
    expect(r.accountTotal).toBe(1_000_000);
    expect(r.orders[0]).toMatchObject({ ticker: "069500", side: "buy", qty: 1, curQty: 0 });
    const text = formatManual(a, r);
    expect(text).toContain("직접 주문할 것 1건");
    expect(text).toContain("매수 KODEX 200 1주");
    expect(text).toContain("체결을 기록");
    // 이미 1주 샀다고 기록했으면 살 것이 없음
    const b = applyTrade(a, { ticker: "069500", side: "buy", qty: 1, price: 40000, fee: 0 });
    const r2 = (await runManual(b, "manual", { load: loader(data), now: at(today, "18:00"), env }))!;
    expect(r2.orders).toHaveLength(0);
    expect(r2.accountTotal).toBe(1_000_000);
  });

  it("계좌마다 다른 전략: 켜 둔 계좌만 저녁에 계산·기록", async () => {
    const data = { "069500": bars(today, 300, () => 40_000) };
    const a = account();
    const off = { ...account({ name: "미래에셋" } as any), id: "b2", plan: { ...account().plan!, enabled: false } };
    const none = { ...account({ name: "기록만", plan: null } as any), id: "c3" };
    saveAccounts([a, off, none], "owner", env);
    const m = await manualEveningFor("owner", "schedule", { e: env, load: loader(data), now: at(today, "18:00"), notify: false });
    expect(m.ok).toBe(1);
    expect(Object.keys(m.reports)).toEqual([a.id]);
    expect(loadManualLog("owner", env)[a.id]).toHaveLength(1);
    // 직접 계산은 꺼진 계좌도
    const m2 = await manualEveningFor("owner", "manual", { e: env, load: loader(data), now: at(today, "18:00"), notify: false, only: "b2" });
    expect(Object.keys(m2.reports)).toEqual(["b2"]);
  });
});

describe("대시보드 기록", () => {
  it("하루 한 점, 같은 날은 바꾸되 전략 평가액은 유지", () => {
    let l = addSnapshot([], { date: "2026-11-16", total: 1, cash: 1, stock: 0, cost: 0, strategy: 5 });
    l = addSnapshot(l, { date: "2026-11-16", total: 2, cash: 2, stock: 0, cost: 0 });
    l = addSnapshot(l, { date: "2026-11-13", total: 3, cash: 3, stock: 0, cost: 0 });
    expect(l.map((x) => x.date)).toEqual(["2026-11-13", "2026-11-16"]);
    expect(l[1]).toMatchObject({ total: 2, strategy: 5 });
  });

  it("수동 계좌는 종가로, 한국투자증권은 미국 보유를 원화로 바꿔 함께 기록", async () => {
    const a = account({ positions: [{ ticker: "069500", qty: 10, avgPrice: 40000 }] } as any);
    saveAccounts([a], "owner", env);
    const data = { "069500": bars(today, 10, () => 45_000), QQQ: bars(today, 10, () => 700_000) };
    const r = await refreshHistory("owner", {
      e: env, load: loader(data, 1400), now: at(today, "19:00"), strategy: { [a.id]: 1_010_000 },
      kis: async () => ({ env: "mock", kr: { cash: 100_000, total: 600_000, holdings: [{ code: "005930", name: "삼성전자", qty: 10, avgPrice: 45_000, price: 50_000, value: 500_000 }] }, us: { holdings: [{ code: "QQQ", name: "QQQ", qty: 2, avgPrice: 450, price: 500, value: 1000 }] } }),
    });
    expect(r.warnings).toEqual([]);
    const h = loadHistory("owner", env);
    expect(h.points[a.id][0]).toMatchObject({ date: today, total: 1_000_000 - 0 + 10 * 45_000, cash: 1_000_000, cost: 400_000, strategy: 1_010_000 });
    expect(h.kis?.total).toBe(600_000 + 2 * 700_000);
    expect(h.kis?.positions.find((p) => p.ticker === "QQQ")).toMatchObject({ value: 1_400_000, avgPrice: 450 * 1400 });
    expect(h.points[KIS_ID][0].total).toBe(2_000_000);
  });

  it("시세·잔고를 못 받아도 평균단가로 기록하고 경고", async () => {
    saveAccounts([account({ positions: [{ ticker: "069500", qty: 1, avgPrice: 40000 }] } as any)], "owner", env);
    const r = await refreshHistory("owner", { e: env, load: async () => { throw new Error("네트워크"); }, kis: async () => { throw new Error("키 오류"); }, now: at(today, "19:00") });
    expect(r.warnings.join(" ")).toMatch(/잔고를 읽지 못했습니다.*/);
    expect(r.warnings.join(" ")).toContain("평균단가");
    const h = loadHistory("owner", env);
    expect(Object.values(h.points)[0][0].total).toBe(1_040_000);
    expect(h.points[KIS_ID]).toBeUndefined();
  });

  it("해외 포함 총자산을 읽었으면 그걸 계좌 총액으로", () => {
    const v = kisViewOf({ env: "real", kr: { cash: 0, total: 100, holdings: [] }, us: { holdings: [{ code: "QQQ", name: "QQQ", qty: 1, avgPrice: 1, price: 1, value: 1 }], totalAsset: 5000 } }, { at: "", map: { QQQ: { close: 1400, date: today } }, fx: 1400 }, 0);
    expect(v.total).toBe(5000);
    expect(v.cash).toBe(3600);
  });
});
