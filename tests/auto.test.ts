import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsAfterCloseRefresh } from "@/lib/data/server";
import type { DataRequest, DataResponse } from "@/lib/data/server";
import type { Bar } from "@/lib/engine/types";
import { formatReport, runEvening } from "@/lib/auto/evening";
import { appendLog, cleanPlan, loadLog, loadPlan, savePlan, type AutoPlan } from "@/lib/auto/store";
import { eveningDue } from "@/lib/auto/scheduler";
import { loadNotify, newLinkCode, notify, verifyLink } from "@/lib/auto/telegram";
import { cleanHm, kst } from "@/lib/auto/time";
import { defaultCycleSpec } from "@/lib/strategies/cycle";
import { updateSettings } from "@/lib/settings/store";
import type { SavedStrategy } from "@/lib/strategies/library";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-auto-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 한국 시간으로 그 날짜·시각의 ms */
const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);

/** end 까지 평일 n 일, 가격은 fn(i) */
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

const loader = (data: Record<string, Bar[]>) => async (_q: DataRequest): Promise<DataResponse> =>
  ({ data, names: { "069500": "KODEX 200" }, benchmark: null, warnings: [] });

const cycleStrategy: SavedStrategy = { name: "적립", code: "return lib.cycle(ctx, p)", params: "{}", rebalance: "D", stopLoss: "", takeProfit: "", warmup: 1, cycle: defaultCycleSpec() };
const customStrategy: SavedStrategy = { name: "내 코드", code: "return {}", params: "{}", rebalance: "M", stopLoss: "", takeProfit: "", warmup: 1 };

describe("시간·예약", () => {
  it("한국 시간 날짜와 요일", () => {
    expect(kst(at("2026-11-16", "08:30"))).toEqual({ date: "2026-11-16", hm: "08:30", dow: 1 });
    expect(cleanHm("9:05")).toBe("09:05");
    expect(cleanHm("25:00")).toBeNull();
  });

  it("평일 설정 시각 이후 하루 한 번, 실패하면 10분 뒤 3번까지", () => {
    const mon = "2026-11-16";
    expect(eveningDue(at(mon, "17:59"), {}, "18:00")).toBe(false);
    expect(eveningDue(at(mon, "18:00"), {}, "18:00")).toBe(true);
    expect(eveningDue(at("2026-11-15", "19:00"), {}, "18:00")).toBe(false); // 일요일
    const done = { evening: { date: mon, attempts: 1, lastTry: at(mon, "18:00"), done: true } };
    expect(eveningDue(at(mon, "20:00"), done, "18:00")).toBe(false);
    const failed = { evening: { date: mon, attempts: 1, lastTry: at(mon, "18:00"), done: false } };
    expect(eveningDue(at(mon, "18:05"), failed, "18:00")).toBe(false);
    expect(eveningDue(at(mon, "18:10"), failed, "18:00")).toBe(true);
    expect(eveningDue(at(mon, "20:00"), { evening: { ...failed.evening, attempts: 3 } }, "18:00")).toBe(false);
    // 다음 날은 새로
    expect(eveningDue(at("2026-11-17", "18:01"), done, "18:00")).toBe(true);
  });

  it("장 마감 전에 받은 시세 캐시는 마감 뒤 한 번 다시 받음", () => {
    const d = "2026-11-16";
    expect(needsAfterCloseRefresh(at(d, "10:00"), at(d, "18:00"))).toBe(true);
    expect(needsAfterCloseRefresh(at(d, "16:00"), at(d, "18:00"))).toBe(false);
    expect(needsAfterCloseRefresh(at(d, "10:00"), at(d, "14:00"))).toBe(false);
    expect(needsAfterCloseRefresh(undefined, at(d, "18:00"))).toBe(true);
  });
});

describe("운용 전략 저장", () => {
  const today = "2026-11-16";
  it("보관함 전략을 복사해 저장, 적립 전략은 종목 필요", () => {
    expect(() => cleanPlan({ strategy: "saved:적립", budget: 1_000_000 }, "owner", today, [cycleStrategy])).toThrow(/대상 종목/);
    const p = cleanPlan({ strategy: "saved:적립", tickers: "069500, 069500", budget: 1_000_000, startDate: "2030-01-01" }, "owner", today, [cycleStrategy]);
    expect(p.tickers).toEqual(["069500"]);
    expect(p.startDate).toBe(today); // 미래 날짜는 오늘로
    expect(p.strategy?.cycle).toBeTruthy();
    savePlan(p, "owner", env);
    expect(loadPlan("owner", env)?.label).toBe("적립");
  });

  it("직접 작성한 코드 전략은 owner 만", () => {
    expect(() => cleanPlan({ strategy: "saved:내 코드", budget: 1_000_000 }, "mom", today, [customStrategy])).toThrow(/관리자만/);
    expect(cleanPlan({ strategy: "saved:내 코드", budget: 1_000_000 }, "owner", today, [customStrategy]).label).toBe("내 코드");
  });

  it("기본 전략, 금액 검사", () => {
    expect(cleanPlan({ strategy: "builtin:momentum", budget: 5_000_000 }, "mom", today, []).builtin).toBe("momentum");
    expect(() => cleanPlan({ strategy: "builtin:momentum", budget: 1000 }, "mom", today, [])).toThrow(/10만 원/);
  });
});

describe("저녁 계산: 목표 보유에 맞춰 매매", () => {
  const today = "2026-11-18";
  const monthly: SavedStrategy = { name: "월 전부", code: "return { '069500': 1 };", params: "{}", rebalance: "M", stopLoss: "", takeProfit: "", warmup: 1 };
  const plan = (start: string): AutoPlan => ({ strategy: monthly, label: "월 전부", tickers: ["069500"], budget: 1_000_000, startDate: start, enabled: true, updatedAt: "", intraday: false });
  const data = { "069500": bars(today, 300, () => 40_000) };
  const held = (qty: number) => async () => ({ env: "mock" as const, holdings: qty ? [{ code: "069500", name: "KODEX 200", qty, avgPrice: 40_000, price: 40_000, value: qty * 40_000, pnl: 0, pnlRate: 0 }] : [] });

  it("월 전략도 운용 첫날 바로 비중대로 매수 (다음 달까지 현금으로 기다리지 않음)", async () => {
    const r = await runEvening(plan(today), "manual", { load: loader(data), now: at(today, "18:00"), env, holdings: held(0) });
    expect(r.orders[0]).toMatchObject({ ticker: "069500", side: "buy", curQty: 0 });
    expect(r.orders[0].qty).toBeGreaterThan(20);
  });

  it("매매할 날이 아니어도 실제 보유가 목표보다 적으면 모자란 만큼, 많으면 넘치는 만큼", async () => {
    const r = await runEvening(plan("2026-11-12"), "manual", { load: loader(data), now: at(today, "18:00"), env, holdings: held(10) });
    const tq = r.targets!.find((t) => t.ticker === "069500")!.targetQty;
    expect(tq).toBeGreaterThan(20);
    expect(r.orders).toEqual([expect.objectContaining({ ticker: "069500", side: "buy", qty: tq - 10, curQty: 10, targetQty: tq })]);
    const over = await runEvening(plan("2026-11-12"), "manual", { load: loader(data), now: at(today, "18:00"), env, holdings: held(tq + 5) });
    expect(over.orders).toEqual([expect.objectContaining({ side: "sell", qty: 5 })]);
    const same = await runEvening(plan("2026-11-12"), "manual", { load: loader(data), now: at(today, "18:00"), env, holdings: held(tq) });
    expect(same.orders).toHaveLength(0);
    expect(same.kept).toBe(true);
    // 차이가 평가액의 2%보다 작으면 넘어감 (백테스트와 같은 기준)
    const big = { ...plan("2026-11-12"), budget: 10_000_000 };
    const bq = (await runEvening(big, "manual", { load: loader(data), now: at(today, "18:00"), env, holdings: held(0) })).targets![0].targetQty;
    const small = await runEvening(big, "manual", { load: loader(data), now: at(today, "18:00"), env, holdings: held(bq - 4) });
    expect(small.orders).toHaveLength(0);
    expect(small.kept).toBe(true);
    const gap = await runEvening(big, "manual", { load: loader(data), now: at(today, "18:00"), env, holdings: held(bq - 6) });
    expect(gap.orders).toEqual([expect.objectContaining({ side: "buy", qty: 6 })]);
  });
});

describe("저녁 계산", () => {
  const today = "2026-11-16";
  const plan = (start: string): AutoPlan => ({ strategy: cycleStrategy, label: "적립", tickers: ["069500"], budget: 1_000_000, startDate: start, enabled: true, updatedAt: "" });

  it("첫날: 적립 매수 주문을 내일 아침 목록으로", async () => {
    const data = { "069500": bars(today, 300, () => 40_000) };
    const r = await runEvening(plan(today), "manual", { load: loader(data), now: at(today, "18:00"), env });
    expect(r.status).toBe("ok");
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ ticker: "069500", side: "buy", note: "적립 매수", curQty: 0 });
    expect(r.orders[0].qty).toBe(1); // 100만 원의 5% = 5만 원 → 4만 원짜리 1주
    expect(r.holdingsFrom).toBe("backtest");
    expect(formatReport(r)).toContain("매수 KODEX 200 (069500) 1주");
  });

  it("보유 중이면 하락 매도 가격을 알려 줌, 실제 계좌와 다르면 경고", async () => {
    // 한 달 전 시작, 가격은 오르다가 조금 내림 → 아직 매도 전
    const data = { "069500": bars(today, 300, (i) => (i < 280 ? 40_000 + i * 50 : 54_000 - (i - 280) * 20)) };
    const r = await runEvening(plan("2026-10-01"), "schedule", {
      load: loader(data), now: at(today, "18:00"), env,
      holdings: async () => ({ env: "mock", holdings: [] }),
    });
    expect(r.status).toBe("ok");
    expect(r.holdingsFrom).toBe("account");
    const lv = r.sellLevels.find((s) => s.kind === "drop")!;
    expect(lv).toBeTruthy();
    // 최고가(시작 이후) 대비 10% 아래
    expect(lv.price).toBeLessThan(lv.close);
    expect(lv.gap).toBeLessThan(0);
    expect(r.warnings.join(" ")).toContain("보유 수량이 다릅니다");
    // 장중 실시간 매도(기본 켬): 팔 수량까지, 추가 매도 단계 가격도 같이
    expect(r.intraday).toBe(true);
    expect(lv.qty).toBeGreaterThan(0);
    expect(formatReport(r)).toContain("바로 시장가로");
    // 끄면 알림용 가격 하나만 (수량 없음)
    const off = await runEvening({ ...plan("2026-10-01"), intraday: false }, "schedule", { load: loader(data), now: at(today, "18:00"), env });
    expect(off.intraday).toBe(false);
    expect(off.sellLevels.filter((s) => s.kind === "drop")).toHaveLength(1);
    expect(off.sellLevels[0].qty).toBeUndefined();
  });

  it("미국 종목: 전날 밤 시세로 계산해 오늘 밤 주문, 새 시세가 없으면 건너뜀", async () => {
    // 월요일 저녁(한국): 마지막 미국 시세는 금요일
    const data = { AAPL: bars("2026-11-13", 300, () => 280_000) };
    const usLoad = async (): Promise<DataResponse> => ({ data, names: { AAPL: "애플" }, benchmark: null, warnings: [], fx: [{ date: "2026-11-13", close: 1400 }] });
    const usPlan: AutoPlan = { ...plan(today), tickers: ["AAPL"], budget: 10_000_000 };
    const r = await runEvening(usPlan, "schedule", { load: usLoad, now: at(today, "18:00"), env });
    expect(r).toMatchObject({ status: "ok", market: "US", fx: 1400, dataDate: "2026-11-13" });
    expect(r.orders[0]).toMatchObject({ ticker: "AAPL", side: "buy" });
    expect(formatReport(r)).toContain("오늘 밤 미국 장 시작 주문");
    // 화요일 저녁인데 시세가 그대로(미국 휴장) → 같은 신호로 또 주문하지 않게 건너뜀
    const r2 = await runEvening(usPlan, "schedule", { load: usLoad, now: at("2026-11-17", "18:00"), env, prevDataDate: "2026-11-13" });
    expect(r2.status).toBe("holiday");
  });

  it("오늘 시세가 없으면 휴장으로 건너뜀", async () => {
    const data = { "069500": bars("2026-11-13", 300, () => 50_000) };
    const r = await runEvening(plan(today), "schedule", { load: loader(data), now: at(today, "18:00"), env });
    expect(r.status).toBe("holiday");
    expect(formatReport(r)).toContain("휴장");
  });

  it("오류는 기록으로 남김, 같은 날 같은 종류 기록은 바꿈", async () => {
    const r = await runEvening(plan(today), "manual", { load: async () => { throw new Error("네트워크"); }, now: at(today, "18:00"), env });
    expect(r.status).toBe("error");
    appendLog(r, "owner", env);
    appendLog({ ...r, status: "ok" }, "owner", env);
    appendLog({ ...r, trigger: "schedule" }, "owner", env);
    const log = loadLog("owner", env);
    expect(log).toHaveLength(2);
    expect(log.find((x) => x.trigger === "manual")?.status).toBe("ok");
  });
});

describe("텔레그램", () => {
  const TOKEN = "123456789:AAH" + "x".repeat(32);
  const fakeFetch = (updates: any[], sent: any[]) => (async (url: any, init: any) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: updates }));
    if (method === "sendMessage") { sent.push(body); return new Response(JSON.stringify({ ok: true, result: {} })); }
    return new Response(JSON.stringify({ ok: false, description: "nope" }));
  }) as typeof fetch;

  it("연결 코드를 보낸 대화방을 찾아 연결하고 알림을 보냄", async () => {
    updateSettings((s) => { s.auto.telegramToken = TOKEN; s.auto.telegramBot = "alphy_bot"; }, env);
    const sent: any[] = [];
    expect(await notify("owner", "x", env, fakeFetch([], sent))).toBe(false); // 아직 연결 안 됨
    const code = newLinkCode("owner", env);
    await expect(verifyLink("owner", env, fakeFetch([], sent))).rejects.toThrow(/못 찾았습니다/);
    const ups = [{ message: { text: `/start ${code}`, chat: { id: 777, first_name: "영선" } } }, { message: { text: "/start alphy-other", chat: { id: 888 } } }];
    const n = await verifyLink("owner", env, fakeFetch(ups, sent));
    expect(n.chatId).toBe(777);
    expect(loadNotify("owner", env).code).toBeUndefined();
    expect(await notify("owner", "안녕", env, fakeFetch([], sent))).toBe(true);
    expect(sent.at(-1)).toMatchObject({ chat_id: 777, text: "안녕" });
  });

  it("코드는 30분 지나면 무효", async () => {
    updateSettings((s) => { s.auto.telegramToken = TOKEN; }, env);
    newLinkCode("owner", env, Date.now() - 31 * 60_000);
    await expect(verifyLink("owner", env, fakeFetch([], []))).rejects.toThrow(/30분/);
  });
});

describe("자동 매매 평가액: 실제 계좌와 전략 계산 구분", () => {
  const today = "2026-11-16";
  it("계좌 평가액(예수금·주식)을 먼저, 전략 계산값은 가상으로 표시. 평가 메모는 경고로", async () => {
    const data = { "069500": bars(today, 300, () => 40_000) };
    const plan: AutoPlan = { strategy: cycleStrategy, label: "적립", tickers: ["069500"], budget: 1_000_000, startDate: "2026-10-26", enabled: true, updatedAt: "" };
    const holdings = async () => ({ env: "mock" as const, holdings: [], total: 12_345_000, cash: 2_345_000, stock: 10_000_000, note: "미국 잔고를 읽지 못했습니다" });
    const r = await runEvening(plan, "schedule", { load: loader(data), now: at(today, "18:00"), env, holdings, accountBase: 12_000_000 });
    expect(r.accountTotal).toBe(12_345_000);
    expect(r.accountPnl).toBe(345_000);
    const text = formatReport(r);
    expect(text).toContain("계좌 평가액 12,345,000원 (예수금 2,345,000원 · 주식 10,000,000원)");
    expect(text).toContain("전략 계산 평가액(가상");
    expect(text.indexOf("계좌 평가액")).toBeLessThan(text.indexOf("전략 계산 평가액"));
    expect(r.warnings.some((w) => w.includes("미국 잔고를 읽지 못했습니다"))).toBe(true);
  });
});

describe("계정별 자동 매매 한도", () => {
  const today = "2026-11-16";
  it("실전 계좌면 운용 금액이 상한을 넘을 수 없음 (0 = 제한 없음)", () => {
    expect(() => cleanPlan({ strategy: "builtin:momentum", budget: 3_000_000 }, "mom", today, [], { cap: 1_000_000 })).toThrow(/실전 운용 금액 상한/);
    expect(cleanPlan({ strategy: "builtin:momentum", budget: 1_000_000 }, "mom", today, [], { cap: 1_000_000 }).budget).toBe(1_000_000);
    expect(cleanPlan({ strategy: "builtin:momentum", budget: 9_000_000 }, "mom", today, [], { cap: 0 }).budget).toBe(9_000_000);
    expect(cleanPlan({ strategy: "builtin:momentum", budget: 9_000_000 }, "mom", today, []).budget).toBe(9_000_000); // 모의투자
  });

  it("손실 한도에 닿으면 멈춤 표시와 알림 문구", async () => {
    // 시작 뒤 30% 하락: 적립 전략이 사 둔 만큼 손실. 한도를 아주 낮게(0.1%) 잡아 확인
    const data = { "069500": bars(today, 300, (i) => (i < 290 ? 40_000 : 40_000 - (i - 289) * 1200)) };
    const plan: AutoPlan = { strategy: cycleStrategy, label: "적립", tickers: ["069500"], budget: 1_000_000, startDate: "2026-10-26", enabled: true, updatedAt: "" };
    const r = await runEvening(plan, "schedule", { load: loader(data), now: at(today, "18:00"), env, maxLoss: 0.1 });
    expect(r.lossStop?.limit).toBe(0.1);
    expect(formatReport(r)).toContain("손실 한도 도달");
    const r2 = await runEvening(plan, "schedule", { load: loader(data), now: at(today, "18:00"), env, maxLoss: 0 });
    // 실제 계좌 손익이 있으면 그걸로 손실 한도를 봄
    const acct = (total: number) => async () => ({ env: "mock" as const, holdings: [], total, cash: total, stock: 0 });
    const r3 = await runEvening(plan, "schedule", { load: loader(data), now: at(today, "18:00"), env, maxLoss: 10, holdings: acct(9_850_000), accountBase: 10_000_000 });
    expect(r3.accountPnl).toBe(-150_000);
    expect(r3.lossStop).toMatchObject({ basis: "account", limit: 10 });
    expect(r3.lossStop!.loss).toBeCloseTo(15);
    const r4 = await runEvening(plan, "schedule", { load: loader(data), now: at(today, "18:00"), env, maxLoss: 10, holdings: acct(9_990_000), accountBase: 10_000_000 });
    expect(r4.lossStop).toBeUndefined();
    expect(r2.lossStop).toBeUndefined();
  });

  it("설정 화면 값 검사와 저장 (owner 는 서버 설정, 다른 사람은 본인 파일)", async () => {
    const { applyPatch, settingsView } = await import("@/lib/settings/view");
    const { loadSettings, saveSettings } = await import("@/lib/settings/store");
    const { autoLimitFor, memberSettings, saveUserKis } = await import("@/lib/kis/userkeys");
    expect(autoLimitFor("owner", env)).toEqual({ realBudget: 1_000_000, maxLoss: 15 });
    expect(() => applyPatch(loadSettings(env), { kis: { autoLimit: { maxLoss: 150 } } })).toThrow(/손실 한도/);
    saveSettings(applyPatch(loadSettings(env), { kis: { autoLimit: { realBudget: 2_000_000, maxLoss: 10 } } }), env);
    expect(autoLimitFor("owner", env)).toEqual({ realBudget: 2_000_000, maxLoss: 10 });
    expect(settingsView(loadSettings(env), env).autoLimit.maxLoss).toBe(10);
    saveUserKis("mom", applyPatch(memberSettings("mom", env), { kis: { autoLimit: { realBudget: 500_000 } } }).kis, env);
    expect(autoLimitFor("mom", env)).toEqual({ realBudget: 500_000, maxLoss: 15 });
    expect(autoLimitFor("owner", env).realBudget).toBe(2_000_000);
  });
});

describe("지난 기록 지우기", () => {
  it("운용 저장 전 저녁 기록과 끝난 주문·감시 기록만 지우고 진행 중인 것은 남김", async () => {
    const fs = await import("fs"); const os = await import("os"); const path = await import("path");
    const { clearOldRecords } = await import("@/lib/auto/clear");
    const { appendLog, loadLog } = await import("@/lib/auto/store");
    const { saveDay, loadDays } = await import("@/lib/auto/morning");
    const env = { ALPHY_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "alphy-clear-")) };
    const r = (runDate: string, ranAt: string, trigger: "schedule" | "manual") => ({ runDate, ranAt, trigger, status: "ok" as const, label: "a", orders: [], sellLevels: [], warnings: [] });
    appendLog(r("2026-11-17", "2026-11-17T09:00:00Z", "schedule"), "owner", env);
    appendLog(r("2026-11-18", "2026-11-18T09:00:00Z", "schedule"), "owner", env);
    saveDay({ date: "2026-11-17", label: "a", env: "mock", phase: "done", items: [], log: [] }, "owner", env);
    saveDay({ date: "2026-11-18", label: "a", env: "mock", market: "US", phase: "placed", items: [], log: [] }, "owner", env);
    const n = clearOldRecords("2026-11-18T02:48:00Z", "owner", env);
    expect(n).toMatchObject({ log: 1, days: 1 });
    expect(loadLog("owner", env).map((x) => x.runDate)).toEqual(["2026-11-18"]);
    expect(Object.keys(loadDays("owner", env))).toEqual(["2026-11-18:US"]);
  });
});
