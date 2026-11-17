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
    expect(formatReport(r)).toContain("매수 KODEX 200 1주");
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
