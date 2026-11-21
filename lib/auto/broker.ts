/** 그 사람의 한국투자증권 계좌로 아침 주문을 내는 연결 (서버 전용) */
import { getClient } from "../kis/client";
import { tradeCredentialsFor } from "../kis/access";
import { buyableCash, cancelOrder, listDayOrders } from "../kis/orders";
import { getBalance, placeOrder } from "../kis/trading";
import { kisQuote } from "../kis/market";
import type { User } from "../settings/users";
import type { Broker } from "./morning";
import { cancelUsOrder, getUsBalance, listUsOrders, ORDER_EXCHANGE, placeUsOrder, quoteExchange, usBuyableQty, usQuote, usTotalAsset, type OrderExchange } from "../kis/overseas";
import { KIS_EXCHANGE } from "../kis/market";
import { lookupCodes } from "../stocks/master";
import { minusDays } from "./time";
import { US_LIMIT_BAND, type Market } from "./session";
import { BUY_GAP } from "./morning";
import { refreshKrCalendar, tradingDay } from "../market/holidays";

type Env = Record<string, string | undefined>;

/** 미국 종목의 거래소 (종목 목록에서 찾고, 없으면 현재가 조회로 찾아 기억) */
const exchangeCache = new Map<string, OrderExchange>();

/** 미국 주식 계좌 연결: 시장가가 없어 현재가 ±1% 지정가로 주문. 가격은 달러 */
export function usBrokerFor(u: User, e: Env = process.env): Broker {
  const client = getClient(tradeCredentialsFor(u, e));
  const exchangeOf = async (ticker: string): Promise<OrderExchange> => {
    const hit = exchangeCache.get(ticker);
    if (hit) return hit;
    const m = lookupCodes([ticker], e).find((s) => KIS_EXCHANGE[s.market ?? ""])?.market;
    const x = m ? ORDER_EXCHANGE[KIS_EXCHANGE[m]] : ORDER_EXCHANGE[(await usQuote(client, ticker)).exchange];
    exchangeCache.set(ticker, x);
    return x;
  };
  const quote = async (ticker: string) => (await usQuote(client, ticker, [quoteExchange(await exchangeOf(ticker))])).price;
  /** 낸 주문의 종목·거래소·수량 (취소할 때 필요) */
  const placed = new Map<string, { ticker: string; exchange: OrderExchange; qty: number }>();
  return {
    env: client.env,
    balance: async () => {
      const b = await getUsBalance(client);
      // 총자산(원)은 따로 조회. 못 읽으면 0 → 성과 기록은 전략 계산만
      const total = await usTotalAsset(client).catch(() => 0);
      return { ...b, totalValue: total };
    },
    // 그 종목을 지금 가격에 몇 주 살 수 있는지를 원화 금액으로 (아침 주문의 "현금이 충분한가" 판단용)
    buyable: async (code, price) => {
      const x = await exchangeOf(code);
      const q = await quote(code);
      return (await usBuyableQty(client, code, x, q * (1 + US_LIMIT_BAND))) * price * (1 + BUY_GAP);
    },
    place: async (o) => {
      const x = await exchangeOf(o.code);
      const q = await quote(o.code);
      const res = await placeUsOrder(client, { ticker: o.code, exchange: x, side: o.side, qty: o.qty, price: q * (o.side === "buy" ? 1 + US_LIMIT_BAND : 1 - US_LIMIT_BAND) });
      placed.set(res.orderNo.replace(/^0+/, ""), { ticker: o.code, exchange: x, qty: o.qty });
      return res;
    },
    orders: (date) => listUsOrders(client, minusDays(date, 1), minusDays(date, -1)),
    cancel: async (o) => {
      let p = placed.get(o.orderNo.replace(/^0+/, ""));
      if (!p) {
        // 앱이 다시 켜져 기억이 없으면 주문 내역에서 찾음
        const today = new Date().toISOString().slice(0, 10);
        const row = (await listUsOrders(client, minusDays(today, 2), minusDays(today, -1))).find((r) => r.orderNo.replace(/^0+/, "") === o.orderNo.replace(/^0+/, ""));
        if (!row) throw new Error("취소할 주문을 찾지 못했습니다");
        p = { ticker: row.code, exchange: await exchangeOf(row.code), qty: row.openQty || row.qty };
      }
      return cancelUsOrder(client, { orderNo: o.orderNo, ...p });
    },
    openDay: async (date) => tradingDay("US", date, e).open,
    quote,
  };
}

export function brokerFor(u: User, e: Env = process.env, market: Market = "KR"): Broker {
  if (market === "US") return usBrokerFor(u, e);
  const client = getClient(tradeCredentialsFor(u, e));
  return {
    env: client.env,
    balance: () => getBalance(client),
    buyable: (code, price) => buyableCash(client, code, price),
    place: (o) => placeOrder(client, o),
    orders: (date) => listDayOrders(client, date),
    cancel: (o) => cancelOrder(client, o),
    quote: async (code) => (await kisQuote(client, code)).price,
    openDay: async (date) => {
      await refreshKrCalendar(e).catch(() => undefined);
      return tradingDay("KR", date, e).open;
    },
  };
}
