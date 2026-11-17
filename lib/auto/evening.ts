/**
 * 저녁 계산 (서버 전용): 운용 전략을 운용 시작일부터 오늘 종가까지 다시 돌려
 *   1) 내일 아침에 낼 주문 목록 (전략이 오늘 종가로 사고팔기로 한 것만)
 *   2) 장중에 지켜볼 매도 가격 (적립·분할 매도의 하락 매도 가격, 손절·익절 가격)
 * 을 만든다. 주문은 내지 않는다 (아침 자동 주문은 다음 단계).
 *
 * 매일 운용 시작일부터 처음부터 다시 계산하므로 전략의 기억(최고가, 매도 단계 등)을 따로 저장하지 않아도 된다.
 * 실제 계좌가 백테스트와 달라지면(체결 가격 차이, 직접 사고판 경우) 보유 수량 차이를 경고로 보여 준다.
 */
import { loadData, type DataRequest, type DataResponse } from "../data/server";
import { staleWarnings } from "../data/stale";
import { runBacktest } from "../engine/engine";
import { dividendTaxFn, KR_DIVIDEND_TAX } from "../engine/dividends";
import type { Rebalance } from "../engine/types";
import type { Holding } from "../kis/trading";
import { generate, normalizeSpec } from "../strategies/builder";
import { cycle, cycleParams, cycleStatus, cycleWarmup, normalizeCycleSpec } from "../strategies/cycle";
import { compileStrategy, STRATEGIES, type Params } from "../strategies";
import { loadSettings } from "../settings/store";
import { intradayOn, planKind, type AutoPlan } from "./store";
import { kst, minusDays } from "./time";
import { planMarket, type Market } from "./session";

type Env = Record<string, string | undefined>;

export interface AutoOrder {
  ticker: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  /** 오늘 종가 (주문 금액 어림용) */
  price: number;
  amount: number;
  curQty: number;
  targetQty: number;
  /** 전략이 남긴 이유 (적립 매수, 하락 매도 등) */
  note?: string;
}

export interface SellLevel {
  ticker: string;
  name: string;
  /** 이 가격 이하로 내려가면 매도 (익절은 이상) */
  price: number;
  close: number;
  /** 오늘 종가 대비 % (음수 = 그만큼 더 떨어지면) */
  gap: number;
  kind: "drop" | "stop_loss" | "take_profit";
  label: string;
  /** 장중 실시간 매도에서 팔 수량 (손절·익절은 그때 계좌의 전부). 없으면 알림용 기준 가격 */
  qty?: number;
  /** 미국: 달러로 바꾼 가격 (price ÷ 마지막 환율). 장중 감시는 달러 현재가와 이 값을 비교 */
  usd?: number;
}

export interface EveningReport {
  runDate: string;
  ranAt: string;
  trigger: "schedule" | "manual";
  status: "ok" | "holiday" | "error";
  label: string;
  /** 계산에 쓴 마지막 시세 날짜 */
  dataDate?: string;
  /** 백테스트상 전략 평가액 (운용 금액에서 출발) */
  equity?: number;
  cash?: number;
  /** 손실 한도에 닿음 → 자동 매매를 멈춤 */
  lossStop?: { loss: number; limit: number; basis?: "account" | "backtest" };
  /** 실제 계좌 총평가액·예수금·주식 평가액 (계좌를 읽었을 때) */
  accountTotal?: number;
  accountCash?: number;
  accountStock?: number;
  /** 실제 계좌 기준 자동 매매 손익 (총평가액 − 운용 시작 때 평가액) */
  accountPnl?: number;
  /** 전략이 오늘 아무것도 안 하기로 함 */
  kept?: boolean;
  orders: AutoOrder[];
  sellLevels: SellLevel[];
  /** 장중 실시간 매도: sellLevels 를 다음 거래일 장중에 감시해 닿으면 판다 */
  intraday?: boolean;
  /** 미국 종목 운용이면 "US" (없으면 한국). 미국은 한국 저녁에 계산해 그날 밤 미국 장 시작에 주문 */
  market?: Market;
  /** 미국: 계산에 쓴 마지막 원/달러 환율 */
  fx?: number;
  /** 보유 수량을 어디서 가져왔는지: 실제 계좌 / 계좌를 못 읽어 백테스트상 보유 */
  holdingsFrom?: "account" | "backtest";
  account?: "real" | "mock";
  warnings: string[];
  error?: string;
}

interface Prepared { fn: (ctx: any, p: Params) => any; p: Params; warmup: number; rebalance: Rebalance; stopLoss: number | null; takeProfit: number | null }

const pctFrac = (t: string) => (t.trim() === "" ? null : Number(t) / 100);

export function preparePlan(plan: AutoPlan): Prepared {
  if (!plan.strategy) {
    const b = STRATEGIES.find((x) => x.id === plan.builtin);
    if (!b) throw new Error(`'${plan.builtin}' 기본 전략이 없습니다.`);
    const p = Object.fromEntries(b.params.map((x) => [x.key, x.default]));
    return { fn: b.targetWeights, p, warmup: b.warmup(p), rebalance: b.rebalance, stopLoss: b.stopLoss, takeProfit: b.takeProfit };
  }
  const s = plan.strategy;
  const common = { stopLoss: pctFrac(s.stopLoss), takeProfit: pctFrac(s.takeProfit) };
  if (s.cycle) {
    const spec = normalizeCycleSpec(s.cycle);
    return { ...common, fn: cycle, p: cycleParams(spec), warmup: cycleWarmup(spec), rebalance: "D" };
  }
  if (s.builder) {
    const g = generate(normalizeSpec(s.builder));
    return { ...common, fn: compileStrategy(g.code), p: g.params, warmup: g.warmup, rebalance: s.rebalance };
  }
  // 직접 작성한 코드: 저장할 때 owner 만 허용(lib/auto/store.ts)
  let p: Params = {};
  try { p = JSON.parse(s.params); } catch { /* 빈 파라미터 */ }
  return { ...common, fn: compileStrategy(s.code), p, warmup: s.warmup, rebalance: s.rebalance };
}

export interface EveningDeps {
  load?: (q: DataRequest) => Promise<DataResponse>;
  /** 실제 계좌 보유 (못 읽으면 throw) */
  holdings?: () => Promise<{ env: "real" | "mock"; holdings: Holding[]; total?: number; cash?: number; stock?: number }>;
  /** 운용을 시작한 날의 계좌 총평가액. 주면 손실 한도를 실제 계좌 손익으로 봄 (없거나 계좌를 못 읽으면 백테스트 평가액으로) */
  accountBase?: number;
  now?: number;
  env?: Env;
  /** 손실 한도 % (운용 금액 대비). 0 이면 안 봄 */
  maxLoss?: number;
  /** 미국: 지난번 정상 계산에 쓴 마지막 시세 날짜. 그 뒤로 새 시세가 없으면(미국 휴장) 건너뜀 */
  prevDataDate?: string;
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

export async function runEvening(plan: AutoPlan, trigger: EveningReport["trigger"], deps: EveningDeps = {}): Promise<EveningReport> {
  const now = deps.now ?? Date.now();
  const k = kst(now);
  const base: EveningReport = { runDate: k.date, ranAt: new Date(now).toISOString(), trigger, status: "ok", label: plan.label, orders: [], sellLevels: [], warnings: [] };
  try {
    return await evening(plan, base, deps);
  } catch (e) {
    return { ...base, status: "error", error: (e as Error).message };
  }
}

async function evening(plan: AutoPlan, r: EveningReport, deps: EveningDeps): Promise<EveningReport> {
  const st = preparePlan(plan);
  const def = loadSettings(deps.env).backtest;
  const source = def.source === "kis" ? "naver" : def.source; // 한국투자증권 시세는 호출 한도를 아끼려고 저녁 계산에선 쓰지 않음
  const end = r.runDate;
  const loadStart = minusDays(plan.startDate, Math.max(400, Math.ceil(st.warmup * 1.5) + 30));
  const d = await (deps.load ?? loadData)({ source, start: loadStart, end, tickers: plan.tickers.length ? plan.tickers : undefined, universeSize: def.universeSize, dividends: true });
  const lastDates = Object.values(d.data).map((b) => b.at(-1)?.date ?? "").filter(Boolean);
  const dataDate = [...lastDates, d.benchmark?.at(-1)?.date ?? ""].sort().at(-1) ?? "";
  if (!dataDate) throw new Error("시세를 받지 못했습니다.");
  r.dataDate = dataDate;
  const market = planMarket(plan);
  if (market === "US") {
    // 미국: 한국 저녁에는 전날 밤(미국) 장의 시세가 마지막. 지난 계산 뒤로 새 시세가 없으면 미국 휴장 → 같은 신호로 두 번 주문하지 않게 건너뜀
    r.market = "US";
    const us = plan.tickers.map((t) => d.data[t]?.at(-1)?.date ?? "").sort().at(-1) ?? "";
    r.dataDate = us || dataDate;
    if (!us || (deps.prevDataDate && us <= deps.prevDataDate)) {
      return { ...r, status: "holiday", warnings: [`지난 계산 뒤로 새 미국 시세가 없어 건너뜁니다. 마지막 시세 ${us || "없음"}.`] };
    }
    r.fx = d.fx?.at(-1)?.close;
  } else if (dataDate < r.runDate) {
    // 오늘 시세가 없음 = 휴장일 (또는 시세가 아직 안 올라옴)
    return { ...r, status: "holiday", warnings: [`오늘(${r.runDate}) 시세가 없어 휴장일로 보고 건너뜁니다. 마지막 시세 ${dataDate}.`] };
  }
  // 운용 시작일 저녁에 첫 계산 → 다음 거래일 아침이 첫 매매. 그래서 백테스트는 시작일 다음 날부터
  const startDate = minusDays(plan.startDate, -1);
  const res = runBacktest({
    data: d.data, benchmark: d.benchmark, names: d.names, universe: d.universe, startDate, initialCash: plan.budget, monthlyDeposit: 0,
    dividends: d.dividends, dividendTax: dividendTaxFn(KR_DIVIDEND_TAX),
    settings: { rebalance: st.rebalance, stopLoss: st.stopLoss, takeProfit: st.takeProfit, rebalanceBand: 0.02, warmup: st.warmup, intraday: intradayOn(plan) },
    costs: { commission: def.commission / 100, slippage: def.slippage / 100, sellTax: def.sellTax == null ? null : def.sellTax / 100, ...(d.fx ? { us: { commission: def.usCommission / 100, fx: def.usFx / 100 } } : {}) },
    strategy: (ctx) => st.fn(ctx, st.p),
  });
  r.warnings.push(...d.warnings, ...staleWarnings(d, end));
  const last = res.equity.at(-1);
  const E = last?.equity ?? plan.budget;
  r.equity = Math.round(E);
  r.cash = Math.round(last?.cash ?? plan.budget);
  const name = (t: string) => d.names[t] ?? t;
  const close = (t: string) => { const b = d.data[t]; return b?.length ? b[b.length - 1].close : NaN; };
  const btQty = new Map(res.finalPositions.map((x) => [x.ticker, x.qty]));

  // 실제 계좌 보유
  let real: Map<string, number> | null = null;
  if (deps.holdings) {
    try {
      const h = await deps.holdings();
      real = new Map(h.holdings.map((x) => [x.code, x.qty]));
      r.holdingsFrom = "account"; r.account = h.env;
      if (h.total != null) {
        r.accountTotal = Math.round(h.total); r.accountCash = Math.round(h.cash ?? 0); r.accountStock = Math.round(h.stock ?? 0);
        if (deps.accountBase != null) r.accountPnl = Math.round(h.total - deps.accountBase);
      }
    } catch (e) {
      r.warnings.push(`계좌 잔고를 읽지 못해 백테스트상 보유 수량으로 계산했습니다: ${(e as Error).message}`);
    }
  }
  if (!real) r.holdingsFrom = "backtest";
  // 손실 한도: 실제 계좌 손익이 있으면 그걸로, 없으면 백테스트 평가액으로
  const basis = r.accountPnl != null ? "account" as const : "backtest" as const;
  const loss = basis === "account" ? (-r.accountPnl! / plan.budget) * 100 : (1 - E / plan.budget) * 100;
  if (deps.maxLoss && deps.maxLoss > 0 && loss >= deps.maxLoss) {
    r.lossStop = { loss, limit: deps.maxLoss, basis };
    r.warnings.unshift(`운용 금액 대비 ${loss.toFixed(1)}% 손실(${basis === "account" ? "실제 계좌" : "전략 계산"} 기준)로 손실 한도(${deps.maxLoss}%)에 닿아 자동 매매를 멈춥니다. 다시 켜려면 자동 매매 화면에서 켜고 저장하세요.`);
  }
  const curQty = (t: string) => (real ? real.get(t) ?? 0 : btQty.get(t) ?? 0);

  // 1) 내일 주문: 전략이 비중을 바꾸기로 한 종목만 (그대로 두는 종목은 건드리지 않음)
  const sig = res.signal;
  if (!sig) r.warnings.push(`준비 기간(${st.warmup}영업일)이 아직 안 끝나 오늘은 신호가 없습니다.`);
  r.kept = !sig || sig.kept;
  if (sig && !sig.kept) {
    const nowW = (t: string) => (E > 0 ? ((btQty.get(t) ?? 0) * close(t)) / E : 0);
    const target = new Map(sig.picks.map((x) => [x.ticker, x.weight]));
    for (const t of btQty.keys()) if (!target.has(t)) target.set(t, 0);
    const notes = sig.notes ?? {};
    for (const [t, w] of target) {
      if (Math.abs(w - nowW(t)) < 0.002) continue; // 비중 변화 없음 = 유지
      const px = close(t);
      if (!(px > 0)) { r.warnings.push(`${name(t)}(${t}) 가격을 몰라 주문 목록에서 뺐습니다.`); continue; }
      const cur = curQty(t);
      const tq = Math.max(0, Math.floor((E * w) / px));
      const diff = tq - cur;
      if (!diff) continue;
      r.orders.push({ ticker: t, name: name(t), side: diff > 0 ? "buy" : "sell", qty: Math.abs(diff), price: px, amount: Math.abs(diff) * px, curQty: cur, targetQty: tq, note: notes[t] });
    }
    r.orders.sort((a, b) => (a.side === b.side ? b.amount - a.amount : a.side === "sell" ? -1 : 1));
  }

  // 2) 장중 매도 가격
  r.intraday = intradayOn(plan);
  const dates = res.equity.map((x) => x.date);
  const held = (t: string) => (btQty.get(t) ?? 0) > 0 || (real?.get(t) ?? 0) > 0;
  if (r.intraday) {
    // 전략이 걸어 둔 매도 가격 (백테스트와 같은 가격·수량)
    for (const [t, list] of Object.entries(sig?.stops ?? {})) {
      if (!held(t)) continue;
      const c = close(t);
      for (const so of list) {
        const price = Math.floor(so.below);
        if (!(price > 0) || !(so.qty > 0)) continue;
        r.sellLevels.push({ ticker: t, name: name(t), price, close: c, gap: (price / c - 1) * 100, kind: "drop", label: so.note, qty: so.qty });
      }
    }
  } else for (const c of cycleStatus(res.state, dates)) {
    if (!held(c.ticker)) continue;
    const price = c.dropUnit === "won" ? c.peak - c.sellAt : c.peak * (1 - c.sellAt / 100);
    if (!(price > 0)) continue;
    r.sellLevels.push({ ticker: c.ticker, name: name(c.ticker), price: Math.floor(price), close: c.close, gap: (price / c.close - 1) * 100, kind: "drop",
      label: c.phase === "buy" ? `하락 매도 (최고가 ${won(c.peak)} 대비 ${c.dropUnit === "won" ? won(c.sellAt) : `${c.sellAt}%`} 하락)` : `추가 매도 (최고가 대비 ${c.dropUnit === "won" ? won(c.sellAt) : `${c.sellAt}%`} 하락)` });
  }
  for (const pos of res.finalPositions) {
    const c = close(pos.ticker);
    if (st.stopLoss) { const price = pos.avgPrice * (1 - st.stopLoss); r.sellLevels.push({ ticker: pos.ticker, name: name(pos.ticker), price: Math.floor(price), close: c, gap: (price / c - 1) * 100, kind: "stop_loss", label: `손절 (평균단가 ${won(pos.avgPrice)} 대비 -${Math.round(st.stopLoss * 100)}%)` }); }
    if (st.takeProfit) { const price = pos.avgPrice * (1 + st.takeProfit); r.sellLevels.push({ ticker: pos.ticker, name: name(pos.ticker), price: Math.ceil(price), close: c, gap: (price / c - 1) * 100, kind: "take_profit", label: `익절 (평균단가 대비 +${Math.round(st.takeProfit * 100)}%)` }); }
  }

  // 3) 실제 계좌와 백테스트 보유 차이
  if (real) {
    const all = new Set([...btQty.keys(), ...(plan.tickers.length ? plan.tickers : [])]);
    const diffs = [...all].filter((t) => (real!.get(t) ?? 0) !== (btQty.get(t) ?? 0))
      .map((t) => `${name(t)} 계좌 ${real!.get(t) ?? 0}주 / 전략 ${btQty.get(t) ?? 0}주`);
    if (diffs.length) r.warnings.push(`실제 계좌와 전략의 보유 수량이 다릅니다 (아직 자동 주문 전이라 정상일 수 있음): ${diffs.slice(0, 5).join(", ")}${diffs.length > 5 ? " 외" : ""}`);
  }
  if (r.market === "US" && r.fx && r.fx > 0) for (const l of r.sellLevels) l.usd = Math.round((l.price / r.fx) * 100) / 100;
  if (planKind(plan) === "custom") r.warnings.push("직접 작성한 코드 전략입니다. 코드를 고치면 운용 화면에서 다시 저장해야 반영됩니다.");
  return r;
}

/** 텔레그램으로 보낼 글 */
export function formatReport(r: EveningReport): string {
  const head = `[알피] ${r.runDate} 저녁 계산 · ${r.label}`;
  if (r.status === "error") return `${head}\n계산하지 못했습니다: ${r.error}`;
  if (r.status === "holiday") return `${head}\n오늘은 휴장일로 보고 건너뜁니다.`;
  const lines = [head];
  if (r.lossStop) lines.push(`!! 손실 한도 도달: 운용 금액 대비 -${r.lossStop.loss.toFixed(1)}% (한도 -${r.lossStop.limit}%). 자동 매매를 멈췄습니다.`);
  if (r.equity != null) lines.push(`전략 평가액 ${won(r.equity)} (현금 ${won(r.cash ?? 0)})`);
  if (r.accountPnl != null) lines.push(`실제 계좌 손익 ${r.accountPnl >= 0 ? "+" : "-"}${won(Math.abs(r.accountPnl))} (계좌 총평가액 ${won(r.accountTotal ?? 0)})`);
  if (!r.orders.length) lines.push(r.kept ? "내일 주문: 없음 (보유 유지)" : "내일 주문: 없음");
  else {
    lines.push(`${r.market === "US" ? "오늘 밤 미국 장 시작 주문" : "내일 아침 주문"} ${r.orders.length}건:`);
    for (const o of r.orders) lines.push(`- ${o.side === "buy" ? "매수" : "매도"} ${o.name} ${o.qty}주 (약 ${won(o.amount)})${o.note ? ` · ${o.note}` : ""}`);
  }
  if (r.sellLevels.length) {
    lines.push("장중 매도 기준:");
    for (const s of r.sellLevels) lines.push(`- ${s.name} ${won(s.price)} ${s.kind === "take_profit" ? "이상" : "이하"}${r.intraday ? ` → ${s.qty ? `${s.qty}주` : "전부"} 매도` : ""} (오늘 ${won(s.close)}, ${s.gap >= 0 ? "+" : ""}${s.gap.toFixed(1)}%) · ${s.label}`);
  }
  if (r.holdingsFrom === "backtest") lines.push("※ 계좌를 읽지 못해 전략상 보유로 계산했습니다.");
  for (const w of r.warnings.slice(0, 3)) lines.push(`※ ${w}`);
  if (r.orders.length) lines.push(r.market === "US"
    ? "이 주문은 오늘 밤 미국 장이 열리면(뉴욕 09:32) 현재가 ±1% 지정가로 자동으로 냅니다. 멈추려면 자동 매매 화면의 긴급 정지를 누르세요."
    : "이 주문은 다음 거래일 아침에 자동으로 냅니다. 멈추려면 자동 매매 화면의 긴급 정지를 누르세요.");
  if (r.sellLevels.length) lines.push(r.intraday ? (r.market === "US" ? "오늘 밤 미국 장중(뉴욕 09:35~15:50)에 이 가격(달러로 바꾼 값)에 닿으면 바로 팝니다." : "다음 거래일 장중(09:00~15:20)에 이 가격에 닿으면 바로 시장가로 팝니다.") : "장중 실시간 매도가 꺼져 있어 이 가격은 알림용입니다 (종가로 확인해 다음 날 아침에 팝니다).");
  return lines.join("\n");
}
