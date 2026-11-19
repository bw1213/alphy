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
import { isMixed, marketOf, planMarket, planMarkets, type Market } from "./session";
import { backfillRequest } from "../data/backfillPick";
import { withCode } from "../strategies/universe";

type Env = Record<string, string | undefined>;

export interface AutoOrder {
  ticker: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  amount: number;
  curQty: number;
  targetQty: number;
  note?: string;
  retry?: number;
}

export interface SellLevel {
  ticker: string;
  name: string;
  price: number;
  close: number;
  gap: number;
  kind: "drop" | "stop_loss" | "take_profit";
  label: string;
  qty?: number;
  usd?: number;
}

export interface EveningReport {
  runDate: string;
  ranAt: string;
  trigger: "schedule" | "manual";
  status: "ok" | "holiday" | "error";
  label: string;
  dataDate?: string;
  equity?: number;
  cash?: number;
  lossStop?: { loss: number; limit: number; basis?: "account" | "backtest" };
  accountTotal?: number;
  accountCash?: number;
  accountStock?: number;
  accountPnl?: number;
  kept?: boolean;
  targets?: { ticker: string; name: string; targetQty: number; curQty: number; price: number; weight: number; outside?: boolean }[];
  orders: AutoOrder[];
  sellLevels: SellLevel[];
  intraday?: boolean;
  market?: Market;
  markets?: Market[];
  fx?: number;
  holdingsFrom?: "account" | "backtest";
  account?: "real" | "mock" | "manual";
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
  let p: Params = {};
  try { p = JSON.parse(s.params); } catch { }
  return { ...common, fn: compileStrategy(s.code), p, warmup: s.warmup, rebalance: s.rebalance };
}

export interface EveningDeps {
  load?: (q: DataRequest) => Promise<DataResponse>;
  holdings?: () => Promise<{ env: "real" | "mock" | "manual"; holdings: Holding[]; total?: number; cash?: number; stock?: number; note?: string }>;
  accountBase?: number;
  now?: number;
  env?: Env;
  maxLoss?: number;
  manual?: { others: "sell" | "keep"; feeRate?: number };
  prevDataDate?: string;
  unfinished?: Unfinished[];
}

export interface Unfinished { ticker: string; side: "buy" | "sell"; qty: number; retry: number }


type Bars = DataResponse["data"];

export function padTrailing(data: Bars, maxDays = 7): Bars {
  const dates = [...new Set(Object.values(data).flatMap((b) => b.map((x) => x.date)))].sort();
  const lastAll = dates.at(-1);
  if (!lastAll) return data;
  const out: Bars = {};
  for (const [t, bars] of Object.entries(data)) {
    const last = bars.at(-1);
    if (!last || last.date >= lastAll || last.date < minusDays(lastAll, maxDays)) { out[t] = bars; continue; }
    const c = last.close;
    out[t] = [...bars, ...dates.filter((d) => d > last.date).map((date) => ({ ...last, date, open: c, high: c, low: c, close: c, volume: 0 }))];
  }
  return out;
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
  // 한국투자증권 시세는 호출 한도를 아끼려고 계산에선 쓰지 않음
  const source = def.source === "kis" ? "naver" : def.source;
  // 섞은 운용은 미국 장이 끝난 다음 날 아침에 어제까지 시세로 계산 (두 시장 모두 같은 날 종가)
  const mixed = isMixed(plan);
  const end = mixed ? minusDays(r.runDate, 1) : r.runDate;
  const loadStart = minusDays(plan.startDate, Math.max(400, Math.ceil(st.warmup * 1.5) + 30));
  const u = plan.strategy?.universe;
  const bf = plan.tickers.length && u?.backfill ? backfillRequest(u.backfill, plan.tickers) : undefined;
  const d = await (deps.load ?? loadData)({ source, start: loadStart, end, tickers: plan.tickers.length ? plan.tickers : undefined,
    universeSize: u?.mode === "top" ? u.size : def.universeSize, dividends: true, indices: false, ...(bf ? { backfill: bf } : {}) });
  const lastDates = Object.values(d.data).map((b) => b.at(-1)?.date ?? "").filter(Boolean);
  const dataDate = [...lastDates, d.benchmark?.at(-1)?.date ?? ""].sort().at(-1) ?? "";
  if (!dataDate) throw new Error("시세를 받지 못했습니다.");
  r.dataDate = dataDate;
  const market = planMarket(plan);
  let data = d.data;
  if (mixed) {
    r.markets = planMarkets(plan);
    const lastOf = (m: Market) => plan.tickers.filter((t) => marketOf(t) === m).map((t) => d.data[t]?.at(-1)?.date ?? "").sort().at(-1) ?? "";
    const kr = lastOf("KR"), us = lastOf("US");
    const newest = [kr, us].sort().at(-1) ?? "";
    r.dataDate = newest || dataDate;
    if (!newest || (deps.prevDataDate && newest <= deps.prevDataDate)) {
      return { ...r, status: "holiday", warnings: [`지난 계산 뒤로 새 시세가 없어 건너뜁니다. 마지막 시세 한국 ${kr || "없음"}, 미국 ${us || "없음"}.`] };
    }
    if (kr && us && kr !== us) r.warnings.push(`${kr < us ? "한국" : "미국"} 시장이 ${kr < us ? us : kr}에 쉬어 그 시장 종목은 ${kr < us ? kr : us} 종가로 계산했습니다.`);
    r.fx = d.fx?.at(-1)?.close;
    data = padTrailing(d.data);
  } else if (market === "US") {
    r.market = "US";
    const us = plan.tickers.map((t) => d.data[t]?.at(-1)?.date ?? "").sort().at(-1) ?? "";
    r.dataDate = us || dataDate;
    // 새 미국 시세가 없으면(미국 휴장) 같은 신호로 두 번 주문하지 않게 건너뜀
    if (!us || (deps.prevDataDate && us <= deps.prevDataDate)) {
      return { ...r, status: "holiday", warnings: [`지난 계산 뒤로 새 미국 시세가 없어 건너뜁니다. 마지막 시세 ${us || "없음"}.`] };
    }
    r.fx = d.fx?.at(-1)?.close;
  } else if (dataDate < r.runDate) {
    return { ...r, status: "holiday", warnings: [`오늘(${r.runDate}) 시세가 없어 휴장일로 보고 건너뜁니다. 마지막 시세 ${dataDate}.`] };
  }
  // 운용 시작일 저녁에 첫 계산 → 다음 거래일이 첫 매매
  const startDate = minusDays(plan.startDate, -1);
  const res = runBacktest({
    data, benchmark: d.benchmark, names: d.names, universe: d.universe, startDate, initialCash: plan.budget, monthlyDeposit: 0,
    dividends: d.dividends, dividendTax: dividendTaxFn(KR_DIVIDEND_TAX),
    settings: { rebalance: st.rebalance, stopLoss: st.stopLoss, takeProfit: st.takeProfit, rebalanceBand: 0.02, warmup: st.warmup, intraday: intradayOn(plan),
      // 운용 시작일에 바로 전략 비중대로 (월 전략이 다음 달까지 현금으로 기다리지 않게)
      rebalanceAtStart: true },
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

  let real: Map<string, number> | null = null;
  const acctPx = new Map<string, { price: number; name: string }>();
  if (deps.holdings) {
    try {
      const h = await deps.holdings();
      real = new Map(h.holdings.map((x) => [x.code, x.qty]));
      for (const x of h.holdings) acctPx.set(x.code, { price: x.price > 0 ? x.price : x.avgPrice, name: x.name });
      r.holdingsFrom = "account"; r.account = h.env;
      if (h.note) r.warnings.push(`계좌 평가: ${h.note}`);
      if (h.total == null && h.cash != null) {
        const stock = h.holdings.reduce((a, x) => a + x.qty * (close(x.code) > 0 ? close(x.code) : x.price > 0 ? x.price : x.avgPrice), 0);
        h.total = h.cash + stock; h.stock = stock;
      }
      if (h.total != null) {
        r.accountTotal = Math.round(h.total); r.accountCash = Math.round(h.cash ?? 0); r.accountStock = Math.round(h.stock ?? 0);
        if (deps.accountBase != null) r.accountPnl = Math.round(h.total - deps.accountBase);
      }
    } catch (e) {
      r.warnings.push(`계좌 잔고를 읽지 못해 백테스트상 보유 수량으로 계산했습니다: ${(e as Error).message}`);
    }
  }
  if (!real) r.holdingsFrom = "backtest";
  const basis = r.accountPnl != null ? "account" as const : "backtest" as const;
  const loss = basis === "account" ? (-r.accountPnl! / plan.budget) * 100 : (1 - E / plan.budget) * 100;
  if (deps.maxLoss && deps.maxLoss > 0 && loss >= deps.maxLoss) {
    r.lossStop = { loss, limit: deps.maxLoss, basis };
    if (basis === "account" && loss > 100) r.warnings.unshift("계좌 손익이 운용 금액보다 크게 줄었습니다. 계좌 평가액을 잘못 읽었을 수 있으니 자동 매매 화면의 성과 카드에서 \"손익 처음부터\"를 누르고 다시 켜세요.");
    r.warnings.unshift(`운용 금액 대비 ${loss.toFixed(1)}% 손실(${basis === "account" ? "실제 계좌" : "전략 계산"} 기준)로 손실 한도(${deps.maxLoss}%)에 닿아 자동 매매를 멈춥니다. 다시 켜려면 자동 매매 화면에서 켜고 저장하세요.`);
  }
  const curQty = (t: string) => (real ? real.get(t) ?? 0 : btQty.get(t) ?? 0);

  const sig = res.signal;
  if (!sig) r.warnings.push(`준비 기간(${st.warmup}영업일)이 아직 안 끝나 오늘은 신호가 없습니다.`);
  // 주·월·분기 전략은 주기상 매매할 날에만 비중을 맞춤
  const kept = !sig || sig.kept || sig.due === false;
  r.kept = kept;
  const man = deps.manual && real ? deps.manual : null;
  const pxOf = (t: string) => { const c = close(t); return c > 0 ? c : acctPx.get(t)?.price ?? NaN; };
  const strategyTickers = new Set([...(plan.tickers.length ? plan.tickers : []), ...(sig?.picks ?? []).map((x) => x.ticker), ...btQty.keys()]);
  const outside = man ? [...real!.entries()].filter(([t, q]) => q > 0 && !strategyTickers.has(t)) : [];
  const outsideValue = outside.reduce((a, [t, q]) => a + q * (pxOf(t) || 0), 0);
  const base = man && r.accountTotal != null ? Math.max(0, r.accountTotal - (man.others === "keep" ? outsideValue : 0)) : E;
  if (sig && !man) {
    // 자동 매매: 매일 전략상 목표 보유(전략 계산 평가액 × 비중 ÷ 종가)와 실제 계좌 수량의 차이를 주문
    //   비중: 오늘 신호가 있으면 신호 뒤 비중, 없으면(유지) 전략 계산이 지금 들고 있는 비중
    //   못 산 주문·체결 차이·빠뜨린 날도 다음 계산에서 저절로 맞춰짐. 전략 밖 종목은 건드리지 않음
    const weights = new Map<string, number>(
      !kept ? sig.picks.map((x) => [x.ticker, x.weight] as [string, number])
        : [...btQty.entries()].map(([t, q]) => [t, E > 0 ? (q * close(t)) / E : 0] as [string, number]));
    for (const t of btQty.keys()) if (!weights.has(t)) weights.set(t, 0);
    if (real) for (const [t, q] of real) if (q > 0 && plan.tickers.includes(t) && !weights.has(t)) weights.set(t, 0);
    const notes = sig.notes ?? {};
    // 너무 작은 차이(전략 평가액의 1% 미만)는 매일 조금씩 사고팔지 않게 건너뜀 (다 파는 건 작아도 함)
    const minAmount = base * 0.01;
    r.targets = [];
    for (const [t, w] of weights) {
      const px = close(t);
      if (!(px > 0)) { r.warnings.push(`${name(t)}(${t}) 가격을 몰라 주문 목록에서 뺐습니다.`); continue; }
      const cur = curQty(t);
      const tq = Math.max(0, Math.floor((base * w) / px));
      if (tq > 0 || cur > 0) r.targets.push({ ticker: t, name: name(t), targetQty: tq, curQty: cur, price: px, weight: w });
      const diff = tq - cur;
      if (!diff || (Math.abs(diff) * px < minAmount && tq > 0)) continue;
      r.orders.push({ ticker: t, name: name(t), side: diff > 0 ? "buy" : "sell", qty: Math.abs(diff), price: px, amount: Math.abs(diff) * px, curQty: cur, targetQty: tq,
        note: notes[t] ?? (diff > 0 ? "목표 보유보다 적어 매수" : "목표 보유보다 많아 매도") });
    }
    r.kept = !r.orders.length;
  }
  if (!man && deps.unfinished?.length) {
    // 지난번에 못 한 주문: 목표 보유와의 차이로 이미 다시 주문됨 → 몇 번째인지만 적어 둠 (목표에 닿을 때까지 매번 다시)
    for (const u of deps.unfinished) {
      const o = r.orders.find((x) => x.ticker === u.ticker && x.side === u.side);
      if (o) { o.retry = u.retry + 1; o.note = `${o.note ? `${o.note} · ` : ""}지난번에 못 한 주문 다시 (${u.retry + 1}번째)`; }
    }
  }
  if (man && sig) {
    const weights = new Map<string, number>(
      !kept ? sig.picks.map((x) => [x.ticker, x.weight] as [string, number])
        : [...btQty.entries()].map(([t, q]) => [t, E > 0 ? (q * close(t)) / E : 0] as [string, number]));
    for (const t of btQty.keys()) if (!weights.has(t)) weights.set(t, 0);
    for (const [t, q] of real!) if (q > 0 && strategyTickers.has(t) && !weights.has(t)) weights.set(t, 0);
    const notes = sig.notes ?? {};
    const minAmount = base * 0.01;
    r.targets = [];
    for (const [t, w] of weights) {
      const px = close(t);
      if (!(px > 0)) { r.warnings.push(`${name(t)}(${t}) 가격을 몰라 목표 보유에서 뺐습니다.`); continue; }
      const cur = curQty(t);
      const tq = Math.max(0, Math.floor((base * w) / px));
      if (tq > 0 || cur > 0) r.targets.push({ ticker: t, name: name(t), targetQty: tq, curQty: cur, price: px, weight: w });
      const diff = tq - cur;
      if (!diff || (Math.abs(diff) * px < minAmount && tq > 0)) continue;
      r.orders.push({ ticker: t, name: name(t), side: diff > 0 ? "buy" : "sell", qty: Math.abs(diff), price: px, amount: Math.abs(diff) * px, curQty: cur, targetQty: tq,
        note: notes[t] ?? (diff > 0 ? "목표 보유보다 적어 매수" : "목표 보유보다 많아 매도") });
    }
    for (const [t, q] of outside) r.targets.push({ ticker: t, name: d.names[t] ?? acctPx.get(t)?.name ?? t, targetQty: man.others === "sell" ? 0 : q, curQty: q, price: pxOf(t) || 0, weight: 0, outside: true });
    r.kept = !r.orders.length && !(man.others === "sell" && outside.length);
    if (man.others === "sell") for (const [t, q] of outside) {
      const px = pxOf(t);
      if (!(px > 0)) { r.warnings.push(`${acctPx.get(t)?.name ?? t}(${t}) 가격을 몰라 정리 매도 안내에서 뺐습니다.`); continue; }
      r.orders.push({ ticker: t, name: d.names[t] ?? acctPx.get(t)?.name ?? t, side: "sell", qty: q, price: px, amount: q * px, curQty: q, targetQty: 0, note: "전략에 없는 종목 정리 (판 돈으로 전략 종목 매수)" });
    }
    else if (outside.length) r.warnings.push(`전략에 없는 보유 종목 ${outside.length}개(약 ${won(outsideValue)})는 그대로 두고, 나머지 ${won(base)}으로 전략을 계산했습니다.`);
    const fee = man.feeRate ?? 0.003;
    const avail = (r.accountCash ?? 0) + r.orders.filter((o) => o.side === "sell").reduce((a, o) => a + o.amount * (1 - fee), 0);
    const buys = r.orders.filter((o) => o.side === "buy");
    const need = buys.reduce((a, o) => a + o.amount * (1 + fee), 0);
    if (need > avail && need > 0) {
      const k = Math.max(0, avail) / need;
      for (const o of buys) { o.qty = Math.floor(o.qty * k); o.amount = o.qty * o.price; o.targetQty = o.curQty + o.qty; }
      r.orders = r.orders.filter((o) => o.qty > 0);
      r.warnings.push(`매수에 약 ${won(need)}이 필요한데 예수금과 매도 대금이 약 ${won(avail)}이라 매수 수량을 줄였습니다. 입금하면 다음 계산에서 나머지를 안내합니다.`);
    }
  }
  r.orders.sort((a, b) => (a.side === b.side ? b.amount - a.amount : a.side === "sell" ? -1 : 1));

  r.intraday = intradayOn(plan);
  const dates = res.equity.map((x) => x.date);
  const held = (t: string) => (btQty.get(t) ?? 0) > 0 || (real?.get(t) ?? 0) > 0;
  if (r.intraday) {
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

  if (real) {
    const all = new Set([...btQty.keys(), ...(plan.tickers.length ? plan.tickers : [])]);
    const diffs = [...all].filter((t) => (real!.get(t) ?? 0) !== (btQty.get(t) ?? 0))
      .map((t) => `${name(t)} 계좌 ${real!.get(t) ?? 0}주 / 전략 ${btQty.get(t) ?? 0}주`);
    if (diffs.length) r.warnings.push(`${r.account === "manual" ? "계좌에 기록한 수량과 전략의 보유 수량이 다릅니다 (아직 안내대로 사고팔기 전이거나 체결 가격 차이면 정상)" : "실제 계좌와 전략의 보유 수량이 다릅니다 (아직 자동 주문 전이라 정상일 수 있음)"}: ${diffs.slice(0, 5).join(", ")}${diffs.length > 5 ? " 외" : ""}`);
  }
  if (r.fx && r.fx > 0 && (r.market === "US" || mixed)) for (const l of r.sellLevels) if (!mixed || marketOf(l.ticker) === "US") l.usd = Math.round((l.price / r.fx) * 100) / 100;
  if (planKind(plan) === "custom") r.warnings.push("직접 작성한 코드 전략입니다. 코드를 고치면 운용 화면에서 다시 저장해야 반영됩니다.");
  return r;
}

export function formatReport(r: EveningReport): string {
  const mixed = (r.markets?.length ?? 0) > 1;
  const head = `[알피] ${r.runDate} ${mixed ? "" : "저녁 "}계산 · ${r.label}`;
  if (r.status === "error") return `${head}\n계산하지 못했습니다: ${r.error}`;
  if (r.status === "holiday") return `${head}\n오늘은 휴장일로 보고 건너뜁니다.`;
  const lines = [head];
  if (r.lossStop) lines.push(`!! 손실 한도 도달: 운용 금액 대비 -${r.lossStop.loss.toFixed(1)}% (한도 -${r.lossStop.limit}%). 자동 매매를 멈췄습니다.`);
  if (r.accountTotal != null) lines.push(`계좌 평가액 ${won(r.accountTotal)} (예수금 ${won(r.accountCash ?? 0)} · 주식 ${won(r.accountStock ?? 0)})`);
  if (r.accountPnl != null) lines.push(`운용 시작 뒤 계좌 손익 ${r.accountPnl >= 0 ? "+" : "-"}${won(Math.abs(r.accountPnl))}`);
  if (r.equity != null) lines.push(`전략 계산 평가액(가상, 운용 금액에서 출발) ${won(r.equity)}`);
  const orderLine = (o: AutoOrder) => `- ${o.side === "buy" ? "매수" : "매도"} ${withCode(o.name, o.ticker)} ${o.qty}주 (약 ${won(o.amount)})${o.note ? ` · ${o.note}` : ""}`;
  if (!r.orders.length) lines.push(`${mixed ? "다음" : "내일"} 주문: 없음${r.kept ? " (보유 유지)" : ""}`);
  else if (mixed) {
    for (const [m, title] of [["KR", "한국 장 시작(09:00) 주문"], ["US", "미국 장 시작(뉴욕 09:32) 주문"]] as const) {
      const os = r.orders.filter((o) => marketOf(o.ticker) === m);
      if (os.length) { lines.push(`${title} ${os.length}건:`); for (const o of os) lines.push(orderLine(o)); }
    }
  } else {
    lines.push(`${r.market === "US" ? "오늘 밤 미국 장 시작 주문" : "내일 아침 주문"} ${r.orders.length}건:`);
    for (const o of r.orders) lines.push(orderLine(o));
  }
  if (r.sellLevels.length) {
    lines.push("장중 매도 기준:");
    for (const s of r.sellLevels) lines.push(`- ${withCode(s.name, s.ticker)} ${won(s.price)} ${s.kind === "take_profit" ? "이상" : "이하"}${r.intraday ? ` → ${s.qty ? `${s.qty}주` : "전부"} 매도` : ""} (오늘 ${won(s.close)}, ${s.gap >= 0 ? "+" : ""}${s.gap.toFixed(1)}%) · ${s.label}`);
  }
  if (r.holdingsFrom === "backtest") lines.push("※ 계좌를 읽지 못해 전략상 보유로 계산했습니다.");
  for (const w of r.warnings.slice(0, 3)) lines.push(`※ ${w}`);
  if (r.orders.length && mixed) lines.push("한국 종목은 다음 한국 장에, 미국 종목은 다음 미국 장에 자동으로 냅니다. 미국 종목은 현재가 ±1% 지정가입니다. 멈추려면 자동 매매 화면의 긴급 정지를 누르세요.");
  else if (r.orders.length) lines.push(r.market === "US"
    ? "이 주문은 오늘 밤 미국 장이 열리면(뉴욕 09:32) 현재가 ±1% 지정가로 자동으로 냅니다. 멈추려면 자동 매매 화면의 긴급 정지를 누르세요."
    : "이 주문은 다음 거래일 아침에 자동으로 냅니다. 멈추려면 자동 매매 화면의 긴급 정지를 누르세요.");
  if (r.sellLevels.length) lines.push(r.intraday ? (mixed ? "다음 거래일 장중(한국 09:00~15:20, 미국 뉴욕 09:35~15:50)에 이 가격에 닿으면 바로 팝니다." : r.market === "US" ? "오늘 밤 미국 장중(뉴욕 09:35~15:50)에 이 가격(달러로 바꾼 값)에 닿으면 바로 팝니다." : "다음 거래일 장중(09:00~15:20)에 이 가격에 닿으면 바로 시장가로 팝니다.") : "장중 실시간 매도가 꺼져 있어 이 가격은 알림용입니다 (종가로 확인해 다음 날 아침에 팝니다).");
  return lines.join("\n");
}
