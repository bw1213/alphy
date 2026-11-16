import { describe, expect, it } from "vitest";
import { intradayCheck, intradayStart, triggered, type IntradayDay } from "@/lib/auto/intraday";
import type { Broker } from "@/lib/auto/morning";
import type { EveningReport, SellLevel } from "@/lib/auto/evening";
import type { AutoPlan } from "@/lib/auto/store";
import type { DayOrder } from "@/lib/kis/orders";

const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);
const TODAY = "2026-11-17";
const plan: AutoPlan = { builtin: "momentum", label: "적립", tickers: ["A"], budget: 3_000_000, startDate: "2026-11-01", enabled: true, updatedAt: "2026-11-10T00:00:00Z" };
const lv = (kind: SellLevel["kind"], price: number, qty?: number, t = "A"): SellLevel =>
  ({ ticker: t, name: `N${t}`, price, close: 10_000, gap: 0, kind, label: `${kind} ${price}`, ...(qty ? { qty } : {}) });
const report = (sellLevels: SellLevel[], over: Partial<EveningReport> = {}): EveningReport => ({
  runDate: "2026-11-16", ranAt: "2026-11-16T09:00:00Z", trigger: "schedule", status: "ok", label: "적립", orders: [], sellLevels, intraday: true, warnings: [], ...over,
});

function fake(prices: Record<string, number>, held: Record<string, number>, opts: { open?: boolean | null; env?: "real" | "mock" } = {}) {
  const orders: DayOrder[] = [];
  const calls: string[] = [];
  let n = 0;
  const b: Broker & { calls: string[]; prices: Record<string, number>; fill: (no: string, px: number) => void } = {
    env: opts.env ?? "mock", calls, prices,
    balance: async () => ({ env: "mock", holdings: Object.entries(held).map(([code, qty]) => ({ code, name: code, qty, avgPrice: 0, price: 0, value: 0, pnl: 0, pnlRate: 0 })), cash: 0, stockValue: 0, totalValue: 0, pnl: 0 }),
    buyable: async () => 0,
    place: async (o) => {
      calls.push(`${o.side} ${o.code} ${o.qty} ${o.type}`);
      const no = String(++n).padStart(10, "0");
      orders.push({ orderNo: no, orgNo: "1", code: o.code, name: o.code, side: o.side, qty: o.qty, filledQty: 0, openQty: o.qty, avgPrice: 0, price: 0, time: "", cancelled: false });
      return { env: "mock", orderNo: no, orderTime: "", message: "ok", orgNo: "1" };
    },
    orders: async () => orders.map((o) => ({ ...o })),
    cancel: async () => "",
    openDay: async () => opts.open ?? null,
    quote: async (c) => prices[c] ?? 0,
    fill: (no, px) => { const x = orders.find((o) => o.orderNo === no)!; x.filledQty = x.qty; x.openQty = 0; x.avgPrice = px; },
  };
  return b;
}

describe("장중 실시간 매도", () => {
  it("감시 시작: 저녁 계산의 매도 가격을 가져오고, 꺼져 있거나 휴장이면 안 함", async () => {
    const b = fake({}, {});
    const d = await intradayStart(plan, [report([lv("drop", 9000, 10)])], b, at(TODAY, "09:00"));
    expect(d.done).toBeFalsy();
    expect(d.levels).toHaveLength(1);
    expect((await intradayStart({ ...plan, intraday: false }, [report([lv("drop", 9000, 10)])], b, at(TODAY, "09:00"))).reason).toMatch(/꺼져/);
    expect((await intradayStart(plan, [report([lv("drop", 9000, 10)], { intraday: false })], b, at(TODAY, "09:00"))).reason).toMatch(/장중 매도 없이/);
    expect((await intradayStart(plan, [report([lv("drop", 9000, 10)])], fake({}, {}, { open: false }), at(TODAY, "09:00"))).reason).toMatch(/휴장/);
    expect((await intradayStart(plan, [report([])], b, at(TODAY, "09:00"))).reason).toMatch(/없습니다/);
  });

  it("가격에 닿으면 정한 수량만 시장가로 팔고, 같은 가격으로 다시 팔지 않음", async () => {
    const b = fake({ A: 9500 }, { A: 30 });
    let d = await intradayStart(plan, [report([lv("drop", 9000, 10), lv("drop", 8500, 10)])], b, at(TODAY, "09:00"));
    ({ day: d } = await intradayCheck(d, b, at(TODAY, "09:05")));
    expect(b.calls).toHaveLength(0);
    b.prices.A = 8990;
    const r = await intradayCheck(d, b, at(TODAY, "09:10"));
    d = r.day;
    expect(b.calls).toEqual(["sell A 10 market"]);
    expect(r.messages[0]).toContain("10주 시장가로 팔았습니다");
    // 다시 와도 같은 가격으론 안 팖, 더 떨어지면 다음 가격
    await intradayCheck(d, b, at(TODAY, "09:11"));
    expect(b.calls).toHaveLength(1);
    b.prices.A = 8400;
    ({ day: d } = await intradayCheck(d, b, at(TODAY, "09:12")));
    expect(b.calls).toEqual(["sell A 10 market", "sell A 10 market"]);
  });

  it("한 번에 여러 가격을 지나면 한 주문으로 묶음, 계좌에 있는 만큼만", async () => {
    const b = fake({ A: 8000 }, { A: 15 });
    const d = await intradayStart(plan, [report([lv("drop", 9000, 10), lv("drop", 8500, 10)])], b, at(TODAY, "09:00"));
    const r = await intradayCheck(d, b, at(TODAY, "09:00"));
    expect(b.calls).toEqual(["sell A 15 market"]);
    expect(r.day.sells[0].keys).toHaveLength(2);
    expect(r.messages[0]).toContain("계좌에 15주만");
  });

  it("손절은 그 종목 전부, 익절은 위로 닿을 때", () => {
    const d = { date: TODAY, label: "x", levels: [lv("stop_loss", 9000), lv("take_profit", 12000), lv("drop", 9500, 5)], sells: [], log: [] } as IntradayDay;
    expect(triggered(d, "A", 10_000)).toBeNull();
    expect(triggered(d, "A", 9400)!.kind).toBe("drop");
    expect(triggered(d, "A", 8900)!.kind).toBe("stop_loss");
    expect(triggered(d, "A", 12_100)!.kind).toBe("take_profit");
  });

  it("손절로 다 팔면 그 종목 다른 가격은 끝. 체결되면 알림, 장 끝나면 감시 끝", async () => {
    const b = fake({ A: 8800 }, { A: 40 });
    let d = await intradayStart(plan, [report([lv("stop_loss", 9000), lv("drop", 8500, 10)])], b, at(TODAY, "09:00"));
    ({ day: d } = await intradayCheck(d, b, at(TODAY, "10:00")));
    expect(b.calls).toEqual(["sell A 40 market"]);
    b.prices.A = 8000;
    b.fill(d.sells[0].orderNo!, 8790);
    const r = await intradayCheck(d, b, at(TODAY, "10:02"));
    expect(b.calls).toHaveLength(1);
    expect(r.messages.join("\n")).toContain("40주 중 40주 체결, 평균 8,790원");
    const end = await intradayCheck(r.day, b, at(TODAY, "15:31"));
    expect(end.day.done).toBe(true);
  });

  it("15:20 이후엔 새로 팔지 않음", async () => {
    const b = fake({ A: 8000 }, { A: 10 });
    const d = await intradayStart(plan, [report([lv("drop", 9000, 10)])], b, at(TODAY, "09:00"));
    await intradayCheck(d, b, at(TODAY, "15:25"));
    expect(b.calls).toHaveLength(0);
  });
});
