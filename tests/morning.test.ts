import { describe, expect, it } from "vitest";
import { formatDay, morningFollow, morningStart, pickReport, stopDay, type Broker } from "@/lib/auto/morning";
import type { EveningReport } from "@/lib/auto/evening";
import type { AutoPlan } from "@/lib/auto/store";
import { parseDayOrders, type DayOrder } from "@/lib/kis/orders";

const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);
const TODAY = "2026-11-17";
const plan: AutoPlan = { builtin: "momentum", label: "모멘텀", tickers: [], budget: 3_000_000, startDate: "2026-11-01", enabled: true, updatedAt: "2026-11-10T00:00:00Z" };
const report = (orders: EveningReport["orders"], over: Partial<EveningReport> = {}): EveningReport => ({
  runDate: "2026-11-16", ranAt: "2026-11-16T09:00:00Z", trigger: "schedule", status: "ok", label: "모멘텀", orders, sellLevels: [], warnings: [], ...over,
});
const buy = (t: string, qty: number, price: number) => ({ ticker: t, name: `N${t}`, side: "buy" as const, qty, price, amount: qty * price, curQty: 0, targetQty: qty });
const sell = (t: string, qty: number, price: number) => ({ ticker: t, name: `N${t}`, side: "sell" as const, qty, price, amount: qty * price, curQty: qty, targetQty: 0 });

/** 가짜 증권사: 주문을 기억하고, fill() 로 체결시킴 */
function fake(opts: { cash: number; held?: Record<string, number>; env?: "real" | "mock"; open?: boolean | null; failPlace?: boolean }) {
  const orders: DayOrder[] = [];
  let n = 0;
  const calls: string[] = [];
  let cash = opts.cash;
  const b: Broker & { fill: (code: string, qty?: number, px?: number) => void; calls: string[] } = {
    env: opts.env ?? "mock", calls,
    balance: async () => ({ env: opts.env ?? "mock", holdings: Object.entries(opts.held ?? {}).map(([code, qty]) => ({ code, name: code, qty, avgPrice: 0, price: 0, value: 0, pnl: 0, pnlRate: 0 })), cash, stockValue: 0, totalValue: 0, pnl: 0 }),
    buyable: async () => cash,
    place: async (o) => {
      if (opts.failPlace) throw new Error("주문 거부");
      calls.push(`${o.side} ${o.code} ${o.qty}`);
      const no = String(++n).padStart(10, "0");
      orders.push({ orderNo: no, orgNo: "91252", code: o.code, name: o.code, side: o.side, qty: o.qty, filledQty: 0, openQty: o.qty, avgPrice: 0, price: 0, time: "084000", cancelled: false });
      return { env: opts.env ?? "mock", orderNo: no, orderTime: "084000", message: "ok", orgNo: "91252" };
    },
    orders: async () => orders.map((o) => ({ ...o })),
    cancel: async (o) => { calls.push(`cancel ${o.orderNo}`); const x = orders.find((y) => y.orderNo === o.orderNo)!; x.cancelled = true; x.openQty = 0; return "취소"; },
    openDay: async () => opts.open ?? null,
    fill: (code, qty, px = 10_000) => {
      const x = orders.find((y) => y.code === code)!;
      x.filledQty = qty ?? x.qty; x.openQty = x.qty - x.filledQty; x.avgPrice = px;
      if (x.side === "sell") cash += x.filledQty * px;
    },
  };
  return b;
}

describe("따를 저녁 계산 고르기", () => {
  it("오늘보다 앞선 가장 최근 정상 계산", () => {
    const log = [report([], { runDate: TODAY }), report([], { runDate: "2026-11-13" }), report([buy("A", 1, 1)])];
    expect(pickReport(log, plan, TODAY).report?.runDate).toBe("2026-11-16");
  });
  it("계산 뒤 전략이 바뀌었거나, 너무 오래됐거나, 손실 한도면 안 씀", () => {
    expect(pickReport([report([])], { ...plan, updatedAt: "2026-11-16T10:00:00Z" }, TODAY).reason).toMatch(/바뀌어/);
    expect(pickReport([report([], { runDate: "2026-11-10" })], plan, TODAY).reason).toMatch(/4일/);
    expect(pickReport([report([], { lossStop: { loss: 20, limit: 15 } })], plan, TODAY).reason).toMatch(/손실 한도/);
  });
});

describe("아침 주문", () => {
  it("현금이 충분하면 매도·매수를 같이, 매도는 보유 수량까지만", async () => {
    const b = fake({ cash: 1_000_000, held: { S: 3 } });
    const d = await morningStart(plan, [report([sell("S", 5, 10_000), buy("B", 10, 10_000)])], b, at(TODAY, "08:40"));
    expect(b.calls).toEqual(["sell S 3", "buy B 10"]);
    expect(d.phase).toBe("placed");
    expect(d.items[0].note).toContain("보유 3주만");
    expect(formatDay(d, false)).toContain("매수 NB 10주: 주문됨");
  });

  it("현금이 모자라면 매도 체결 뒤 남은 현금만큼 매수, 마감에 미체결 취소", async () => {
    const b = fake({ cash: 50_000, held: { S: 10 } });
    let d = await morningStart(plan, [report([sell("S", 10, 10_000), buy("B", 20, 10_000), buy("C", 5, 10_000)])], b, at(TODAY, "08:40"));
    expect(b.calls).toEqual(["sell S 10"]);
    expect(d.phase).toBe("buying");
    // 09:01: 매도 아직 → 기다림
    d = await morningFollow(d, b, at(TODAY, "09:01"), "10:00");
    expect(b.calls).toHaveLength(1);
    // 매도 체결 → 현금 5만 + 10만 = 15만 → B 는 1.03 여유 두고 14주, C 는 남은 돈으로 0주
    b.fill("S", 10, 10_000);
    d = await morningFollow(d, b, at(TODAY, "09:04"), "10:00");
    expect(b.calls).toEqual(["sell S 10", "buy B 14"]);
    expect(d.items.find((x) => x.ticker === "S")!.status).toBe("filled");
    expect(d.items.find((x) => x.ticker === "C")!.status).toBe("skipped");
    // 마감: B 미체결 취소
    d = await morningFollow(d, b, at(TODAY, "10:00"), "10:00");
    expect(b.calls.at(-1)).toMatch(/^cancel /);
    expect(d.phase).toBe("done");
    expect(d.items.find((x) => x.ticker === "B")!.status).toBe("cancelled");
    expect(formatDay(d, true)).toContain("매매 결과");
  });

  it("휴장일·꺼진 운용·실전 상한 초과·주문 없음", async () => {
    const r = [report([buy("B", 1, 10_000)])];
    expect((await morningStart(plan, r, fake({ cash: 1e9, open: false }), at(TODAY, "08:40"))).reason).toMatch(/휴장/);
    expect((await morningStart({ ...plan, enabled: false }, r, fake({ cash: 1e9 }), at(TODAY, "08:40"))).phase).toBe("skipped");
    expect((await morningStart(plan, r, fake({ cash: 1e9, env: "real" }), at(TODAY, "08:40"), { realCap: 1_000_000 })).reason).toMatch(/실전 운용 금액 상한/);
    expect((await morningStart(plan, [report([])], fake({ cash: 1e9 }), at(TODAY, "08:40"))).phase).toBe("done");
  });

  it("실전 1회 주문 상한을 넘으면 그 주문만 실패, 주문 실패는 기록", async () => {
    const b = fake({ cash: 1e9, env: "real" });
    const used: number[] = [];
    const d = await morningStart(plan, [report([buy("B", 100, 10_000), buy("C", 1, 10_000)])], b, at(TODAY, "08:40"),
      { orderLimit: { perOrder: 500_000, perDay: 0 }, usedToday: () => 0, addUsage: (a) => used.push(a) });
    expect(d.items[0].status).toBe("failed");
    expect(d.items[0].error).toMatch(/1회 상한/);
    expect(d.items[1].status).toBe("placed");
    expect(used).toHaveLength(1);
    const f = await morningStart(plan, [report([buy("B", 1, 10_000)])], fake({ cash: 1e9, failPlace: true }), at(TODAY, "08:40"));
    expect(f.items[0].status).toBe("failed");
    expect(f.phase).toBe("done");
  });

  it("긴급 정지: 남은 주문 취소", async () => {
    const b = fake({ cash: 1e9 });
    let d = await morningStart(plan, [report([buy("B", 1, 10_000)])], b, at(TODAY, "08:40"));
    d = await stopDay(d, b, at(TODAY, "08:45"));
    expect(d.phase).toBe("stopped");
    expect(d.items[0].status).toBe("cancelled");
  });
});

describe("주문·체결 내역 읽기", () => {
  it("KIS 응답 → 주문 목록", () => {
    const rows = [
      { odno: "0000123", ord_gno_brno: "91252", pdno: "069500", prdt_name: "KODEX 200", sll_buy_dvsn_cd: "02", ord_qty: "3", tot_ccld_qty: "1", rmn_qty: "2", avg_prvs: "80000", ord_unpr: "0", ord_tmd: "084001", cncl_yn: "N" },
      { odno: "0000124", pdno: "005930", sll_buy_dvsn_cd: "01", ord_qty: "2", tot_ccld_qty: "0", rmn_qty: "0", cncl_yn: "Y" },
    ];
    const [a, b] = parseDayOrders(rows);
    expect(a).toMatchObject({ orderNo: "0000123", orgNo: "91252", side: "buy", qty: 3, filledQty: 1, openQty: 2, avgPrice: 80000, cancelled: false });
    expect(b).toMatchObject({ side: "sell", cancelled: true, openQty: 0 });
  });
});
