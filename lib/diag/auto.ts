/**
 * 자동 매매 점검 (서버 전용, 조회만): 관리자(owner) 계정의 운용 상태·성과 기준·최근 계산·주문 기록과
 * 지금 한국투자증권 잔고 합계(국내 총평가·총자산 조회값)를 보여 준다. 주문은 내지 않는다.
 * 키·계좌번호는 보여 주지 않는다. 금액은 owner 가 점검 키를 발급해 직접 요청한 것이라 보여 준다.
 */
import { getUser } from "../settings/users";
import { OWNER_ID } from "../settings/userdir";
import { loadLog, loadPlan, planKind } from "../auto/store";
import { loadPerf, perfFor, summarize } from "../auto/perf";
import { loadDays } from "../auto/morning";
import { loadIntradayDays } from "../auto/intraday";
import { loadState } from "../auto/scheduler";
import { planMarket } from "../auto/session";
import { tradeEnv } from "../kis/config";
import { kisEnvFor } from "../kis/userkeys";
import { kisReader } from "../manual/kis";
import { kisViewOf, loadHistory } from "../manual/value";

export async function autoReport() {
  const u = getUser(OWNER_ID);
  if (!u) return { error: "관리자 계정이 없습니다" };
  const plan = loadPlan(u.id);
  const env = tradeEnv(kisEnvFor(u));
  const perf = plan ? perfFor(loadPerf(u.id), plan, env) : null;
  const days = Object.values(loadDays(u.id)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  const intra = Object.values(loadIntradayDays(u.id)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  let account: unknown = null;
  try {
    const raw = await kisReader(u)();
    if (raw) {
      const v = kisViewOf(raw, loadHistory(u.id).prices, Date.now());
      account = {
        env: raw.env, krTotal: raw.kr.total, krCash: raw.kr.cash, krHoldings: raw.kr.holdings.map((h) => ({ code: h.code, qty: h.qty, value: h.value })),
        usHoldings: (raw.us?.holdings ?? []).map((h) => ({ code: h.code, qty: h.qty, valueUsd: h.value })), usTotalAsset: raw.us?.totalAsset ?? null,
        viewTotal: v.total, viewCash: v.cash, note: v.note ?? raw.note ?? null,
      };
    }
  } catch (e) { account = { error: (e as Error).message }; }
  return {
    plan: plan ? { label: plan.label, kind: planKind(plan), market: planMarket(plan), tickers: plan.tickers, budget: plan.budget, startDate: plan.startDate, enabled: plan.enabled, intraday: plan.intraday, updatedAt: plan.updatedAt } : null,
    env,
    scheduler: loadState().evening ?? null,
    perf: perf ? { key: perf.key, base: perf.base ?? null, budget: perf.budget, points: perf.points.slice(-7), summary: summarize(perf) } : null,
    evenings: loadLog(u.id).slice(0, 4).map((r) => ({ runDate: r.runDate, ranAt: r.ranAt, trigger: r.trigger, status: r.status, label: r.label, market: r.market, dataDate: r.dataDate,
      equity: r.equity, accountTotal: r.accountTotal, accountCash: r.accountCash, accountStock: r.accountStock, accountPnl: r.accountPnl, lossStop: r.lossStop ?? null,
      orders: r.orders.map((o) => ({ side: o.side, ticker: o.ticker, qty: o.qty, cur: o.curQty, target: o.targetQty })), warnings: r.warnings, error: r.error })),
    morning: days.map((d) => ({ date: d.date, market: d.market, env: d.env, phase: d.phase, reason: d.reason, items: d.items.map((i) => ({ side: i.side, ticker: i.ticker, qty: i.qty, status: i.status, filled: i.filledQty, avg: i.avgPrice, error: i.error })), log: d.log.slice(-10) })),
    intraday: intra.map((d) => ({ date: d.date, market: d.market, done: d.done, reason: d.reason, levels: d.levels.length, sells: d.sells.length, log: d.log.slice(-6) })),
    account,
  };
}
