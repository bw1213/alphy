/**
 * 내 계좌 목록 하나: 한국투자증권(자동 주문) 계좌와 수동 계좌를 같은 모양으로.
 * 저장은 그대로 (auto.json 운용, manual.json 계좌). 화면은 이 목록 하나로 계좌를 고른다.
 */
import { loadLog, loadPlan, type AutoPlan } from "../auto/store";
import { planMarkets } from "../auto/session";
import { tradeEnv } from "../kis/config";
import { kisEnvFor } from "../kis/userkeys";
import { hasKisAccount } from "../manual/kis";
import { accountReturns } from "../manual/returns";
import { accountValue, loadAccounts, loadManualLog } from "../manual/store";
import { KIS_ID, loadHistory } from "../manual/value";
import type { User } from "../settings/users";

type Env = Record<string, string | undefined>;

export interface AccountSummary {
  id: string;
  name: string;
  broker: string;
  /** auto: 앱이 한국투자증권에 주문 / manual: 안내를 보고 직접 주문 */
  mode: "auto" | "manual";
  env?: "real" | "mock";
  plan: { label: string; enabled: boolean; budget: number; markets: ("KR" | "US")[] } | null;
  /** 마지막으로 기록한 평가액 (한국투자증권은 마지막 잔고 조회) */
  total: number | null;
  /** 누적 수익률 % (기록이 이틀 이상일 때) */
  ret: number | null;
  since: string | null;
  /** 마지막 계산의 할 일 수와 계산일 */
  todo: number;
  runDate: string | null;
  href: string;
}

const planOf = (p: AutoPlan | null, markets: ("KR" | "US")[]) => (p ? { label: p.label, enabled: p.enabled, budget: p.budget, markets } : null);

export function listAccounts(u: User, e: Env = process.env): AccountSummary[] {
  const h = loadHistory(u.id, e);
  const retOf = (id: string) => {
    const r = accountReturns(h.points[id] ?? [], h.flows?.[id] ?? []);
    return r.length > 1 ? { ret: r.at(-1)!.ret, since: r[0].date } : { ret: null, since: null };
  };
  const out: AccountSummary[] = [];
  if (hasKisAccount(u, e)) {
    const plan = loadPlan(u.id, e);
    const last = plan ? loadLog(u.id, e).find((r) => r.status === "ok") : undefined;
    const env = tradeEnv(kisEnvFor(u, e));
    out.push({
      id: KIS_ID, name: `한국투자증권${env === "mock" ? " (모의)" : ""}`, broker: "한국투자증권", mode: "auto", env,
      plan: planOf(plan, plan ? planMarkets(plan) : []), total: h.kis?.total ?? null, ...retOf(KIS_ID),
      todo: last?.orders.length ?? 0, runDate: last?.runDate ?? null, href: "/auto",
    });
  }
  const logs = loadManualLog(u.id, e);
  for (const a of loadAccounts(u.id, e)) {
    const last = (logs[a.id] ?? []).find((r) => r.status === "ok");
    out.push({
      id: a.id, name: a.name, broker: a.broker, mode: "manual",
      plan: planOf(a.plan, a.plan ? planMarkets(a.plan) : []),
      total: Math.round(accountValue(a, (t) => h.prices?.map[t]?.close)), ...retOf(a.id),
      todo: last?.orders.length ?? 0, runDate: last?.runDate ?? null, href: `/manual?account=${a.id}`,
    });
  }
  return out;
}
