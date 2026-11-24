import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLedger, cleanEntry, mergeSeries, parseLedgerText, splitFactor, type LedgerEntry } from "@/lib/accounts/ledger";
import { addEntries, deleteEntry, ledgerStatus, mergedHistory, rebuildAccount } from "@/lib/accounts/ledgerStore";
import { accountReturns, annualized, moneySummary, moneyWeighted, yearlyReturns } from "@/lib/manual/returns";
import { loadAccounts, saveAccounts } from "@/lib/manual/store";
import { loadHistory, saveHistory } from "@/lib/manual/value";

const rates = { commission: 0, sellTax: 0, usCommission: 0, usFx: 0 };
const ctx = { today: "2026-11-24", rates, find: (n: string) => (n === "삼성전자" ? { code: "005930", name: "삼성전자" } : null) };
let n = 0;
const E = (x: Partial<LedgerEntry>): LedgerEntry => ({ id: `e${++n}`, at: `2020-01-01T00:00:0${n % 10}.000Z`, date: "2020-01-02", kind: "deposit", ...x });

describe("과거 기록 읽기", () => {
  it("엑셀 표(제목 줄·탭)와 이름·코드·쉼표 금액·수수료+세금", () => {
    const text = "일자\t거래구분\t종목명\t수량\t단가\t거래금액\t수수료\t세금\n2019.03.04\t입금\t\t\t\t10,000,000\n2019/3/5\t주식매수\t삼성전자\t100\t45,000\t\t500\t0\n20190306\t매도\t삼성전자 (005930)\t10\t46,000\t\t100\t92\n2019-03-07\t뭐지\t\t\t\t1";
    const r = parseLedgerText(text, ctx);
    expect(r[0].entry).toMatchObject({ date: "2019-03-04", kind: "deposit", amount: 10_000_000 });
    expect(r[1].entry).toMatchObject({ date: "2019-03-05", kind: "buy", ticker: "005930", qty: 100, price: 45000, fee: 500 });
    expect(r[2].entry).toMatchObject({ kind: "sell", ticker: "005930", fee: 192 });
    expect(r[3].error).toMatch(/구분/);
  });

  it("제목 줄 없는 CSV, 따옴표 속 쉼표, 달러", () => {
    const r = parseLedgerText('2021-01-05,매수,AAPL,2,$130.5\n2021-02-01,배당,AAPL,,,"1,234"', ctx);
    expect(r[0].entry).toMatchObject({ kind: "buy", ticker: "AAPL", qty: 2, price: 130.5, currency: "USD" });
    expect(r[1].entry).toMatchObject({ kind: "dividend", amount: 1234, ticker: "AAPL" });
  });

  it("앞날·틀린 종목은 오류", () => {
    expect(() => cleanEntry({ date: "2027-01-01", kind: "입금", amount: 1 }, ctx)).toThrow(/앞으로/);
    expect(() => cleanEntry({ date: "2020-01-01", kind: "매수", ticker: "없는회사", qty: 1, price: 1 }, ctx)).toThrow(/찾지 못/);
  });
});

describe("과거 평가액 다시 만들기", () => {
  const px = { data: { "005930": [{ date: "2020-01-02", close: 1000 }, { date: "2020-01-03", close: 1100 }, { date: "2020-01-06", close: 1210 }] } };

  it("입금·매수·배당·매도로 그날그날 평가, 입금만 입출금", () => {
    const b = buildLedger([
      E({ date: "2020-01-02", kind: "deposit", amount: 10000 }),
      E({ date: "2020-01-02", kind: "buy", ticker: "005930", qty: 5, price: 1000, fee: 0 }),
      E({ date: "2020-01-03", kind: "dividend", amount: 100 }),
      E({ date: "2020-01-06", kind: "sell", ticker: "005930", qty: 5, price: 1210, fee: 50 }),
    ], "2020-01-06", px)!;
    expect(b.points.map((p) => p.total)).toEqual([10000, 10600, 11100]);
    expect(b.flows.map((f) => f.amount)).toEqual([10000]);
    expect(b.sums).toMatchObject({ deposit: 10000, dividend: 100, tradeFee: 50 });
    const r = accountReturns(b.points, b.flows);
    expect(r.at(-1)!.ret).toBeCloseTo(11);
  });

  it("액면분할 전 가격·수량은 시세에 맞춰 바꿈", () => {
    expect(splitFactor(50_000, 1000)).toBe(50);
    expect(splitFactor(1030, 1000)).toBe(1);
    const b = buildLedger([E({ date: "2020-01-02", kind: "deposit", amount: 100_000 }), E({ date: "2020-01-02", kind: "buy", ticker: "005930", qty: 2, price: 50_000, fee: 0 })], "2020-01-03", px)!;
    expect(b.points.at(-1)!.total).toBe(110_000);
    expect(b.warnings.join()).toMatch(/액면분할/);
  });

  it("가진 것보다 많이 팔면 모자란 수량은 입고로 봄, 입고는 그날 종가", () => {
    const b = buildLedger([E({ date: "2020-01-02", kind: "in", ticker: "005930", qty: 10 }), E({ date: "2020-01-03", kind: "sell", ticker: "005930", qty: 15, price: 1100, fee: 0 })], "2020-01-06", px)!;
    expect(b.flows.map((f) => f.amount)).toEqual([10000, 5500]);
    expect(b.points.at(-1)!.total).toBe(16500);
    expect(accountReturns(b.points, b.flows).at(-1)!.ret).toBeCloseTo(10);
  });

  it("달러 기록은 그날 환율로", () => {
    const b = buildLedger([E({ date: "2020-01-02", kind: "deposit", amount: 100, currency: "USD" })], "2020-01-03", { data: {}, fx: [{ date: "2020-01-01", close: 1200 }] })!;
    expect(b.points[0].total).toBe(120000);
  });

  it("앱 첫 기록과 이어 붙일 때 차이는 수익률에 안 넣음, 앱 첫 기록 전 입출금은 버림", () => {
    const built = buildLedger([E({ date: "2020-01-02", kind: "deposit", amount: 1000 }), E({ date: "2020-01-03", kind: "interest", amount: 1 })], "2020-01-06", { data: {} })!;
    built.points[1].total = 1100;
    built.points[2].total = 1210;
    const live = [{ date: "2020-01-06", total: 5000, cash: 0, stock: 0, cost: 0 }, { date: "2020-01-07", total: 5500, cash: 0, stock: 0, cost: 0 }];
    const m = mergeSeries(live, [{ id: "x", date: "2020-01-01", amount: 999, at: "2020-01-01T00:00:00.000Z" }], built);
    expect(m.join).toEqual({ date: "2020-01-06", past: 1210, live: 5000 });
    expect(accountReturns(m.points, m.flows).map((p) => +p.ret.toFixed(4))).toEqual([0, 10, 21, 33.1]);
  });
});

describe("수익률 요약", () => {
  const rows = accountReturns([{ date: "2020-01-01", total: 100 }, { date: "2020-12-31", total: 110 }, { date: "2021-06-30", total: 220 }, { date: "2021-12-31", total: 242 }], [{ id: "a", date: "2021-06-30", amount: 110, at: "2021-06-29T15:00:00.000Z" }]);
  it("연도별·연평균·넣은 돈·금액가중", () => {
    expect(yearlyReturns(rows).map((y) => [y.year, +y.ret.toFixed(2)])).toEqual([["2020", 10], ["2021", 10]]);
    expect(annualized(rows)).toBeCloseTo((Math.pow(1.21, 365 / 730) - 1) * 100, 1);
    expect(moneySummary(rows)).toEqual({ invested: 210, value: 242, profit: 32 });
    expect(moneyWeighted(rows)!).toBeCloseTo(12.03, 1);
  });
});

describe("과거 기록 저장", () => {
  let dir: string;
  let env: Record<string, string | undefined>;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-ledger-")); env = { ALPHY_CONFIG_DIR: dir }; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-11-20T03:00:00Z");

  it("앱 기록 시작 뒤엔 배당만 받아 예수금에 더하고, 같은 줄은 건너뜀, 지우면 되돌림", async () => {
    saveAccounts([{ id: "m1", name: "토스", broker: "토스증권", cash: 1000, positions: [], plan: null, createdAt: "", updatedAt: "" }], "owner", env);
    saveHistory({ prices: null, points: { m1: [{ date: "2026-11-17", total: 1000, cash: 1000, stock: 0, cost: 0 }, { date: "2026-11-19", total: 1000, cash: 1000, stock: 0, cost: 0 }] }, kis: null, flows: {} }, "owner", env);
    const r = addEntries("owner", "m1", [
      { date: "2026-01-02", kind: "deposit", amount: 900 },
      { date: "2026-11-18", kind: "dividend", amount: 50 },
      { date: "2026-11-18", kind: "buy", ticker: "005930", qty: 1, price: 10 },
    ], { manual: true, e: env, now });
    expect(r.added.length).toBe(2);
    expect(r.skipped[0].error).toMatch(/체결 기록/);
    expect(loadAccounts("owner", env)[0].cash).toBe(1050);
    expect(loadHistory("owner", env).points.m1.map((p) => p.total)).toEqual([1000, 1050, 1050]);
    expect(addEntries("owner", "m1", [{ date: "2026-01-02", kind: "deposit", amount: 900 }], { manual: true, e: env, now }).skipped[0].error).toMatch(/이미/);
    expect(ledgerStatus("owner", "m1", env, now).status).toMatchObject({ count: 1, stale: true, upTo: "2026-11-17" });

    await rebuildAccount("owner", "m1", { e: env, now, load: async () => ({ data: {} }) });
    expect(ledgerStatus("owner", "m1", env, now).status.stale).toBe(false);
    const m = mergedHistory("owner", loadHistory("owner", env), env);
    expect(m.points.m1[0].date).toBe("2026-01-02");
    expect(m.flows.m1.find((f) => f.id === "ledger-join")!.amount).toBe(100);

    deleteEntry("owner", "m1", r.added[1].id, { e: env, now });
    expect(loadAccounts("owner", env)[0].cash).toBe(1000);
  });
});
