/**
 * 대시보드용 한국투자증권 잔고 읽기 (서버 전용, 조회만).
 * 주문 계좌(설정의 주문 대상: 실전/모의)의 국내 잔고 + 미국 잔고. 키·계좌번호가 없으면 null (오류 아님).
 * 잔고 조회는 주문이 아니라서 실전 주문 잠금과 상관없이 읽는다.
 */
import { getClient } from "../kis/client";
import { credentialsFor, tradeEnv } from "../kis/config";
import { getBalance } from "../kis/trading";
import { getUsBalance, usCash } from "../kis/overseas";
import { kisEnvFor } from "../kis/userkeys";
import type { User } from "../settings/users";
import type { KisRaw } from "./value";

type Env = Record<string, string | undefined>;

export function hasKisAccount(u: User, e: Env = process.env, acct?: string): boolean {
  let ke: Env;
  try { ke = kisEnvFor(u, e, acct); } catch { return false; }
  const c = credentialsFor(tradeEnv(ke), ke);
  return !!(c?.cano && c.acntPrdtCd);
}

export const kisReader = (u: User, e: Env = process.env, acct?: string) => async (): Promise<KisRaw | null> => {
  const ke = kisEnvFor(u, e, acct);
  const c = credentialsFor(tradeEnv(ke), ke);
  if (!c?.cano || !c.acntPrdtCd) return null;
  const client = getClient(c);
  const kr = await getBalance(client);
  const out: KisRaw = { env: client.env, kr: { cash: kr.cash, total: kr.totalValue, holdings: kr.holdings } };
  try {
    const us = await getUsBalance(client);
    // 달러 예수금 (해외 매수가능금액의 주문 가능 외화). 한 번 실패하면 한 번 더 물어봄
    let cash: { usd: number; fx: number } | undefined;
    try { cash = await usCash(client).catch(() => usCash(client)); }
    catch (err) { out.cashNote = `달러 예수금을 읽지 못해 평가액에서 뺐습니다: ${(err as Error).message}`; }
    if (us.holdings.length || cash) out.us = { holdings: us.holdings, ...(cash ? { cashUsd: cash.usd, ...(cash.fx > 0 ? { fx: cash.fx } : {}) } : {}) };
  } catch (err) {
    out.note = `미국 잔고를 읽지 못했습니다: ${(err as Error).message}`;
  }
  return out;
};
