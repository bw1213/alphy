/** 체결 기록 하나로: 수동 계좌 체결 기록 + 한국투자증권 자동 주문 체결(아침 주문·장중 매도) */
import { loadDays } from "../auto/morning";
import { loadIntradayDays } from "../auto/intraday";
import { loadTrades } from "../manual/store";
import { KIS_ID } from "../manual/value";

type Env = Record<string, string | undefined>;

export interface Fill {
  accountId: string;
  date: string;
  ticker: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  /** 체결 평균가 (미국 자동 주문은 달러) */
  price: number;
  market: "KR" | "US";
  source: "manual" | "morning" | "intraday";
}

export function allFills(user: string, e: Env = process.env, limit = 100): Fill[] {
  const out: Fill[] = loadTrades(user, e).map((t) => ({
    accountId: t.accountId, date: t.date, ticker: t.ticker, name: t.name ?? t.ticker, side: t.side, qty: t.qty, price: t.price, market: "KR" as const, source: "manual" as const,
  }));
  for (const d of Object.values(loadDays(user, e))) {
    for (const it of d.items) if (it.filledQty > 0) out.push({ accountId: KIS_ID, date: d.date, ticker: it.ticker, name: it.name, side: it.side, qty: it.filledQty, price: it.avgPrice, market: d.market ?? "KR", source: "morning" });
  }
  for (const d of Object.values(loadIntradayDays(user, e))) {
    for (const s of d.sells) if (s.filledQty > 0) out.push({ accountId: KIS_ID, date: d.date, ticker: s.ticker, name: s.name, side: "sell", qty: s.filledQty, price: s.avgPrice, market: d.market ?? "KR", source: "intraday" });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}
