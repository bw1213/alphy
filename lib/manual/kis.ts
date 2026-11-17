/**
 * 대시보드용 한국투자증권 잔고 읽기 (서버 전용, 조회만).
 * 주문 계좌(설정의 주문 대상: 실전/모의)의 국내 잔고 + 미국 잔고. 키·계좌번호가 없으면 null (오류 아님).
 * 잔고 조회는 주문이 아니라서 실전 주문 잠금과 상관없이 읽는다.
 */
import { getClient } from "../kis/client";
import { credentialsFor, tradeEnv } from "../kis/config";
import { getBalance } from "../kis/trading";
import { getUsBalance, usCash, usTotalAsset } from "../kis/overseas";
import { kisEnvFor } from "../kis/userkeys";
import type { User } from "../settings/users";
import type { KisRaw } from "./value";

type Env = Record<string, string | undefined>;

export function hasKisAccount(u: User, e: Env = process.env): boolean {
  const ke = kisEnvFor(u, e);
  const c = credentialsFor(tradeEnv(ke), ke);
  return !!(c?.cano && c.acntPrdtCd);
}

export const kisReader = (u: User, e: Env = process.env) => async (): Promise<KisRaw | null> => {
  const ke = kisEnvFor(u, e);
  const c = credentialsFor(tradeEnv(ke), ke);
  if (!c?.cano || !c.acntPrdtCd) return null;
  const client = getClient(c);
  const kr = await getBalance(client);
  const out: KisRaw = { env: client.env, kr: { cash: kr.cash, total: kr.totalValue, holdings: kr.holdings } };
  try {
    const us = await getUsBalance(client);
    // 달러 예수금: 못 읽으면 평가액이 그만큼 빠지므로 메모를 남김 (자동 매매 성과 기록은 이때 평가액을 쓰지 않음)
    let cash: { usd: number; fx: number } | undefined;
    try { cash = await usCash(client); } catch (err) { out.cashNote = `달러 예수금을 읽지 못했습니다: ${(err as Error).message}`; }
    const totalAsset = us.holdings.length ? await usTotalAsset(client).catch(() => undefined) : undefined;
    if (us.holdings.length || cash?.usd) out.us = { holdings: us.holdings, ...(totalAsset ? { totalAsset } : {}), ...(cash ? { cashUsd: cash.usd, ...(cash.fx > 0 ? { fx: cash.fx } : {}) } : {}) };
  } catch (err) {
    out.note = `미국 잔고를 읽지 못했습니다: ${(err as Error).message}`;
  }
  return out;
};
