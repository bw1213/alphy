/**
 * 일봉 포트폴리오 백테스트 엔진.
 *
 * 타이밍 규칙 (미래 데이터 사용 방지)
 *  - t일 장 마감 후: 전략이 t일까지의 데이터로 목표 비중 결정, 손절/익절 조건 확인
 *  - t+1일 시가: 매도 먼저, 그 다음 매수 (정수 주)
 *  - 거래정지(거래량 0)·가격 없음 종목은 그날 매매하지 않음
 */
import { buildPanel, StrategyContext, type Panel } from "./context";
import { DEFAULT_COSTS, sellTax } from "./costs";
import { HOLD } from "./types";
import type { BacktestResult, CostSettings, EquityPoint, PriceData, Rebalance, RunSettings, Signal, Trade, UniverseSnapshot, Weights } from "./types";

export type TargetFn = (ctx: StrategyContext) => Weights | null | undefined;

export interface RunOptions {
  data: PriceData;
  benchmark?: { date: string; close: number }[] | null;
  strategy: TargetFn;
  settings: RunSettings;
  costs?: CostSettings;
  initialCash?: number;
  /** 이 날짜부터 성과 집계 (이전 구간은 지표 워밍업용) */
  startDate?: string;
  names?: Record<string, string>;
  /** 시점별 종목 목록. 주면 전략은 그 날짜 시점에 목록에 있던 종목만 고를 수 있다 */
  universe?: UniverseSnapshot[] | null;
  /** 매달 추가로 넣는 돈(원). 평가 시작 다음 달부터 매월 첫 거래일 장 시작 전에 현금으로 들어온다 */
  monthlyDeposit?: number;
}

/** 데이터가 끝나고 이만큼(영업일) 지나도 시세가 없으면 상장폐지로 보고 마지막 종가에 청산 */
export const DELIST_AFTER_DAYS = 10;

export function rebalanceDays(dates: string[], rule: Rebalance): Set<number> {
  const out = new Set<number>();
  if (rule === "D") dates.forEach((_, k) => out.add(k));
  else if (typeof rule === "number") for (let k = 0; k < dates.length; k += Math.max(1, rule)) out.add(k);
  else {
    const key = (d: string) => {
      const y = d.slice(0, 4), m = Number(d.slice(5, 7));
      if (rule === "M") return `${y}-${m}`;
      if (rule === "Q") return `${y}-Q${Math.ceil(m / 3)}`;
      // 주: 월요일 기준 주 시작일
      const dt = new Date(d + "T00:00:00Z");
      const dow = (dt.getUTCDay() + 6) % 7;
      dt.setUTCDate(dt.getUTCDate() - dow);
      return dt.toISOString().slice(0, 10);
    };
    // 각 기간의 마지막 영업일에 신호 → 다음 기간 첫 영업일 시가에 체결
    for (let k = 0; k < dates.length; k++) {
      if (k === dates.length - 1 || key(dates[k]) !== key(dates[k + 1])) out.add(k);
    }
  }
  return out;
}

export function runBacktest(opt: RunOptions): BacktestResult {
  const costs = opt.costs ?? DEFAULT_COSTS;
  const st = opt.settings;
  const P: Panel = buildPanel(opt.data, opt.benchmark);
  const { dates, tickers } = P;
  const N = dates.length;
  const reb = rebalanceDays(dates, st.rebalance);
  const startIdx = opt.startDate ? Math.max(0, dates.findIndex((d) => d >= opt.startDate!)) : 0;

  let cash = opt.initialCash ?? 10_000_000;
  // 추가 입금: 수익률은 펀드 '좌수'처럼 계산해 입금 효과를 뺀다 (nav = 평가액 / 좌수, 시작 nav = 시작 자금)
  const deposit = Math.max(0, opt.monthlyDeposit ?? 0);
  let contributed = cash;
  let units = 1;
  let prevEq = cash;
  const pos: Record<string, number> = {};
  const avg: Record<string, number> = {};
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let pending: Weights | null = null;
  let pendingExact = false;
  let pendingNotes: Record<string, string> = {};
  const memo: Record<string, any> = {};
  let forced = new Map<string, Trade["reason"]>();
  let signal: Signal | null = null;

  /** 전략이 돌려준 비중 정리: 유니버스 밖·0 이하 제거, 합이 1 을 넘으면 비례 축소. HOLD(지금 수량 유지)는 보유 중일 때만 남김 */
  const cleanWeights = (w: Weights): Weights => {
    const clean: Weights = {};
    for (const [t, x] of Object.entries(w)) {
      if (!P.index.has(t)) continue;
      if (x === HOLD) { if (pos[t]) clean[t] = HOLD; }
      else if (Number.isFinite(x) && x > 0) clean[t] = x;
    }
    const s = Object.values(clean).reduce((a, b) => a + (b > 0 ? b : 0), 0);
    if (s > 1 + 1e-9) for (const t in clean) if (clean[t] > 0) clean[t] /= s;
    return clean;
  };

  const col = (t: string) => P.index.get(t)!;

  // 종목별 마지막 시세 날짜 (상장폐지 판단용)
  const lastIdx = new Map<string, number>();
  tickers.forEach((t, k) => {
    let j = N - 1;
    while (j >= 0 && Number.isNaN(P.close[k][j])) j--;
    lastIdx.set(t, j);
  });

  // 시점별 유니버스: 그 날짜 이전의 가장 최근 목록 (첫 목록보다 앞선 날짜는 첫 목록)
  const snaps = (opt.universe ?? []).filter((u) => u.tickers.length)
    .map((u) => ({ date: u.date, tickers: u.tickers.filter((t) => P.index.has(t)) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  let snapK = 0;
  const activeAt = (i: number): string[] | undefined => {
    if (!snaps.length) return undefined;
    while (snapK + 1 < snaps.length && snaps[snapK + 1].date <= dates[i]) snapK++;
    return snaps[snapK].tickers;
  };

  for (let i = 0; i < N; i++) {
    const d = dates[i];

    // ---------- 0) 추가 입금 (매월 첫 거래일, 평가 시작 이후) ----------
    if (deposit > 0 && i > startIdx && d.slice(0, 7) !== dates[i - 1].slice(0, 7)) {
      const unitPrice = prevEq > 0 && units > 0 ? prevEq / units : 1;
      units += deposit / unitPrice;
      cash += deposit;
      contributed += deposit;
    }

    // ---------- 1) 시가 체결 ----------
    if (pending || forced.size) {
      const tradable = (t: string) => {
        const k = P.index.get(t);
        if (k === undefined) return false;
        const o = P.open[k][i], v = P.volume[k][i];
        return Number.isFinite(o) && o > 0 && Number.isFinite(v) && v > 0;
      };
      const mark = (t: string) => (tradable(t) ? P.open[col(t)][i] : P.closeFilled[col(t)][Math.max(0, i - 1)]);
      const eqOpen = cash + Object.entries(pos).reduce((s, [t, q]) => s + q * mark(t), 0);

      let target: Record<string, number> = { ...pos };
      if (pending) {
        target = {};
        for (const [t, w] of Object.entries(pending)) {
          if (w === HOLD) { if (pos[t]) target[t] = pos[t]; continue; }
          if (!(w > 0) || !tradable(t)) continue;
          const o = P.open[col(t)][i];
          if (!pendingExact && pos[t] && Math.abs((pos[t] * o) / eqOpen - w) < st.rebalanceBand) {
            target[t] = pos[t];
            continue;
          }
          const px = o * (1 + costs.slippage) * (1 + costs.commission);
          target[t] = Math.floor((eqOpen * w) / px);
        }
        for (const t of Object.keys(pos)) if (!tradable(t)) target[t] = pos[t];
      }
      for (const t of forced.keys()) if (tradable(t)) target[t] = 0;

      const tax = sellTax(costs, Number(d.slice(0, 4)));
      // 매도
      for (const t of Object.keys(pos)) {
        const q = pos[t], tgt = target[t] ?? 0;
        if (q > tgt && tradable(t)) {
          const n = q - tgt;
          const px = P.open[col(t)][i] * (1 - costs.slippage);
          const gross = n * px;
          const fee = gross * (costs.commission + tax);
          cash += gross - fee;
          trades.push({ date: d, ticker: t, side: "SELL", qty: n, price: px, fee,
            pnl: (px - avg[t]) * n - fee, ret: px / avg[t] - 1, reason: forced.get(t) ?? "rebalance",
            ...(!forced.has(t) && pendingNotes[t] ? { note: pendingNotes[t] } : {}) });
          if (tgt === 0) { delete pos[t]; delete avg[t]; } else pos[t] = tgt;
        }
      }
      // 매수 (현금 부족 시 가능한 만큼)
      for (const [t, tgt] of Object.entries(target)) {
        const q = pos[t] ?? 0;
        if (tgt > q && tradable(t)) {
          const px = P.open[col(t)][i] * (1 + costs.slippage);
          const n = Math.min(tgt - q, Math.floor(cash / (px * (1 + costs.commission))));
          if (n <= 0) continue;
          const fee = n * px * costs.commission;
          cash -= n * px + fee;
          avg[t] = ((avg[t] ?? 0) * q + px * n) / (q + n);
          pos[t] = q + n;
          trades.push({ date: d, ticker: t, side: "BUY", qty: n, price: px, fee, pnl: null, ret: null, reason: "rebalance",
            ...(pendingNotes[t] ? { note: pendingNotes[t] } : {}) });
        }
      }
      pending = null;
      pendingExact = false;
      pendingNotes = {};
      forced = new Map();
    }

    // ---------- 1.5) 상장폐지 청산 ----------
    // 시세가 끊긴 뒤 다시 나오지 않는 종목은 마지막 종가에 판 것으로 처리 (정리매매 가격이 마지막 종가에 반영돼 있음)
    for (const t of Object.keys(pos)) {
      const li = lastIdx.get(t)!;
      if (li < N - 1 - DELIST_AFTER_DAYS && i === li + 1) {
        const q = pos[t], px = P.closeFilled[col(t)][li];
        const gross = q * px;
        const fee = gross * (costs.commission + sellTax(costs, Number(d.slice(0, 4))));
        cash += gross - fee;
        trades.push({ date: d, ticker: t, side: "SELL", qty: q, price: px, fee, pnl: (px - avg[t]) * q - fee, ret: px / avg[t] - 1, reason: "delisted" });
        delete pos[t]; delete avg[t];
        forced.delete(t);
      }
    }

    // ---------- 2) 종가 평가 ----------
    let invested = 0;
    for (const [t, q] of Object.entries(pos)) invested += q * P.closeFilled[col(t)][i];
    const eq = cash + invested;
    prevEq = eq;
    equity.push({ date: d, equity: eq, nav: units > 0 ? eq / units : eq, contributed, cash, invested, benchmark: P.bench ? P.bench[i] : null });

    if (i === N - 1) {
      // 마지막 날: 리밸런싱 주기와 상관없이 "지금 전략이 고르는 종목"을 계산 (추천 종목용, 체결은 없음)
      if (i + 1 >= st.warmup) {
        const w = opt.strategy(new StrategyContext(P, i, { ...pos }, { ...avg }, cash, eq, opt.names, activeAt(i), memo));
        const nowW = (t: string) => (eq > 0 ? ((pos[t] ?? 0) * P.closeFilled[col(t)][i]) / eq : 0);
        const weights = w ? Object.fromEntries(Object.entries(cleanWeights(w)).map(([t, x]) => [t, x === HOLD ? nowW(t) : x]))
          : Object.fromEntries(Object.keys(pos).map((t) => [t, nowW(t)]));
        signal = {
          date: d, kept: !w,
          picks: Object.entries(weights).map(([t, weight]) => ({ ticker: t, weight, close: P.closeFilled[col(t)][i] }))
            .sort((a, b) => b.weight - a.weight),
        };
      }
      break;
    }

    // ---------- 3) 장 마감 후 신호 ----------
    if (st.stopLoss || st.takeProfit) {
      for (const t of Object.keys(pos)) {
        const r = P.closeFilled[col(t)][i] / avg[t] - 1;
        if (st.stopLoss && r <= -st.stopLoss) forced.set(t, "stop_loss");
        else if (st.takeProfit && r >= st.takeProfit) forced.set(t, "take_profit");
      }
    }
    if (reb.has(i) && i + 1 >= st.warmup && i + 1 >= startIdx) {
      const ctx = new StrategyContext(P, i, { ...pos }, { ...avg }, cash, eq, opt.names, activeAt(i), memo);
      const w = opt.strategy(ctx);
      if (w) {
        const clean = cleanWeights(w);
        pending = clean;
        pendingExact = ctx.exact;
        pendingNotes = { ...ctx.notes };
        for (const t in clean) forced.delete(t); // 새 목표에 포함되면 리밸런싱 규칙을 따름
      }
    }
  }

  const finalPositions = Object.entries(pos).map(([t, q]) => ({
    ticker: t, qty: q, avgPrice: avg[t], value: q * P.closeFilled[col(t)][N - 1],
  }));
  return {
    equity: equity.slice(Math.max(0, Math.min(startIdx, Math.max(0, equity.length - 1)))),
    trades: trades.filter((t) => !opt.startDate || t.date >= opt.startDate),
    finalPositions,
    signal,
  };
}

export type { StrategyContext };
