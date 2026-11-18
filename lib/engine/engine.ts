/**
 * 일봉 포트폴리오 백테스트 엔진.
 *
 * 타이밍 규칙 (미래 데이터 사용 방지)
 *  - t일 장 마감 후: 전략이 t일까지의 데이터로 목표 비중 결정, 손절/익절 조건 확인
 *  - t+1일 시가: 매도 먼저, 그 다음 매수 (정수 주)
 *  - 거래정지(거래량 0)·가격 없음 종목은 그날 매매하지 않음
 *  - 장중 매도(settings.intraday): 시가 체결 뒤, 손절·익절과 전략이 걸어 둔 매도 가격(ctx.stops)을
 *    그날 저가·고가로 확인해 닿으면 그 가격(시가가 이미 넘었으면 시가)에 판다. 종가 기준 손절·익절은 하지 않음
 */
import { buildPanel, StrategyContext, type Panel } from "./context";
import { buyFeeRate, DEFAULT_COSTS, sellFeeRate } from "./costs";
import { HOLD } from "./types";
import { dividendBook, type DividendTax } from "./dividends";
import type { BacktestResult, DividendData, DividendPayment, CostSettings, EquityPoint, PriceData, Rebalance, RunSettings, Signal, StopOrder, Trade, UniverseSnapshot, Weights } from "./types";

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
  /** 배당금·분배금 이력. 주면 배당락일 장 시작 전에 들고 있던 수량만큼 세후 금액이 현금으로 들어온다 */
  dividends?: DividendData | null;
  /** 배당소득세율 (0.154 = 15.4%). 종목별로 다르면 함수. 기본 15.4% */
  dividendTax?: DividendTax;
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

/** 다음 평일 (주말만 건너뜀. 휴일은 모름) */
const nextWeekday = (d: string) => {
  const t = new Date(d + "T00:00:00Z");
  do t.setUTCDate(t.getUTCDate() + 1); while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  return t.toISOString().slice(0, 10);
};
const periodKey = (d: string, rule: "W" | "M" | "Q") => {
  if (rule === "M") return d.slice(0, 7);
  if (rule === "Q") return `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`;
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
};

/**
 * 데이터 마지막 날(k = dates.length - 1)이 리밸런싱 주기상 매매할 날인지 (자동 매매 저녁 계산용).
 * 백테스트는 기간의 마지막 영업일에 신호를 내는데, 마지막 날은 내일 시세가 없어 기간이 끝나는지 모른다.
 * 그래서 다음 평일이 새 기간이면 매매할 날로 보고, 휴일 때문에 그날을 놓쳤으면(어제가 매매할 날이 아니었는데
 * 오늘이 새 기간의 첫 거래일) 오늘 늦게라도 맞춘다.
 */
export function dueOnLastDay(dates: string[], rule: Rebalance): boolean {
  const k = dates.length - 1;
  if (k < 0 || rule === "D") return true;
  if (typeof rule === "number") return k % Math.max(1, rule) === 0;
  const endsPeriod = (d: string) => periodKey(nextWeekday(d), rule) !== periodKey(d, rule);
  if (endsPeriod(dates[k])) return true;
  return k > 0 && periodKey(dates[k], rule) !== periodKey(dates[k - 1], rule) && !endsPeriod(dates[k - 1]);
}

export function runBacktest(opt: RunOptions): BacktestResult {
  const costs = opt.costs ?? DEFAULT_COSTS;
  const st = opt.settings;
  const P: Panel = buildPanel(opt.data, opt.benchmark);
  const { dates, tickers } = P;
  const N = dates.length;
  const reb = rebalanceDays(dates, st.rebalance);
  // 시작일이 데이터보다 뒤면(자동 매매 첫날 저녁) 거래 없이 마지막 날 신호만 계산
  const found = opt.startDate ? dates.findIndex((d) => d >= opt.startDate!) : 0;
  const startIdx = found < 0 ? N : found;

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
  /** 정확히 따르는 신호(ctx.exact)일 때 신호 낸 날 종가 기준 비중: 사려던 종목은 사기만, 팔려던 종목은 팔기만 하게 */
  let pendingFrom: Record<string, number> = {};
  const memo: Record<string, any> = {};
  let forced = new Map<string, Trade["reason"]>();
  let signal: Signal | null = null;
  const intraday = !!st.intraday;
  /** 장중 매도 모드: 전략이 걸어 둔 매도 가격 (다음에 전략을 부를 때까지 유지, 체결되면 빠짐) */
  let stops: Record<string, StopOrder[]> = {};
  /** 오늘 장중 체결 (전략에 ctx.filled 로 전달) */
  let fills: Record<string, { n: number; qty: number; price: number }> = {};
  const makeCtx = (i: number, eq: number) => {
    const c = new StrategyContext(P, i, { ...pos }, { ...avg }, cash, eq, opt.names, activeAt(i), memo);
    c.intraday = intraday;
    c.filled = fills;
    return c;
  };
  const divBook = dividendBook(dates, opt.dividends, opt.dividendTax);
  const divs: DividendPayment[] = [];

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
  /** 방금 넣은 거래에 거래 직후 예수금·그 종목 잔고(보유 수량)를 적어 둠 */
  const stampLast = (t: string) => { const x = trades[trades.length - 1]; x.cash = cash; x.held = pos[t] ?? 0; };

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

    // ---------- 0.5) 배당락: 어제 종가까지 들고 있던 수량만큼 받음 (오늘 시가에 팔아도 받고, 사도 못 받음) ----------
    // 실제 입금은 몇 주 뒤지만 배당락으로 떨어진 주가와 맞추려고 배당락일 장 마감 때 현금에 넣는다
    let divCash = 0;
    if (divBook.has) for (const [t, q] of Object.entries(pos)) {
      const p = divBook.pay(t, i, q, d);
      if (p) { divs.push(p); divCash += p.net; }
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
          const px = o * (1 + costs.slippage) * (1 + buyFeeRate(costs, t));
          target[t] = Math.floor((eqOpen * w) / px);
          const from = pendingExact ? pendingFrom[t] : undefined;
          if (from !== undefined) {
            const q = pos[t] ?? 0;
            // 시가가 갭으로 뛰거나 비용 몫 때문에 비중 계산이 어긋나도 매수 신호가 매도로 뒤집히지 않게:
            // 사려던 종목은 신호 때 늘리려던 비중만큼만 더 사고, 팔려던 종목은 지금보다 늘리지 않음
            if (w > from + 1e-9) target[t] = q + Math.max(0, Math.floor((eqOpen * (w - from)) / px));
            else if (w < from - 1e-9) target[t] = Math.min(target[t], q);
            else target[t] = q;
          }
        }
        for (const t of Object.keys(pos)) if (!tradable(t)) target[t] = pos[t];
      }
      for (const t of forced.keys()) if (tradable(t)) target[t] = 0;

      const year = Number(d.slice(0, 4));
      // 매도
      for (const t of Object.keys(pos)) {
        const q = pos[t], tgt = target[t] ?? 0;
        if (q > tgt && tradable(t)) {
          const n = q - tgt;
          const px = P.open[col(t)][i] * (1 - costs.slippage);
          const gross = n * px;
          const fee = gross * sellFeeRate(costs, t, year);
          cash += gross - fee;
          trades.push({ date: d, ticker: t, side: "SELL", qty: n, price: px, fee,
            pnl: (px - avg[t]) * n - fee, ret: px / avg[t] - 1, reason: forced.get(t) ?? "rebalance",
            ...(!forced.has(t) && pendingNotes[t] ? { note: pendingNotes[t] } : {}) });
          if (tgt === 0) { delete pos[t]; delete avg[t]; } else pos[t] = tgt;
          stampLast(t);
        }
      }
      // 매수 (현금 부족 시 가능한 만큼)
      for (const [t, tgt] of Object.entries(target)) {
        const q = pos[t] ?? 0;
        if (tgt > q && tradable(t)) {
          const px = P.open[col(t)][i] * (1 + costs.slippage);
          const rate = buyFeeRate(costs, t);
          const n = Math.min(tgt - q, Math.floor(cash / (px * (1 + rate))));
          if (n <= 0) continue;
          const fee = n * px * rate;
          cash -= n * px + fee;
          avg[t] = ((avg[t] ?? 0) * q + px * n) / (q + n);
          pos[t] = q + n;
          trades.push({ date: d, ticker: t, side: "BUY", qty: n, price: px, fee, pnl: null, ret: null, reason: "rebalance",
            ...(pendingNotes[t] ? { note: pendingNotes[t] } : {}) });
          stampLast(t);
        }
      }
      pending = null;
      pendingExact = false;
      pendingNotes = {};
      pendingFrom = {};
      forced = new Map();
    }

    // ---------- 1.2) 장중 매도 (장중 매도 모드) ----------
    fills = {};
    if (intraday) {
      const year = Number(d.slice(0, 4));
      const sellAt = (t: string, n: number, raw: number, reason: Trade["reason"], note?: string) => {
        const px = raw * (1 - costs.slippage);
        const gross = n * px;
        const fee = gross * sellFeeRate(costs, t, year);
        cash += gross - fee;
        trades.push({ date: d, ticker: t, side: "SELL", qty: n, price: px, fee, pnl: (px - avg[t]) * n - fee, ret: px / avg[t] - 1, reason, ...(note ? { note } : {}) });
        if (pos[t] - n <= 0) { delete pos[t]; delete avg[t]; } else pos[t] -= n;
        stampLast(t);
      };
      for (const t of Object.keys(pos)) {
        const k = col(t);
        const o = P.open[k][i], h = P.high[k][i], l = P.low[k][i], v = P.volume[k][i];
        if (!(Number.isFinite(o) && o > 0 && Number.isFinite(v) && v > 0)) continue;
        const lo = Number.isFinite(l) ? l : Math.min(o, P.close[k][i]);
        const hi = Number.isFinite(h) ? h : Math.max(o, P.close[k][i]);
        // 손절·익절 (평단 기준). 같은 날 둘 다 닿으면 보수적으로 손절
        const sl = st.stopLoss ? avg[t] * (1 - st.stopLoss) : NaN;
        const tp = st.takeProfit ? avg[t] * (1 + st.takeProfit) : NaN;
        if (lo <= sl) { sellAt(t, pos[t], Math.min(o, sl), "stop_loss"); continue; }
        if (hi >= tp) { sellAt(t, pos[t], Math.max(o, tp), "take_profit"); continue; }
        // 전략이 걸어 둔 매도 (높은 가격부터)
        const list = (stops[t] ?? []).slice().sort((a, b) => b.below - a.below);
        const left: StopOrder[] = [];
        for (const so of list) {
          if (pos[t] && lo <= so.below && so.qty > 0) {
            const n = Math.min(pos[t], Math.floor(so.qty));
            const raw = Math.min(o, so.below);
            const f = (fills[t] ??= { n: 0, qty: 0, price: raw });
            f.n++; f.qty += n; f.price = raw;
            if (n > 0) sellAt(t, n, raw, "rebalance", so.note);
          } else left.push(so);
        }
        if (stops[t]) stops[t] = left;
      }
    }

    // ---------- 1.5) 상장폐지 청산 ----------
    // 시세가 끊긴 뒤 다시 나오지 않는 종목은 마지막 종가에 판 것으로 처리 (정리매매 가격이 마지막 종가에 반영돼 있음)
    for (const t of Object.keys(pos)) {
      const li = lastIdx.get(t)!;
      if (li < N - 1 - DELIST_AFTER_DAYS && i === li + 1) {
        const q = pos[t], px = P.closeFilled[col(t)][li];
        const gross = q * px;
        const fee = gross * sellFeeRate(costs, t, Number(d.slice(0, 4)));
        cash += gross - fee;
        trades.push({ date: d, ticker: t, side: "SELL", qty: q, price: px, fee, pnl: (px - avg[t]) * q - fee, ret: px / avg[t] - 1, reason: "delisted" });
        delete pos[t]; delete avg[t];
        stampLast(t);
        forced.delete(t);
      }
    }

    cash += divCash;

    // ---------- 2) 종가 평가 ----------
    let invested = 0;
    for (const [t, q] of Object.entries(pos)) invested += q * P.closeFilled[col(t)][i];
    const eq = cash + invested;
    prevEq = eq;
    equity.push({ date: d, equity: eq, nav: units > 0 ? eq / units : eq, contributed, cash, invested, benchmark: P.bench ? P.bench[i] : null });

    if (i === N - 1) {
      // 마지막 날: 리밸런싱 주기와 상관없이 "지금 전략이 고르는 종목"을 계산 (추천 종목용, 체결은 없음)
      if (i + 1 >= st.warmup) {
        const lastCtx = makeCtx(i, eq);
        const w = opt.strategy(lastCtx);
        const nowW = (t: string) => (eq > 0 ? ((pos[t] ?? 0) * P.closeFilled[col(t)][i]) / eq : 0);
        const weights = w ? Object.fromEntries(Object.entries(cleanWeights(w)).map(([t, x]) => [t, x === HOLD ? nowW(t) : x]))
          : Object.fromEntries(Object.keys(pos).map((t) => [t, nowW(t)]));
        const notes = Object.keys(lastCtx.notes ?? {}).length ? { ...lastCtx.notes } : undefined;
        const nextStops = intraday ? Object.fromEntries(Object.entries(lastCtx.stops).filter(([, v]) => v?.length)) : {};
        signal = {
          date: d, kept: !w, due: dueOnLastDay(dates, st.rebalance), ...(notes ? { notes } : {}), ...(Object.keys(nextStops).length ? { stops: nextStops } : {}),
          picks: Object.entries(weights).map(([t, weight]) => ({ ticker: t, weight, close: P.closeFilled[col(t)][i] }))
            .sort((a, b) => b.weight - a.weight),
        };
      }
      break;
    }

    // ---------- 3) 장 마감 후 신호 ----------
    if (!intraday && (st.stopLoss || st.takeProfit)) {
      for (const t of Object.keys(pos)) {
        const r = P.closeFilled[col(t)][i] / avg[t] - 1;
        if (st.stopLoss && r <= -st.stopLoss) forced.set(t, "stop_loss");
        else if (st.takeProfit && r >= st.takeProfit) forced.set(t, "take_profit");
      }
    }
    if (reb.has(i) && i + 1 >= st.warmup && i + 1 >= startIdx) {
      const ctx = makeCtx(i, eq);
      const w = opt.strategy(ctx);
      if (intraday) stops = Object.fromEntries(Object.entries(ctx.stops).filter(([t, v]) => v?.length && P.index.has(t)));
      if (w) {
        const clean = cleanWeights(w);
        pending = clean;
        pendingExact = ctx.exact;
        pendingNotes = { ...ctx.notes };
        pendingFrom = ctx.exact && eq > 0
          ? Object.fromEntries(Object.keys(clean).map((t) => [t, ((pos[t] ?? 0) * P.closeFilled[col(t)][i]) / eq])) : {};
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
    state: memo,
    ...(divBook.has ? { dividends: divs.filter((x) => !opt.startDate || x.date >= opt.startDate) } : {}),
  };
}

export type { StrategyContext };
