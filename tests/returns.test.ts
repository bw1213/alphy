import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountReturns, combinedReturns, since } from "@/lib/manual/returns";
import { saveAccounts, type ManualAccount } from "@/lib/manual/store";
import { addFlow, deleteFlow, loadHistory, recordEdit, refreshHistory, saveHistory } from "@/lib/manual/value";

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
