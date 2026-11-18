/**
 * 수동 계좌 점검 (서버 전용, 조회만): 관리자(owner)의 수동 계좌마다 적용한 전략·종목·기록 잔고와
 * 최근 저녁 계산(목표 보유·매매 안내)을 보여 준다. 아무것도 바꾸지 않는다.
 * 금액은 owner 가 점검 키를 발급해 직접 요청한 것이라 보여 준다 (자동 매매 점검과 같은 기준).
 */
import { OWNER_ID } from "../settings/userdir";
import { STRATEGIES } from "../strategies";
import { loadAccounts, loadManualLog } from "../manual/store";

type Env = Record<string, string | undefined>;

const safeJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return t; } };

export function manualReport(e: Env = process.env, logs = 3) {
  const accounts = loadAccounts(OWNER_ID, e);
  const log = loadManualLog(OWNER_ID, e);
  return {
    accounts: accounts.map((a) => {
      const p = a.plan;
      const s = p?.strategy;
      // 내 전략 코드가 기본 전략 코드와 같으면 그 id (서버 백테스트로 다시 돌릴 때 씀)
      const builtin = p ? (s ? STRATEGIES.find((x) => x.code === s.code)?.id ?? null : p.builtin ?? null) : null;
      return {
        id: a.id, name: a.name, broker: a.broker, cash: a.cash, others: a.others ?? "sell",
        positions: a.positions.map((x) => ({ ticker: x.ticker, name: x.name ?? null, qty: x.qty, avgPrice: x.avgPrice })),
        plan: p ? {
          label: p.label, builtin, strategy: s ? {
            name: s.name, kind: s.cycle ? "cycle" : s.builder ? "builder" : builtin ? "builtin-code" : "custom",
            params: safeJson(s.params), rebalance: s.rebalance, stopLoss: s.stopLoss || null, takeProfit: s.takeProfit || null,
            universe: s.universe ?? null, updatedAt: s.updatedAt ?? null,
          } : null,
          tickers: p.tickers, budget: p.budget, startDate: p.startDate, enabled: p.enabled, updatedAt: p.updatedAt,
        } : null,
        evenings: (log[a.id] ?? []).slice(0, logs).map((r) => ({
          runDate: r.runDate, ranAt: r.ranAt, trigger: r.trigger, status: r.status, label: r.label, dataDate: r.dataDate ?? null,
          equity: r.equity ?? null, cash: r.cash ?? null, kept: r.kept ?? false, accountTotal: r.accountTotal ?? null,
          targets: r.targets ?? [], orders: r.orders.map((o) => ({ side: o.side, ticker: o.ticker, qty: o.qty, cur: o.curQty, target: o.targetQty })),
          warnings: r.warnings, error: r.error ?? null,
        })),
      };
    }),
  };
}
