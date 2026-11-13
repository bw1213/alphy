/**
 * 적립 매수 + 하락 시 분할 매도 전략 (화면에서 숫자만 넣어 만드는 전략)
 *
 * 종목마다 따로 움직이는 2단계 사이클:
 *  1) 적립 단계: 정해진 주기마다 일정 금액(총자산의 % 또는 원)을 산다.
 *     사이클 시작 이후(또는 최근 N일) 최고 종가 대비 일정 % / 원 이상 떨어지면 → 2) 로
 *  2) 하락 대응 단계: 일정 금액을 판다. 더 떨어질 때마다(추가 하락폭마다) 또 판다. 이 단계에선 사지 않는다.
 *     바닥에서 일정 % 반등 + 일정 기간 신저가 없음 (+ 선택: 이동평균선 위) → 안정화로 보고 1) 로 돌아가
 *     바로 한 번 사고, 최고가는 그날부터 새로 잰다.
 *
 * 숫자는 모두 파라미터(p.xxx)라서 민감도 검사도 된다. 'Mode' 로 끝나는 파라미터는 선택지 번호라 민감도 검사에서 뺀다.
 * 신호는 매일 종가에 확인하고, 체결은 다음 거래일 시가(엔진 규칙).
 */
import type { StrategyContext } from "../engine/context";
import { HOLD, type Weights } from "../engine/types";

export type Unit = "pct" | "won";
export type BuyPeriod = "W" | "M" | "Q" | "days";

export interface CycleSpec {
  buy: { period: BuyPeriod; days: number; unit: Unit; value: number };
  drop: {
    unit: Unit;
    /** 첫 매도: 최고가 대비 이만큼 떨어지면 */
    value: number;
    /** 추가 매도: 첫 매도 뒤 이만큼 더 떨어질 때마다 */
    step: number;
    /** 추가 매도 최대 횟수 (0 = 다 팔 때까지) */
    maxSteps: number;
    /** 최고가를 재는 기간 (0 = 사이클 시작 이후 전체) */
    peakDays: number;
  };
  sell: { unit: Unit; value: number };
  stable: {
    /** 바닥 대비 이만큼(%) 반등 (0 = 안 봄) */
    rebound: number;
    /** 바닥(최저 종가) 이후 신저가 없이 지난 영업일 (0 = 안 봄) */
    calmDays: number;
    /** 종가가 n일 이동평균선 위 (0 = 안 봄) */
    ma: number;
  };
  /** 투자 비율·리밸런싱: 주식 비중 상한(총자산의 %)과, 상한을 넘으면 되돌리는 주기 */
  limit: { maxInvest: number; rebalance: "off" | "W" | "M" | "Q" };
}

export const defaultCycleSpec = (): CycleSpec => ({
  buy: { period: "M", days: 20, unit: "pct", value: 5 },
  drop: { unit: "pct", value: 10, step: 5, maxSteps: 3, peakDays: 0 },
  sell: { unit: "pct", value: 10 },
  stable: { rebound: 5, calmDays: 10, ma: 0 },
  limit: { maxInvest: 100, rebalance: "off" },
});

const num = (v: unknown, lo: number, hi: number, d: number, int = false) => {
  let x = Number(v);
  if (!Number.isFinite(x)) return d;
  if (int) x = Math.round(x);
  return Math.min(Math.max(x, lo), hi);
};
const unit = (v: unknown, d: Unit): Unit => (v === "won" ? "won" : v === "pct" ? "pct" : d);

/** 저장된 값·화면 입력을 안전한 범위로 정리 */
export function normalizeCycleSpec(x: any): CycleSpec {
  const d = defaultCycleSpec();
  const bu = unit(x?.buy?.unit, d.buy.unit), du = unit(x?.drop?.unit, d.drop.unit), su = unit(x?.sell?.unit, d.sell.unit);
  const amt = (u: Unit, v: unknown, dp: number) => (u === "pct" ? num(v, 0, 100, dp) : num(v, 0, 1e12, 1_000_000));
  const period: BuyPeriod = ["W", "M", "Q", "days"].includes(x?.buy?.period) ? x.buy.period : d.buy.period;
  const s: CycleSpec = {
    buy: { period, days: num(x?.buy?.days, 1, 250, d.buy.days, true), unit: bu, value: amt(bu, x?.buy?.value, d.buy.value) },
    drop: {
      unit: du,
      value: du === "pct" ? num(x?.drop?.value, 0.1, 99, d.drop.value) : num(x?.drop?.value, 1, 1e9, 1000),
      step: du === "pct" ? num(x?.drop?.step, 0.1, 99, d.drop.step) : num(x?.drop?.step, 1, 1e9, 1000),
      maxSteps: num(x?.drop?.maxSteps, 0, 50, d.drop.maxSteps, true),
      peakDays: num(x?.drop?.peakDays, 0, 2000, d.drop.peakDays, true),
    },
    sell: { unit: su, value: amt(su, x?.sell?.value, d.sell.value) },
    stable: {
      rebound: num(x?.stable?.rebound, 0, 500, d.stable.rebound),
      calmDays: num(x?.stable?.calmDays, 0, 500, d.stable.calmDays, true),
      ma: num(x?.stable?.ma, 0, 500, d.stable.ma, true),
    },
    limit: {
      maxInvest: num(x?.limit?.maxInvest, 1, 100, d.limit.maxInvest),
      rebalance: ["W", "M", "Q"].includes(x?.limit?.rebalance) ? x.limit.rebalance : "off",
    },
  };
  // 안정화 조건이 하나도 없으면 영원히 다시 사지 않으므로 최소 하나는 켬
  if (!s.stable.rebound && !s.stable.calmDays && !s.stable.ma) s.stable.calmDays = d.stable.calmDays;
  return s;
}

const PERIOD_CODE: Record<BuyPeriod, number> = { W: 0, M: 1, Q: 2, days: 3 };
const PERIOD_FROM_CODE: BuyPeriod[] = ["W", "M", "Q", "days"];
const REB_CODE = { off: 0, W: 1, M: 2, Q: 3 } as const;
const REB_FROM_CODE = ["off", "W", "M", "Q"] as const;

/** 화면 값 → 전략 파라미터(모두 숫자) */
export function cycleParams(spec: CycleSpec): Record<string, number> {
  const s = normalizeCycleSpec(spec);
  return {
    buyPeriodMode: PERIOD_CODE[s.buy.period], buyDays: s.buy.days,
    buyUnitMode: s.buy.unit === "won" ? 1 : 0, buyValue: s.buy.value,
    dropUnitMode: s.drop.unit === "won" ? 1 : 0, dropValue: s.drop.value, dropStep: s.drop.step,
    maxSteps: s.drop.maxSteps, peakDays: s.drop.peakDays,
    sellUnitMode: s.sell.unit === "won" ? 1 : 0, sellValue: s.sell.value,
    rebound: s.stable.rebound, calmDays: s.stable.calmDays, stableMa: s.stable.ma,
    maxInvest: s.limit.maxInvest, rebalanceMode: REB_CODE[s.limit.rebalance],
  };
}

/** 이 전략의 코드: 실제 동작은 lib.cycle 에 있고, 코드 작성 화면에서 앞뒤로 조건을 붙여 고칠 수 있다 */
export const CYCLE_CODE = `// 적립 매수 + 하락 시 분할 매도 (숫자는 아래 파라미터에서 바뀝니다)
// 매일 종가에 확인하고 다음 거래일 시가에 매매합니다. "종목 직접 입력"에 넣은 종목마다 따로 돌아갑니다.
return lib.cycle(ctx, p);`;

/** 지표 계산에 필요한 워밍업(영업일) */
export const cycleWarmup = (spec: CycleSpec) => Math.max(1, normalizeCycleSpec(spec).stable.ma) + 1;

const won = (x: number) => `${Math.round(x).toLocaleString("ko-KR")}원`;
const amount = (u: Unit, v: number) => (u === "pct" ? `총자산의 ${v}%` : won(v));
const fall = (u: Unit, v: number) => (u === "pct" ? `${v}%` : `주당 ${won(v)}`);

/** 사람이 읽는 설명 */
export function describeCycle(spec: CycleSpec): string[] {
  const s = normalizeCycleSpec(spec);
  const when = { W: "매주 첫 거래일", M: "매월 첫 거래일", Q: "분기마다 첫 거래일", days: `${s.buy.days}영업일마다` }[s.buy.period];
  const peak = s.drop.peakDays ? `최근 ${s.drop.peakDays}영업일 최고 종가` : "이번 사이클을 시작한 뒤의 최고 종가";
  const stable = [
    s.stable.rebound ? `바닥에서 ${s.stable.rebound}% 이상 반등` : "",
    s.stable.calmDays ? `${s.stable.calmDays}영업일 동안 신저가 없음` : "",
    s.stable.ma ? `종가가 ${s.stable.ma}일 이동평균선 위` : "",
  ].filter(Boolean).join(", ");
  return [
    `적립: ${when}에 종목마다 ${amount(s.buy.unit, s.buy.value)}만큼 삽니다(현금이 모자라면 있는 만큼).`,
    `하락 대응: ${peak} 대비 ${fall(s.drop.unit, s.drop.value)} 이상 떨어지면 매수를 멈추고 ${amount(s.sell.unit, s.sell.value)}만큼 팝니다.`,
    `추가 매도: 그 뒤 ${fall(s.drop.unit, s.drop.step)} 더 떨어질 때마다 ${amount(s.sell.unit, s.sell.value)}씩 더 팝니다${s.drop.maxSteps ? ` (최대 ${s.drop.maxSteps}번)` : " (다 팔 때까지)"}.`,
    `다시 적립: ${stable} 조건을 모두 만족하면 안정된 것으로 보고 바로 한 번 사고 적립을 다시 시작합니다. 최고가는 그날부터 새로 잽니다.`,
    ...(s.limit.maxInvest < 100 || s.limit.rebalance !== "off" ? [
      `투자 비율: 주식은 총자산의 ${s.limit.maxInvest}%까지만 삽니다${s.limit.rebalance !== "off"
        ? `. ${{ W: "매주", M: "매월", Q: "분기마다" }[s.limit.rebalance]} 첫 거래일에 주가가 올라 이 비율을 넘었으면 종목별로 같은 비율만큼 팔아 맞춥니다`
        : ""}.`] : []),
  ];
}

/* ------------------------------------------------------------------ */
interface TickerState {
  phase: "buy" | "sell";
  /** 이번 사이클 시작일 (최고가를 재는 시작점) */
  start: number;
  /** 매도 단계: 기준 최고가, 매도 횟수, 바닥, 바닥 날짜 */
  peak: number;
  steps: number;
  trough: number;
  troughAt: number;
  lastBuyKey: string;
  lastBuyAt: number;
}

const periodKey = (date: string, mode: BuyPeriod): string => {
  const y = date.slice(0, 4), m = Number(date.slice(5, 7));
  if (mode === "M") return `${y}-${m}`;
  if (mode === "Q") return `${y}-Q${Math.ceil(m / 3)}`;
  const dt = new Date(date + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
};

/**
 * 하루치 판단. 매일 호출해야 한다(리밸런싱 '매일').
 * 사고팔 종목만 목표 비중을 주고 나머지 보유 종목은 HOLD, 할 일이 없으면 null.
 */
export function cycle(ctx: StrategyContext, p: Record<string, number>): Weights | null {
  const st: Record<string, TickerState> = (ctx.state.cycle ??= {});
  const period = PERIOD_FROM_CODE[p.buyPeriodMode] ?? "M";
  const eq = ctx.equity;
  if (!(eq > 0)) return null;
  const amt = (mode: number, v: number) => (mode === 1 ? v : (eq * v) / 100);
  const dropOf = (peak: number, c: number) => (p.dropUnitMode === 1 ? peak - c : (1 - c / peak) * 100);

  const out: Weights = {};
  let spare = ctx.cash; // 오늘 매수에 쓸 수 있는 현금 (여러 종목이 나눠 씀)
  const cap = Math.min(Math.max(p.maxInvest ?? 100, 0), 100) / 100;
  let room = cap - ctx.held().reduce((a, t) => a + ctx.weight(t), 0); // 주식 비중 상한까지 남은 비중
  let acted = false;
  const buy = (t: string, c: number, s: TickerState) => {
    const want = Math.min(amt(p.buyUnitMode, p.buyValue), spare * 0.995, Math.max(0, room) * eq); // 수수료·슬리피지 여유, 투자 비율 상한
    s.lastBuyKey = periodKey(ctx.date, period);
    s.lastBuyAt = ctx.i;
    if (want < c) return; // 한 주도 못 삼
    spare -= want;
    room -= want / eq;
    out[t] = ctx.weight(t) + want / eq;
    acted = true;
  };
  const sell = (t: string, times: number) => {
    if (!ctx.positions[t]) return;
    const w = Math.max(0, ctx.weight(t) - (amt(p.sellUnitMode, p.sellValue) * times) / eq);
    room += ctx.weight(t) - w;
    out[t] = w;
    acted = true;
  };

  for (const t of ctx.tickers) {
    const c = ctx.close(t);
    if (!Number.isFinite(c) || c <= 0) continue;
    const s = (st[t] ??= { phase: "buy", start: ctx.i, peak: c, steps: 0, trough: c, troughAt: ctx.i, lastBuyKey: "", lastBuyAt: -1e9 });

    if (s.phase === "buy") {
      const from = p.peakDays > 0 ? Math.max(s.start, ctx.i - p.peakDays + 1) : s.start;
      const hist = ctx.history(t, ctx.i - from + 1, "close").filter(Number.isFinite);
      const peak = hist.length ? Math.max(...hist) : c;
      if (dropOf(peak, c) >= p.dropValue) {
        Object.assign(s, { phase: "sell", peak, steps: 1, trough: c, troughAt: ctx.i });
        sell(t, 1);
        continue;
      }
      const due = period === "days"
        ? ctx.i - s.lastBuyAt >= Math.max(1, p.buyDays)
        : periodKey(ctx.date, period) !== s.lastBuyKey;
      if (due) buy(t, c, s);
      continue;
    }

    // 하락 대응 단계
    if (c < s.trough) { s.trough = c; s.troughAt = ctx.i; }
    let more = 0;
    while (p.dropStep > 0 && more < 100 && (!p.maxSteps || s.steps - 1 < p.maxSteps) && dropOf(s.peak, c) >= p.dropValue + s.steps * p.dropStep) {
      s.steps++; more++;
    }
    if (more) { sell(t, more); continue; }
    const okRebound = !p.rebound || (c / s.trough - 1) * 100 >= p.rebound;
    const okCalm = !p.calmDays || ctx.i - s.troughAt >= p.calmDays;
    const okMa = !p.stableMa || c > ctx.sma(t, p.stableMa);
    if ((p.rebound || p.calmDays || p.stableMa) && okRebound && okCalm && okMa) {
      Object.assign(s, { phase: "buy", start: ctx.i, peak: c, steps: 0 });
      buy(t, c, s);
    }
  }

  // 리밸런싱: 정한 주기의 첫 거래일에 주식 비중이 상한을 넘었으면 종목별로 같은 비율만큼 줄임
  const reb = REB_FROM_CODE[p.rebalanceMode] ?? "off";
  if (reb !== "off" && periodKey(ctx.date, reb) !== ctx.state.cycleRebKey) {
    ctx.state.cycleRebKey = periodKey(ctx.date, reb);
    const next = (t: string) => (t in out ? out[t] : ctx.weight(t));
    const total = ctx.held().reduce((a, t) => a + next(t), 0);
    if (total > cap + 0.005) {
      for (const t of ctx.held()) out[t] = (next(t) * cap) / total;
      acted = true;
    }
  }

  if (!acted) return null;
  for (const t of ctx.held()) if (!(t in out)) out[t] = HOLD;
  ctx.exact = true;
  return out;
}

/** 전략 코드에서 쓸 수 있는 도우미 (compileStrategy 가 lib 로 넘김) */
export const STRATEGY_LIB = { cycle, HOLD } as const;
