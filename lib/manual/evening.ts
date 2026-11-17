/**
 * 수동 계좌 저녁 계산 (서버 전용). 자동 매매의 저녁 계산(lib/auto/evening.ts)을 그대로 쓰고,
 * 계좌 보유만 증권사 대신 사람이 기록한 예수금·보유로 넣는다. 주문은 내지 않고 안내만 한다.
 */
import type { Holding } from "../kis/trading";
import { runEvening, type EveningDeps, type EveningReport } from "../auto/evening";
import { notify } from "../auto/telegram";
import { planMarket } from "../auto/session";
import { loadHistory } from "./value";
import { appendManualLog, loadAccounts, loadManualLog, type ManualAccount } from "./store";

type Env = Record<string, string | undefined>;

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 기록한 보유를 저녁 계산이 읽는 모양으로 */
export const manualHoldings = (a: ManualAccount, price: (t: string) => number | undefined = () => undefined) => async () => ({
  env: "manual" as const,
  cash: a.cash,
  holdings: a.positions.map((p): Holding => ({ code: p.ticker, name: p.name ?? p.ticker, qty: p.qty, avgPrice: p.avgPrice, price: price(p.ticker) ?? 0, value: 0, pnl: 0, pnlRate: 0 })),
});

/** 한 계좌 계산 (기록·알림은 하지 않음) */
export async function runManual(a: ManualAccount, trigger: EveningReport["trigger"], deps: Omit<EveningDeps, "holdings" | "manual"> & { prevDataDate?: string; user?: string } = {}): Promise<EveningReport | null> {
  if (!a.plan) return null;
  // 전략 밖 종목의 가격은 대시보드가 받아 둔 종가 (없으면 평균단가)
  const book = loadHistory(deps.user ?? "owner", deps.env).prices;
  return runEvening({ ...a.plan, intraday: false }, trigger, { ...deps, holdings: manualHoldings(a, (t) => book?.map[t]?.close), manual: { others: a.others ?? "sell" } });
}

/** 텔레그램으로 보낼 글: 내일 직접 할 주문 */
export function formatManual(a: ManualAccount, r: EveningReport): string {
  const head = `[알피 수동 매매] ${r.runDate} · ${a.name} (${a.broker}) · ${r.label}`;
  if (r.status === "error") return `${head}\n계산하지 못했습니다: ${r.error}`;
  if (r.status === "holiday") return `${head}\n오늘은 휴장일로 보고 건너뜁니다.`;
  const lines = [head];
  if (r.accountTotal != null) lines.push(`기록한 계좌 평가액 ${won(r.accountTotal)} (예수금 ${won(r.accountCash ?? 0)})`);
  if (!r.orders.length) lines.push(r.kept ? "다음 거래일 할 일: 없음 (보유 유지)" : "다음 거래일 할 일: 없음");
  else {
    lines.push(`다음 거래일에 직접 주문할 것 ${r.orders.length}건:`);
    for (const o of r.orders) lines.push(`- ${o.side === "buy" ? "매수" : "매도"} ${o.name} ${o.qty}주 (오늘 종가 ${won(o.price)}, 약 ${won(o.amount)})${o.note ? ` · ${o.note}` : ""}`);
    const cash = r.accountCash ?? 0;
    const buy = r.orders.filter((o) => o.side === "buy").reduce((s, o) => s + o.amount, 0);
    const sell = r.orders.filter((o) => o.side === "sell").reduce((s, o) => s + o.amount, 0);
    if (buy > cash + sell) lines.push(`※ 매수에 약 ${won(buy)} 필요한데 예수금(+매도 대금)이 약 ${won(cash + sell)}입니다. 입금하거나 수량을 줄이세요.`);
  }
  if (r.sellLevels.length) {
    lines.push("종가가 이 가격에 닿으면 다음 날 매도 안내:");
    for (const s of r.sellLevels) lines.push(`- ${s.name} ${won(s.price)} ${s.kind === "take_profit" ? "이상" : "이하"} (오늘 ${won(s.close)}, ${s.gap >= 0 ? "+" : ""}${s.gap.toFixed(1)}%) · ${s.label}`);
  }
  for (const w of r.warnings.slice(0, 3)) lines.push(`※ ${w}`);
  if (r.orders.length) lines.push("주문하고 체결되면 알피 \"수동 매매\" 화면에서 체결을 기록해 주세요. 기록한 잔고로 다음 계산을 합니다.");
  return lines.join("\n");
}

/** 한 사람의 수동 계좌 모두: 계산 + 기록 + 알림. 돌려줌: 계산한 계좌 수와 실패 수 */
export async function manualEveningFor(user: string, trigger: EveningReport["trigger"], opts: { notify?: boolean; e?: Env; only?: string; load?: EveningDeps["load"]; now?: number } = {}): Promise<{ ok: number; fail: number; reports: Record<string, EveningReport> }> {
  const e = opts.e ?? process.env;
  const out = { ok: 0, fail: 0, reports: {} as Record<string, EveningReport> };
  const logs = loadManualLog(user, e);
  for (const a of loadAccounts(user, e)) {
    if (opts.only && a.id !== opts.only) continue;
    if (!a.plan || (trigger === "schedule" && !a.plan.enabled)) continue;
    // 미국 종목만: 지난 정상 계산 뒤로 새 시세가 없으면(미국 휴장) 건너뜀
    const prevDataDate = planMarket(a.plan) === "US" && trigger === "schedule"
      ? (logs[a.id] ?? []).find((x) => x.status === "ok" && x.label === a.plan!.label && !(a.plan!.updatedAt > x.ranAt))?.dataDate : undefined;
    const r = (await runManual(a, trigger, { env: e, prevDataDate, load: opts.load, now: opts.now, user }))!;
    appendManualLog(a.id, r, user, e);
    out.reports[a.id] = r;
    if (r.status === "error") out.fail++; else out.ok++;
    if (opts.notify !== false && r.status !== "holiday") {
      try { await notify(user, formatManual(a, r), e); } catch (err) { console.error(`[manual] ${user} 텔레그램 알림 실패: ${(err as Error).message}`); }
    }
  }
  return out;
}
