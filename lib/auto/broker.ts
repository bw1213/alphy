/** 그 사람의 한국투자증권 계좌로 아침 주문을 내는 연결 (서버 전용) */
import { getClient } from "../kis/client";
import { tradeCredentialsFor } from "../kis/access";
import { credentialsFor } from "../kis/config";
import { buyableCash, cancelOrder, isOpenDay, listDayOrders } from "../kis/orders";
import { getBalance, placeOrder } from "../kis/trading";
import { kisEnvFor } from "../kis/userkeys";
import { kisQuote } from "../kis/market";
import type { User } from "../settings/users";
import type { Broker } from "./morning";

type Env = Record<string, string | undefined>;

/** 휴장일 조회 결과 (하루 한 번만 묻기) */
const openCache = new Map<string, boolean | null>();

export function brokerFor(u: User, e: Env = process.env): Broker {
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
      if (openCache.has(date)) return openCache.get(date)!;
      // 휴장일 조회는 실전 앱키로만 됨. 없으면 모름(null) → 주문을 내 보고 증권사 응답에 맡김
      const real = credentialsFor("real", kisEnvFor(u, e));
      const v = real ? await isOpenDay(getClient(real), date).catch(() => null) : null;
      openCache.set(date, v);
      return v;
    },
  };
}
