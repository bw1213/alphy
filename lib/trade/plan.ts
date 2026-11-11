/**
 * 전략의 목표 비중과 실제 잔고를 비교해 주문 목록을 만든다 (브라우저·서버 공용, 순수 함수).
 * 목표 수량 = floor(투자금 × 비중 ÷ 현재가). 매도를 먼저, 그다음 매수.
 */
export interface SavedSignal {
  /** 신호 기준일 */
  date: string;
  /** 전략 이름 */
  label: string;
  picks: { ticker: string; name: string; weight: number; close: number }[];
  savedAt: string;
}

export const SIGNAL_KEY = "alphy.signal";

export interface PlanInput {
  picks: { ticker: string; name?: string; weight: number }[];
  /** 종목별 현재가(원). 없으면 그 종목은 건너뜀 */
  prices: Record<string, number>;
  holdings: { code: string; name?: string; qty: number; price: number }[];
  /** 이 전략에 쓸 금액(원) */
  budget: number;
  /** 목표에 없는 보유 종목을 전량 매도할지 */
  sellOthers: boolean;
}

export interface PlanOrder {
  code: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  amount: number;
  curQty: number;
  targetQty: number;
  targetWeight: number;
  /** 목표에 없는 보유 종목 */
  other: boolean;
}

export interface Plan {
  orders: PlanOrder[];
  /** 가격을 몰라 건너뛴 종목 */
  skipped: string[];
  buyAmount: number;
  sellAmount: number;
}

export function buildPlan(inp: PlanInput): Plan {
  const held = new Map(inp.holdings.map((h) => [h.code, h]));
  const orders: PlanOrder[] = [];
  const skipped: string[] = [];
  const budget = Number.isFinite(inp.budget) && inp.budget > 0 ? inp.budget : 0;
  const targets = new Set<string>();

  for (const p of inp.picks) {
    if (!(p.weight > 0)) continue;
    targets.add(p.ticker);
    const h = held.get(p.ticker);
    const price = inp.prices[p.ticker] > 0 ? inp.prices[p.ticker] : h && h.price > 0 ? h.price : 0;
    if (!(price > 0)) { skipped.push(p.ticker); continue; }
    const curQty = h?.qty ?? 0;
    const targetQty = Math.floor((budget * p.weight) / price);
    const diff = targetQty - curQty;
    if (diff === 0) continue;
    const qty = Math.abs(diff);
    orders.push({
      code: p.ticker, name: p.name || h?.name || p.ticker, side: diff > 0 ? "buy" : "sell",
      qty, price, amount: qty * price, curQty, targetQty, targetWeight: p.weight, other: false,
    });
  }
  if (inp.sellOthers) {
    for (const h of inp.holdings) {
      if (targets.has(h.code) || !(h.qty > 0)) continue;
      orders.push({
        code: h.code, name: h.name || h.code, side: "sell", qty: h.qty, price: h.price, amount: h.qty * h.price,
        curQty: h.qty, targetQty: 0, targetWeight: 0, other: true,
      });
    }
  }
  orders.sort((a, b) => (a.side === b.side ? b.amount - a.amount : a.side === "sell" ? -1 : 1));
  const sum = (side: "buy" | "sell") => orders.filter((o) => o.side === side).reduce((s, o) => s + o.amount, 0);
  return { orders, skipped, buyAmount: sum("buy"), sellAmount: sum("sell") };
}
