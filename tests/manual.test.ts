import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataRequest, DataResponse } from "@/lib/data/server";
import type { Bar } from "@/lib/engine/types";
import { defaultCycleSpec } from "@/lib/strategies/cycle";
import type { SavedStrategy } from "@/lib/strategies/library";
import {
  applyTrade, brokerList, cleanAccount, estimateFee, forgetBroker, resetBasis, loadAccounts, loadManualLog, loadTrades, recordTrade, saveAccounts, undoLastTrade, type ManualAccount,
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

  it("총자산 조회값(원화·달러 예수금 포함)을 읽었으면 그것이 계좌 총액", () => {
    const v = kisViewOf({ env: "real", kr: { cash: 0, total: 100, holdings: [] }, us: { holdings: [{ code: "QQQ", name: "QQQ", qty: 1, avgPrice: 1, price: 1, value: 1 }], totalAsset: 5000 } }, { at: "", map: { QQQ: { close: 1400, date: today } }, fx: 1400 }, 0);
    expect(v.total).toBe(5000);
    expect(v.cash).toBe(3600);
    expect(v.partial).toBeUndefined();
  });
});

describe("증권사 목록·기준 다시 잡기", () => {
  it("한화투자증권이 있고, 직접 넣은 증권사는 목록에 남음", () => {
    expect(brokerList("owner", env)).toContain("한화투자증권");
    saveAccounts([account({ broker: "카카오페이증권" } as any)], "owner", env);
    const list = brokerList("owner", env);
    expect(list).toContain("카카오페이증권");
    expect(list.at(-1)).toBe("기타");
    // 계좌를 지워도 목록에는 남고, 지우기를 누르면 빠짐
    saveAccounts([], "owner", env);
    expect(brokerList("owner", env)).toContain("카카오페이증권");
    forgetBroker("카카오페이증권", "owner", env);
    expect(brokerList("owner", env)).not.toContain("카카오페이증권");
  });

  it("시작일=오늘, 운용 금액=지금 평가액(종가, 없으면 평균단가)", () => {
    const a = account({ cash: 500_000, positions: [{ ticker: "069500", qty: 10, avgPrice: 40000 }, { ticker: "005930", qty: 2, avgPrice: 70000 }], plan: { strategy: "saved:적립", tickers: "069500", budget: 5_000_000, startDate: "2026-01-02" } } as any);
    saveAccounts([a], "owner", env);
    const next = resetBasis("owner", a.id, "2026-11-17", (t) => (t === "069500" ? 50000 : undefined), env);
    expect(next.plan).toMatchObject({ startDate: "2026-11-17", budget: 500_000 + 500_000 + 140_000 });
    expect(loadAccounts("owner", env)[0].plan?.budget).toBe(1_140_000);
    // 보유·예수금은 그대로
    expect(loadAccounts("owner", env)[0].positions).toHaveLength(2);
    expect(() => resetBasis("owner", "없음", "2026-11-17", () => undefined, env)).toThrow(/찾지 못했/);
  });
});

it("보관함에서 지운 전략도 계좌를 고칠 때 그대로 이어 씀", () => {
  const a = account();
  const b = cleanAccount({ name: "토스", cash: 2_000_000, plan: { strategy: "saved:적립", tickers: "069500", budget: 1_000_000, startDate: today } }, a, "owner", today, []);
  expect(b.plan?.strategy?.name).toBe("적립");
  expect(b.cash).toBe(2_000_000);
  expect(() => cleanAccount({ name: "x", plan: { strategy: "saved:적립", tickers: "069500", budget: 1_000_000 } }, null, "owner", today, [])).toThrow(/보관함에 없습니다/);
});

describe("수동 계좌: 이미 있는 보유와 예수금", () => {
  const allIn: SavedStrategy = { name: "전부", code: "return { '069500': 1 }", params: "{}", rebalance: "D", stopLoss: "", takeProfit: "", warmup: 1 };
  const data = { "069500": bars(today, 300, () => 40_000) };
  const acct = (others?: "sell" | "keep") => cleanAccount({ name: "연금저축", cash: 100_000, others, positions: [{ ticker: "005930", name: "삼성전자", qty: 20, avgPrice: 70_000 }],
    plan: { strategy: "saved:전부", tickers: "069500", budget: 1_500_000, startDate: "2026-11-02" } }, null, "owner", today, [allIn]);

  it("전략 밖 보유는 팔아서 쓰고, 수량은 계좌 평가액 기준, 매수는 돈 안에서", async () => {
    const r = (await runManual(acct(), "manual", { load: loader(data), now: at(today, "18:00"), env }))!;
    expect(r.status).toBe("ok");
    expect(r.accountTotal).toBe(1_500_000);
    const sell = r.orders.find((o) => o.side === "sell")!;
    expect(sell).toMatchObject({ ticker: "005930", qty: 20, targetQty: 0 });
    const buy = r.orders.find((o) => o.side === "buy")!;
    // 1,500,000 ÷ 40,000 = 37주, 예수금 10만 + 매도 대금 약 139.6만 안
    expect(buy).toMatchObject({ ticker: "069500", qty: 37 });
    expect(r.orders[0].side).toBe("sell");
  });

  it("그대로 두기: 전략 밖 보유를 뺀 금액만 전략으로", async () => {
    const r = (await runManual(acct("keep"), "manual", { load: loader(data), now: at(today, "18:00"), env }))!;
    expect(r.orders.filter((o) => o.side === "sell")).toHaveLength(0);
    expect(r.orders[0]).toMatchObject({ ticker: "069500", side: "buy", qty: 2 });
    expect(r.warnings.join(" ")).toContain("그대로 두고");
  });

  it("돈이 모자라면 매수 수량을 줄임", async () => {
    const a = cleanAccount({ name: "x", cash: 200_000, plan: { strategy: "saved:전부", tickers: "069500", budget: 1_000_000, startDate: "2026-11-02" } }, null, "owner", today, [allIn]);
    // 기록한 평가액은 20만 원뿐 → 4주 (예전에는 운용 금액 100만 원 기준 25주를 안내)
    const r = (await runManual(a, "manual", { load: loader(data), now: at(today, "18:00"), env }))!;
    expect(r.orders[0]).toMatchObject({ side: "buy", qty: 4 });
  });
});

describe("수동 계좌: 목표 보유 기준", () => {
  it("신호가 없는 날도 전략상 목표 수량과 지금 잔고의 차이를 안내", async () => {
    const data = { "069500": bars(today, 300, () => 40_000) };
    // 11-03 에 적립 매수(5%)를 한 전략: 오늘은 신호 없음(유지). 계좌에는 10주가 있음
    const a = cleanAccount({ name: "x", cash: 600_000, positions: [{ ticker: "069500", qty: 10, avgPrice: 40_000 }],
      plan: { strategy: "saved:적립", tickers: "069500", budget: 1_000_000, startDate: "2026-11-02" } }, null, "owner", today, [cycleStrategy]);
    const r = (await runManual(a, "manual", { load: loader(data), now: at(today, "18:00"), env }))!;
    expect(r.status).toBe("ok");
    const t = r.targets!.find((x) => x.ticker === "069500")!;
    expect(t.curQty).toBe(10);
    expect(t.targetQty).toBe(1); // 평가액 100만 원 × 전략 비중 약 4% ÷ 4만 원
    expect(r.orders[0]).toMatchObject({ ticker: "069500", side: "sell", qty: 9, targetQty: 1 });
    expect(formatManual(a, r)).toContain("목표 보유");
  });
});

describe("한국투자증권 총자산", () => {
  it("모의 실서버 값: 총자산 338,839,665원(달러 예수금 포함)을 그대로", () => {
    const v = kisViewOf({ env: "mock", kr: { cash: 9_999_071, total: 9_999_071, holdings: [] }, us: { holdings: [{ code: "UPRO", name: "UPRO", qty: 57, avgPrice: 129.12, price: 125.76, value: 7168.13 }], totalAsset: 338_839_665, cashUsd: 92_566.56, fx: 1338.8 } }, null, 0);
    expect(v.total).toBe(338_839_665);
    expect(v.partial).toBeUndefined();
  });
  it("총자산을 못 읽으면 국내 총평가 + 미국 주식 어림값, partial 표시", () => {
    const v = kisViewOf({ env: "mock", kr: { cash: 9_999_071, total: 9_999_071, holdings: [] }, us: { holdings: [{ code: "UPRO", name: "UPRO", qty: 57, avgPrice: 129.12, price: 125.76, value: 7168.13 }], fx: 1338.8 } }, null, 0);
    expect(v.total).toBe(Math.round(9_999_071 + 57 * 125.76 * 1338.8));
    expect(v.partial).toBe(true);
    const kr = kisViewOf({ env: "mock", kr: { cash: 100, total: 100, holdings: [] } }, null, 0);
    expect(kr.partial).toBeUndefined();
  });
});
