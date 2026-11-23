import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountReturns, combinedReturns, since } from "@/lib/manual/returns";
import { loadAccounts, saveAccounts, type ManualAccount } from "@/lib/manual/store";
import { addFlow, deleteFlow, loadHistory, putFlow, recordEdit, refreshHistory, saveHistory } from "@/lib/manual/value";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-ret-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);
const iso = (date: string, hm: string) => new Date(at(date, hm)).toISOString();
const f = (date: string, amount: number, hm = "12:00") => ({ id: date + amount, date, amount, at: iso(date, hm) });

describe("누적 수익률", () => {
  it("입금은 수익에서 빼고 날마다 이어 곱함", () => {
    const pts = [{ date: "2026-11-16", total: 1000 }, { date: "2026-11-17", total: 1100 }, { date: "2026-11-18", total: 2100 }, { date: "2026-11-19", total: 2310 }];
    const r = accountReturns(pts, [f("2026-11-18", 1000)]);
    expect(r.map((p) => +p.ret.toFixed(4))).toEqual([0, 10, 10, 21]);
  });

  it("첫 기록 전 입금은 빼지 않고, 그날 기록 뒤 입금은 다음 기록에 붙음", () => {
    const pts = [{ date: "2026-11-16", total: 1000, at: iso("2026-11-16", "18:00") }, { date: "2026-11-17", total: 2000, at: iso("2026-11-17", "18:00") }];
    expect(accountReturns(pts, [f("2026-11-15", 500), f("2026-11-16", 1000, "20:00")]).at(-1)!.ret).toBeCloseTo(0);
  });

  it("합계: 나중에 생긴 계좌는 첫 평가액을 입금으로 봄", () => {
    const a = { points: [{ date: "2026-11-16", total: 1000 }, { date: "2026-11-17", total: 1100 }, { date: "2026-11-18", total: 1100 }], flows: [] };
    const b = { points: [{ date: "2026-11-17", total: 5000 }, { date: "2026-11-18", total: 5500 }], flows: [] };
    const r = combinedReturns([a, b]);
    expect(r.map((p) => +p.ret.toFixed(4))).toEqual([0, 10, +(((1.1 * 6600) / 6100 - 1) * 100).toFixed(4)]);
  });

  it("기간을 고르면 그 기간 첫 기록을 0%로", () => {
    const r = accountReturns([{ date: "2026-10-01", total: 100 }, { date: "2026-11-01", total: 110 }, { date: "2026-11-02", total: 121 }], []);
    expect(since(r, "2026-11-01").map((p) => +p.ret.toFixed(4))).toEqual([0, 10]);
  });
});

describe("입출금 기록", () => {
  const acct = (cash: number): ManualAccount => ({ id: "a1", name: "토스", broker: "토스증권", cash, positions: [], plan: null, createdAt: "", updatedAt: "" });

  it("수동 계좌 예수금을 고치면 차이가 입금으로 남고 오늘 기록도 바뀜", async () => {
    saveAccounts([acct(1000)], "owner", env);
    await refreshHistory("owner", { e: env, load: async () => { throw new Error("x"); }, now: at("2026-11-16", "19:00") });
    expect(recordEdit("owner", acct(1000), acct(1000), env, at("2026-11-17", "10:00"))).toBeNull();
    const flow = recordEdit("owner", acct(1000), acct(1500), env, at("2026-11-17", "11:00"));
    expect(flow).toMatchObject({ amount: 500, auto: true, date: "2026-11-17" });
    const h = loadHistory("owner", env);
    expect(h.points.a1.at(-1)).toMatchObject({ date: "2026-11-17", total: 1500 });
    expect(accountReturns(h.points.a1, h.flows!.a1).at(-1)!.ret).toBeCloseTo(0);
    deleteFlow("owner", flow!.id, env);
    expect(loadHistory("owner", env).flows!.a1).toEqual([]);
  });

  it("지난 날짜 입금은 그날 기록에 붙고, 지운 계좌 기록은 정리", async () => {
    saveHistory({ prices: null, points: { kis: [{ date: "2026-11-16", total: 1000, cash: 0, stock: 0, cost: 0 }, { date: "2026-11-17", total: 2000, cash: 0, stock: 0, cost: 0 }] }, kis: null }, "owner", env);
    addFlow("owner", "kis", { date: "2026-11-17", amount: 1000 }, env, at("2026-11-20", "10:00"));
    addFlow("owner", "gone", { date: "2026-11-17", amount: 1 }, env, at("2026-11-20", "10:00"));
    const h = loadHistory("owner", env);
    expect(accountReturns(h.points.kis, h.flows!.kis).at(-1)!.ret).toBeCloseTo(0);
    expect(() => addFlow("owner", "kis", { date: "2026-11-21", amount: 1 }, env, at("2026-11-20", "10:00"))).toThrow();
    await refreshHistory("owner", { e: env, now: at("2026-11-20", "19:00") });
    expect(Object.keys(loadHistory("owner", env).flows!)).toEqual(["kis"]);
  });

  it("수동 계좌 입금은 예수금에 더하고, 지난 날짜면 그 뒤 기록도 고쳐 수익률이 그대로", async () => {
    saveAccounts([acct(1000)], "owner", env);
    const noPx = async () => { throw new Error("x"); };
    await refreshHistory("owner", { e: env, load: noPx, now: at("2026-11-16", "19:00") });
    await refreshHistory("owner", { e: env, load: noPx, now: at("2026-11-17", "19:00") });
    const { flow, account } = putFlow("owner", "a1", { date: "2026-11-17", amount: 500 }, undefined, env, at("2026-11-18", "10:00"));
    expect(flow).toMatchObject({ amount: 500, cash: true });
    expect(account!.cash).toBe(1500);
    let h = loadHistory("owner", env);
    expect(h.points.a1.map((p) => p.total)).toEqual([1000, 1500, 1500]);
    expect(accountReturns(h.points.a1, h.flows!.a1).at(-1)!.ret).toBeCloseTo(0);

    putFlow("owner", "a1", { date: "2026-11-18", amount: -200, note: "생활비" }, flow.id, env, at("2026-11-18", "11:00"));
    expect(loadAccounts("owner", env)[0].cash).toBe(800);
    h = loadHistory("owner", env);
    expect(h.points.a1.map((p) => p.total)).toEqual([1000, 1000, 800]);
    expect(h.flows!.a1).toHaveLength(1);
    expect(accountReturns(h.points.a1, h.flows!.a1).at(-1)!.ret).toBeCloseTo(0);

    expect(() => putFlow("owner", "a1", { date: "2026-11-18", amount: -5000 }, undefined, env, at("2026-11-18", "12:00"))).toThrow(/예수금/);
    expect(deleteFlow("owner", h.flows!.a1[0].id, env, at("2026-11-18", "12:00"))!.cash).toBe(1000);
    h = loadHistory("owner", env);
    expect(h.flows!.a1).toEqual([]);
    expect(h.points.a1.map((p) => p.total)).toEqual([1000, 1000, 1000]);
  });

  it("한국투자증권·계좌 고침 기록은 고쳐도 예수금을 건드리지 않음", async () => {
    saveAccounts([acct(1000)], "owner", env);
    await refreshHistory("owner", { e: env, load: async () => { throw new Error("x"); }, now: at("2026-11-16", "19:00") });
    const auto = recordEdit("owner", acct(1000), acct(1300), env, at("2026-11-17", "11:00"))!;
    saveAccounts([acct(1300)], "owner", env);
    const r = putFlow("owner", "a1", { date: "2026-11-17", amount: 200 }, auto.id, env, at("2026-11-17", "12:00"));
    expect(r.account).toBeNull();
    expect(r.flow.auto).toBeUndefined();
    expect(loadAccounts("owner", env)[0].cash).toBe(1300);
    expect(putFlow("owner", "kis", { date: "2026-11-17", amount: 100 }, undefined, env, at("2026-11-17", "12:00")).flow.cash).toBeUndefined();
  });
});

describe("계좌 목록 하나", () => {
  it("수동 계좌를 평가액·누적 수익률·이동 주소와 함께, 한국투자증권 키가 없으면 빼고", async () => {
    const { listAccounts } = await import("@/lib/accounts/list");
    const a: ManualAccount = { id: "m1", name: "토스", broker: "토스증권", cash: 1100, positions: [], plan: null, createdAt: "", updatedAt: "" };
    saveAccounts([a], "owner", env);
    saveHistory({ prices: null, points: { m1: [{ date: "2026-11-16", total: 1000, cash: 1000, stock: 0, cost: 0 }, { date: "2026-11-17", total: 1100, cash: 1100, stock: 0, cost: 0 }] }, kis: null }, "owner", env);
    const list = listAccounts({ id: "owner" } as any, env);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "m1", mode: "manual", total: 1100, since: "2026-11-16", href: "/accounts?id=m1", plan: null });
    expect(list[0].ret).toBeCloseTo(10);
  });
});

describe("자동 매매 손익에서 입출금 빼기", () => {
  it("기준일 뒤 입출금만 손익에서 뺌", async () => {
    const { addPoint, flowsAfter } = await import("@/lib/auto/perf");
    let f = addPoint({ key: "k", budget: 1000, points: [] }, { date: "2026-11-16", total: 1000, strategy: 1000 });
    const flow = flowsAfter(f.base, [{ date: "2026-11-16", amount: 50 }, { date: "2026-11-18", amount: 500 }]);
    expect(flow).toBe(500);
    f = addPoint(f, { date: "2026-11-19", total: 1600, strategy: 1000, flow });
    expect(f.points.at(-1)!.pnl).toBe(100);
  });
});

describe("체결 기록 하나로", () => {
  it("자동 주문 체결(아침·장중)과 수동 체결을 날짜순으로 함께", async () => {
    const { allFills } = await import("@/lib/accounts/fills");
    const { saveDay } = await import("@/lib/auto/morning");
    const { saveIntradayDay } = await import("@/lib/auto/intraday");
    saveDay({ date: "2026-11-18", label: "x", market: "US", phase: "done", log: [], items: [
      { ticker: "AAA", name: "에이", side: "buy", planned: 2, qty: 2, status: "filled", filledQty: 2, avgPrice: 10.5, price: 10 },
      { ticker: "BBB", name: "비", side: "buy", planned: 1, qty: 1, status: "cancelled", filledQty: 0, avgPrice: 0, price: 5 },
    ] } as any, "owner", env);
    saveIntradayDay({ date: "2026-11-19", label: "x", levels: [], log: [], sells: [{ keys: [], ticker: "CCC", name: "씨", kind: "stop_loss", level: 1, seen: 1, qty: 3, status: "filled", filledQty: 3, avgPrice: 900, label: "", at: "10:00" }] } as any, "owner", env);
    const f = allFills("owner", env);
    expect(f.map((x) => [x.accountId, x.date, x.ticker, x.qty, x.source, x.market])).toEqual([
      ["kis", "2026-11-19", "CCC", 3, "intraday", "KR"],
      ["kis", "2026-11-18", "AAA", 2, "morning", "US"],
    ]);
  });
});

describe("저녁 알림 한 번에", () => {
  it("계좌 결과를 한 메시지로 묶고, 길면 나눔", async () => {
    const { packMessages } = await import("@/lib/auto/telegram");
    expect(packMessages(["가", "나"], "머리")).toEqual(["머리\n\n────────\n\n가\n\n────────\n\n나"]);
    const big = "x".repeat(3000);
    expect(packMessages([big, big], "머리").length).toBe(2);
    expect(packMessages(["y".repeat(5000)])[0].length).toBeLessThanOrEqual(4000);
  });
});
