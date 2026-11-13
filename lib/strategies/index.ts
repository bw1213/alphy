import type { StrategyContext } from "../engine/context";
import type { Rebalance, Weights } from "../engine/types";
import { STRATEGY_LIB } from "./cycle";

export interface ParamSpec {
  key: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

export type Params = Record<string, number>;

export interface StrategyDef {
  id: string;
  name: string;
  description: string;
  params: ParamSpec[];
  rebalance: Rebalance;
  stopLoss: number | null;
  takeProfit: number | null;
  warmup: (p: Params) => number;
  targetWeights: (ctx: StrategyContext, p: Params) => Weights | null | undefined;
  /** 웹에서 '내 전략'으로 복사할 때 쓰는 동일 로직의 코드 */
  code: string;
}

/* ------------------------------------------------------------------ */
const momentumCode = `// 모멘텀 + 시장 필터
// KOSPI 가 marketMa 일선 아래면 전량 현금
if (p.marketMa && ctx.bench() < ctx.benchSma(p.marketMa)) return {};
const picks = ctx.topBy(
  (t) => ctx.ret(t, p.lookback, p.skip),            // 최근 skip 일 제외한 lookback 일 수익률
  p.topK,
  (t) => ctx.tradingValue(t, 20) >= p.minValueEok * 1e8 && ctx.ret(t, p.lookback, p.skip) > 0,
);
return ctx.equal(picks);`;

const maCrossCode = `// 이동평균 정배열 추세추종: 단기MA > 장기MA 이고 종가 > 단기MA
const ok = (t) => ctx.sma(t, p.short) > ctx.sma(t, p.long) && ctx.close(t) > ctx.sma(t, p.short);
const keep = ctx.held().filter(ok);                   // 조건 유지 중인 보유 종목은 계속 보유
const fresh = ctx.topBy((t) => ctx.close(t) / ctx.sma(t, p.short) - 1, p.maxPos - keep.length,
  (t) => ok(t) && !keep.includes(t));
const w = {};
for (const t of [...keep, ...fresh]) w[t] = 1 / p.maxPos;
return w;`;

const rsiCode = `// RSI 과매도 반등: 상승추세(종가 > trendMa) 종목 중 RSI < buyBelow 매수, RSI > sellAbove 매도
const keep = ctx.held().filter((t) => ctx.rsi(t, p.period) < p.sellAbove);
const fresh = ctx.topBy((t) => -ctx.rsi(t, p.period), p.maxPos - keep.length,
  (t) => !keep.includes(t) && ctx.rsi(t, p.period) < p.buyBelow && ctx.close(t) > ctx.sma(t, p.trendMa));
if (fresh.length === 0 && keep.length === ctx.held().length) return null; // 변화 없음 → 매매 안 함
const w = {};
for (const t of keep) w[t] = ctx.weight(t);
for (const t of fresh) w[t] = 1 / p.maxPos;
return w;`;

const breakoutCode = `// 신고가 돌파: 최근 highDays 일 최고 종가의 nearHigh 배 이상인 종목 중 거래대금이 큰 순서로 보유
// KOSPI 가 marketMa 일선 아래면 새로 사지 않고 전량 현금
if (p.marketMa && ctx.bench() < ctx.benchSma(p.marketMa)) return {};
const picks = ctx.topBy(
  (t) => ctx.tradingValue(t, 20),
  p.topK,
  (t) => ctx.close(t) >= ctx.highest(t, p.highDays, "close") * p.nearHigh,
);
return ctx.equal(picks);`;

const lowVolCode = `// 저변동성 + 추세: 종가가 trendMa 일선 위인 종목 중 최근 volDays 일 변동성이 가장 낮은 종목
const picks = ctx.topBy(
  (t) => -ctx.volatility(t, p.volDays),
  p.topK,
  (t) => ctx.close(t) > ctx.sma(t, p.trendMa) && ctx.tradingValue(t, 20) >= p.minValueEok * 1e8,
);
return ctx.equal(picks);`;

/** 코드 문자열 → 함수. 브라우저(사용자 본인 PC)에서만 실행된다. 코드에서는 lib.cycle 같은 도우미도 쓸 수 있다. */
export function compileStrategy(code: string): (ctx: StrategyContext, p: Params) => Weights | null | undefined {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("ctx", "p", "lib", `"use strict";\n${code}`) as (ctx: StrategyContext, p: Params, lib: typeof STRATEGY_LIB) => Weights | null;
  return (ctx, p) => fn(ctx, p, STRATEGY_LIB);
}

export const STRATEGIES: StrategyDef[] = [
  {
    id: "momentum",
    name: "모멘텀 + 시장 필터",
    description: "매월 말, 최근 1개월을 제외한 6개월 수익률 상위 종목을 동일비중으로 보유. KOSPI가 200일선 아래면 전량 현금.",
    params: [
      { key: "lookback", label: "모멘텀 기간(일)", default: 120, min: 20, max: 500, step: 10 },
      { key: "skip", label: "최근 제외 기간(일)", default: 20, min: 0, max: 60, step: 5 },
      { key: "topK", label: "보유 종목 수", default: 10, min: 1, max: 50 },
      { key: "marketMa", label: "시장 필터 이평(일, 0=끔)", default: 200, min: 0, max: 300, step: 10 },
      { key: "minValueEok", label: "최소 거래대금(억원/일)", default: 5, min: 0, max: 1000 },
    ],
    rebalance: "M", stopLoss: null, takeProfit: null,
    warmup: (p) => Math.max(p.lookback, p.marketMa) + 1,
    targetWeights: compileStrategy(momentumCode),
    code: momentumCode,
  },
  {
    id: "ma_cross",
    name: "이동평균 정배열",
    description: "단기 이평이 장기 이평 위, 종가가 단기 이평 위인 종목을 매주 최대 N개 보유. 손절 -10%.",
    params: [
      { key: "short", label: "단기 이평(일)", default: 20, min: 3, max: 120 },
      { key: "long", label: "장기 이평(일)", default: 60, min: 10, max: 300 },
      { key: "maxPos", label: "최대 보유 종목", default: 10, min: 1, max: 50 },
    ],
    rebalance: "W", stopLoss: 0.1, takeProfit: null,
    warmup: (p) => p.long + 1,
    targetWeights: compileStrategy(maCrossCode),
    code: maCrossCode,
  },
  {
    id: "rsi_reversal",
    name: "RSI 과매도 반등",
    description: "장기 상승추세 종목의 RSI가 과매도일 때 매수, 회복 시 매도. 익절 +15%, 손절 -7%.",
    params: [
      { key: "period", label: "RSI 기간", default: 14, min: 2, max: 50 },
      { key: "buyBelow", label: "매수 RSI 미만", default: 30, min: 5, max: 50 },
      { key: "sellAbove", label: "매도 RSI 초과", default: 60, min: 40, max: 95 },
      { key: "trendMa", label: "추세 이평(일)", default: 120, min: 20, max: 300 },
      { key: "maxPos", label: "최대 보유 종목", default: 10, min: 1, max: 50 },
    ],
    rebalance: "D", stopLoss: 0.07, takeProfit: 0.15,
    warmup: (p) => p.trendMa + 1,
    targetWeights: compileStrategy(rsiCode),
    code: rsiCode,
  },
  {
    id: "breakout",
    name: "신고가 돌파",
    description: "최근 1년 최고가 근처(95% 이상)에 있는 종목 중 거래대금이 큰 종목을 매주 보유. KOSPI가 120일선 아래면 현금. 손절 -10%.",
    params: [
      { key: "highDays", label: "신고가 기간(일)", default: 250, min: 20, max: 500, step: 10 },
      { key: "nearHigh", label: "신고가 대비 비율", default: 0.95, min: 0.5, max: 1, step: 0.01 },
      { key: "topK", label: "보유 종목 수", default: 10, min: 1, max: 50 },
      { key: "marketMa", label: "시장 필터 이평(일, 0=끔)", default: 120, min: 0, max: 300, step: 10 },
    ],
    rebalance: "W", stopLoss: 0.1, takeProfit: null,
    warmup: (p) => Math.max(p.highDays, p.marketMa) + 1,
    targetWeights: compileStrategy(breakoutCode),
    code: breakoutCode,
  },
  {
    id: "low_vol",
    name: "저변동성 + 추세",
    description: "120일선 위에 있는 종목 중 최근 변동성이 가장 낮은 종목을 매월 보유. 수익은 낮아도 낙폭을 줄이는 쪽.",
    params: [
      { key: "volDays", label: "변동성 기간(일)", default: 60, min: 10, max: 250, step: 5 },
      { key: "trendMa", label: "추세 이평(일)", default: 120, min: 20, max: 300, step: 10 },
      { key: "topK", label: "보유 종목 수", default: 15, min: 1, max: 50 },
      { key: "minValueEok", label: "최소 거래대금(억원/일)", default: 5, min: 0, max: 1000 },
    ],
    rebalance: "M", stopLoss: null, takeProfit: null,
    warmup: (p) => Math.max(p.volDays, p.trendMa) + 1,
    targetWeights: compileStrategy(lowVolCode),
    code: lowVolCode,
  },
];

export const CUSTOM_TEMPLATE = `// 장 마감 후 호출됩니다. 오늘까지의 데이터만 볼 수 있어요.
// 반환: { 티커: 비중 }  →  다음 영업일 시가에 그 비중대로 매매
//   {} 반환 = 전량 현금, null 반환 = 이번엔 매매 안 함
//
// ctx.tickers                     유니버스 종목코드 목록
// ctx.close(t, ago=0)             종가 (ago=1 이면 전일). open/high/low/volume 도 동일
// ctx.ret(t, n, skip=0)           n일 수익률
// ctx.sma(t, n) / ctx.rsi(t, n)   이동평균 / RSI
// ctx.tradingValue(t, n)          n일 평균 거래대금(원)
// ctx.highest(t, n) / lowest      n일 최고가 / 최저가
// ctx.bench() / ctx.benchSma(n)   KOSPI 지수 / 지수 이동평균
// ctx.held() / ctx.weight(t) / ctx.pnl(t)   보유 종목 / 비중 / 평단 대비 수익률
// ctx.topBy(scoreFn, k, filterFn) 점수 상위 k 종목
// ctx.equal(tickers)              동일비중 {티커: 1/n}
// ctx.state                       백테스트 동안 유지되는 메모 객체 (날짜를 넘어 기억할 값)
// lib.HOLD                        비중 대신 주면 그 종목은 지금 수량 그대로
// lib.cycle(ctx, p)               적립 매수 + 하락 시 분할 매도 (조건 화면의 "적립·분할 매도"와 같음)
// p.xxx                           아래 '파라미터(JSON)' 값

// 예: 52주 신고가 근처(95% 이상) + 거래대금 상위 종목
const picks = ctx.topBy(
  (t) => ctx.tradingValue(t, 20),
  p.topK,
  (t) => ctx.close(t) >= ctx.highest(t, 250, "close") * p.nearHigh,
);
return ctx.equal(picks);`;

export const CUSTOM_PARAMS = `{ "topK": 5, "nearHigh": 0.95 }`;
