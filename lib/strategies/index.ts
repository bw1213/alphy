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

const levMixCode = `// 레버리지 분산: 가장 많이 출렁이는 종목(레버리지 ETF)에 p.main%, 나머지 종목에 똑같이 나눠 담고
// p.months 개월마다(3 = 분기) 새 기간의 첫 거래일 종가에 비중을 다시 맞춘다(체결은 다음 날 시가).
// 그 밖의 날은 null(매매 안 함) → 자동 매매도 매일 사고팔지 않음
const ts = ctx.tickers.filter((t) => ctx.close(t) > 0);
if (!ts.length) return {};
const vol = (t) => { const v = ctx.volatility(t, 250); return Number.isFinite(v) ? v : ctx.volatility(t, 60) || 0; };
const main = [...ts].sort((a, b) => vol(b) - vol(a))[0];
const rest = ts.filter((t) => t !== main);
const w = {};
w[main] = rest.length ? p.main / 100 : 1;
for (const t of rest) w[t] = (1 - p.main / 100) / rest.length;
const m = Number(ctx.date.slice(0, 4)) * 12 + Number(ctx.date.slice(5, 7)) - 1;
const period = Math.floor(m / Math.max(1, p.months));
if (ctx.state.period === period) return null;
ctx.state.period = period;
for (const t of ts) ctx.notes[t] = "정기 리밸런싱";
return w;`;

const levGuardCode = `// 레버리지 분산 + 변동성 방어: 평소엔 가장 많이 출렁이는 종목(레버리지 ETF)에 p.main%, 나머지 종목에 똑같이.
// 레버리지 종목의 20일 변동성(연)이 p.v0% ~ p.v1% 사이 다섯 기준을 하나씩 넘을 때마다 레버리지 비중을 p.low% 쪽으로 한 칸씩 줄인다.
// 각 기준은 변동성이 그 기준의 p.back% 아래로 내려와야 다시 늘린다(바로 되돌아가며 사고파는 것을 막음).
// 추세: 레버리지 종목이 p.ma 일선보다 p.band% 넘게 내려가면 최소 비중(p.low)을 넘는 레버리지 몫을 p.cut% 줄이고, p.band% 넘게 올라오면 되돌린다
// (닷컴 하락처럼 천천히 흘러내려 변동성이 크지 않은 하락장 대비. p.ma = 0 이면 끔)
// 비중이 바뀐 날과 p.months 개월(3 = 분기)마다 새 기간의 첫 거래일에만 매매, 그 밖의 날은 null(매매 안 함)
const ts = ctx.tickers.filter((t) => ctx.close(t) > 0);
if (!ts.length) return {};
const vol250 = (t) => { const v = ctx.volatility(t, 250); return Number.isFinite(v) ? v : ctx.volatility(t, 60) || 0; };
const main = [...ts].sort((a, b) => vol250(b) - vol250(a))[0];
const rest = ts.filter((t) => t !== main);
const st = ctx.state;
const v = ctx.volatility(main, 20) * Math.sqrt(252) * 100;
const N = 5;
st.sw = st.sw || [];
let calm = 0;
for (let k = 0; k < N; k++) {
  const th = p.v0 + (p.v1 - p.v0) * k / (N - 1);
  let on = st.sw[k] || false;
  if (!on && v > th) on = true;
  else if (on && v < th * p.back / 100) on = false;
  st.sw[k] = on;
  if (!on) calm++;
}
let down = false;
if (p.ma > 0) {
  const c = ctx.close(main), avg = ctx.sma(main, p.ma);
  if (Number.isFinite(avg) && avg > 0) {
    down = st.down || false;
    if (!down && c < avg * (1 - p.band / 100)) down = true;
    else if (down && c > avg * (1 + p.band / 100)) down = false;
  }
  st.down = down;
}
const lev = rest.length ? (p.low + (p.main - p.low) * calm / N * (down ? 1 - p.cut / 100 : 1)) / 100 : 1;
const m = Number(ctx.date.slice(0, 4)) * 12 + Number(ctx.date.slice(5, 7)) - 1;
const period = Math.floor(m / Math.max(1, p.months));
if (st.lev === lev && st.period === period) return null;
const cause = \`변동성 \${v.toFixed(0)}%\${down ? \`, \${p.ma}일선 아래\` : ""}\`;
const why = st.lev === undefined || st.lev === lev ? "정기 리밸런싱" : lev < st.lev ? \`\${cause} → 레버리지 \${Math.round(lev * 100)}%로 줄임\` : \`\${cause} → 레버리지 \${Math.round(lev * 100)}%로 늘림\`;
st.lev = lev; st.period = period;
const w = {};
w[main] = lev;
for (const t of rest) w[t] = (1 - lev) / rest.length;
for (const t of ts) ctx.notes[t] = why;
return w;`;

/** 비중 고정 전략 코드 (화면에서 이 코드면 종목별 비중 입력칸을 보여 줌) */
export const FIXED_MIX_CODE = `// 비중 고정: 종목마다 정한 비중(p["w_종목코드"], %)으로 나눠 들고, p.months 개월마다(3 = 분기)
// 새 기간의 첫 거래일 종가에 비중을 다시 맞춘다(체결은 다음 날 시가).
// 비중을 하나도 안 정했으면 모든 종목을 똑같이. 정한 종목만 사고, 합이 100 미만이면 나머지는 현금
const set = ctx.tickers.filter((t) => p["w_" + t] !== undefined);
const w = {};
for (const t of ctx.tickers) {
  if (!(ctx.close(t) > 0)) continue;
  const v = set.length ? p["w_" + t] / 100 : 1 / ctx.tickers.length;
  if (v > 0) w[t] = v;
}
const m = Number(ctx.date.slice(0, 4)) * 12 + Number(ctx.date.slice(5, 7)) - 1;
const period = Math.floor(m / Math.max(1, p.months));
if (ctx.state.period === period) return null;
ctx.state.period = period;
for (const t in w) ctx.notes[t] = "정기 리밸런싱";
return w;`;

const rotationCode = `// 모멘텀 상위 N 회전: 매달 말, 1·3·6·12개월 수익률의 평균(모멘텀)이 가장 높은 p.topK 종목을 똑같이 나눠 보유.
// 모멘텀이 p.minMom% 이하인 종목은 사지 않고 그 몫은 현금으로 둠 (다 같이 떨어지는 때 대비).
// 12개월 시세가 아직 없는 종목은 고르지 않음.
const score = (t) => {
  const r = [21, 63, 126, 252].map((n) => ctx.ret(t, n));
  return r.every(Number.isFinite) ? (r[0] + r[1] + r[2] + r[3]) / 4 * 100 : NaN;
};
const ok = ctx.tickers.filter((t) => ctx.close(t) > 0 && Number.isFinite(score(t)));
const ranked = [...ok].sort((a, b) => score(b) - score(a));
const picks = ranked.slice(0, p.topK).filter((t) => score(t) > p.minMom);
const w = {};
for (const t of picks) { w[t] = 1 / p.topK; ctx.notes[t] = \`모멘텀 \${score(t).toFixed(1)}% (\${ranked.indexOf(t) + 1}위)\`; }
for (const t of ctx.held()) if (!w[t]) ctx.notes[t] = Number.isFinite(score(t)) && score(t) <= p.minMom ? \`모멘텀 \${score(t).toFixed(1)}% → 현금\` : \`상위 \${p.topK}에서 빠짐\`;
return w;`;

const rotationPlusCode = `// 모멘텀 회전 (조절 많은 버전): 매달 말, 모멘텀이 높은 p.topK 종목을 고름. 기본값은 '모멘텀 상위 N 회전'과 같음.
// p.lb  모멘텀 재는 법: 0 = 1·3·6·12개월 평균, 1 = 최근에 무게(1개월×12·3개월×4·6개월×2·12개월 ÷ 19),
//       2 = 3·6·12개월 평균, 3 = 6개월, 4 = 12개월(최근 1개월 빼고)
// p.minMom 이 모멘텀(%) 이하인 종목 몫은 현금(또는 피난처)
// p.wmode 0 = 고른 종목마다 1/topK 씩, 1 = 고른 종목 안에서 덜 출렁이는 종목에 더 많이 (합계는 같음)
// p.safe  1 = 현금으로 남는 몫을 '피난처'(60일 변동성이 가장 낮은 종목, 3개월 수익률이 0보다 클 때만)에 넣음
// p.canary 0보다 크면: 모멘텀이 0보다 큰 종목이 전체의 p.canary% 미만일 때 주식 몫을 p.cut% 로 줄임
// p.volT  0보다 크면: 고른 비중의 최근 60일 변동성이 연 p.volT% 를 넘으면 그만큼 줄임
const R = (t, n, skip = 0) => ctx.ret(t, n, skip);
const score = (t) => {
  const a = [R(t, 21), R(t, 63), R(t, 126), R(t, 252)];
  if (!a.every(Number.isFinite)) return NaN;
  const m = p.lb === 1 ? (12 * a[0] + 4 * a[1] + 2 * a[2] + a[3]) / 19
    : p.lb === 2 ? (a[1] + a[2] + a[3]) / 3
    : p.lb === 3 ? a[2]
    : p.lb === 4 ? R(t, 252, 21)
    : (a[0] + a[1] + a[2] + a[3]) / 4;
  return Number.isFinite(m) ? m * 100 : NaN;
};
const ok = ctx.tickers.filter((t) => ctx.close(t) > 0 && Number.isFinite(score(t)));
if (!ok.length) return {};
const ranked = [...ok].sort((a, b) => score(b) - score(a));
const picks = ranked.slice(0, p.topK).filter((t) => score(t) > p.minMom);
const vol = (t) => ctx.volatility(t, 60);
const w = {};
const slot = 1 / p.topK;
if (p.wmode === 1 && picks.length > 1 && picks.every((t) => Number.isFinite(vol(t)) && vol(t) > 0)) {
  const iv = picks.map((t) => 1 / vol(t)), s = iv.reduce((x, y) => x + y, 0);
  picks.forEach((t, k) => { w[t] = (iv[k] / s) * slot * picks.length; });
} else for (const t of picks) w[t] = slot;
let scale = 1;
if (p.canary > 0) {
  const up = ok.filter((t) => score(t) > 0).length / ok.length * 100;
  if (up < p.canary) scale = p.cut / 100;
}
if (p.volT > 0 && picks.length) {
  const n = 60, h = picks.map((t) => ctx.history(t, n + 1));
  if (h.every((x) => x.length === n + 1)) {
    const r = [];
    for (let i = 1; i <= n; i++) r.push(picks.reduce((s, t, k) => s + w[t] * (h[k][i] / h[k][i - 1] - 1), 0));
    const m = r.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) * Math.sqrt(252) * 100;
    if (sd > p.volT) scale = Math.min(scale, p.volT / sd);
  }
}
for (const t of Object.keys(w)) w[t] *= scale;
for (const t of picks) ctx.notes[t] = \`모멘텀 \${score(t).toFixed(1)}% (\${ranked.indexOf(t) + 1}위)\${scale < 1 ? \` · 비중 \${(scale * 100).toFixed(0)}%로 줄임\` : ""}\`;
if (p.safe === 1) {
  const rest = 1 - Object.values(w).reduce((a, b) => a + b, 0);
  const cands = ok.filter((t) => Number.isFinite(vol(t)) && vol(t) > 0).sort((a, b) => vol(a) - vol(b));
  const s = cands[0];
  if (s && rest > 0.01 && R(s, 63) > 0) { w[s] = (w[s] ?? 0) + rest; ctx.notes[s] = \`피난처(가장 덜 출렁임) \${(rest * 100).toFixed(0)}%\`; }
}
for (const t of ctx.held()) if (!w[t]) ctx.notes[t] = Number.isFinite(score(t)) && score(t) <= p.minMom ? \`모멘텀 \${score(t).toFixed(1)}% → 현금\` : \`상위 \${p.topK}에서 빠짐\`;
return w;`;

const trendParityCode = `// 추세 + 위험 균형: 매달 말, 각 종목을 덜 출렁이는 만큼 더 많이(60일 변동성의 역수) 나눠 담되,
// p.ma 일선 아래이거나 3개월 수익률이 0 이하인 종목은 빼고 그 몫은 현금.
// 그다음 전체 변동성이 연 p.target% 가 되도록 비중을 줄이거나 늘림(합계 최대 100%). 레버리지 ETF 로 고르면 같은 목표에 덜 담음.
const ts = ctx.tickers.filter((t) => ctx.close(t) > 0 && ctx.history(t, 61).length === 61 && Number.isFinite(ctx.sma(t, p.ma)));
if (!ts.length) return {};
const vol = (t) => ctx.volatility(t, 60);
const inv = {};
let sum = 0;
for (const t of ts) { const v = vol(t); inv[t] = Number.isFinite(v) ? 1 / Math.max(v, 1e-6) : 0; sum += inv[t]; }
if (!sum) return {};
const w = {};
for (const t of ts) {
  const on = ctx.close(t) > ctx.sma(t, p.ma) && ctx.ret(t, 63) > 0;
  if (on) w[t] = inv[t] / sum;
  else ctx.notes[t] = ctx.close(t) <= ctx.sma(t, p.ma) ? \`\${p.ma}일선 아래 → 현금\` : "3개월 수익률 0 이하 → 현금";
}
// 지금 비중으로 지난 60일을 들고 있었다면의 변동성
const h = {};
for (const t in w) h[t] = ctx.history(t, 61);
const rets = [];
for (let k = 1; k < 61; k++) { let r = 0; for (const t in w) r += w[t] * (h[t][k] / h[t][k - 1] - 1); if (Number.isFinite(r)) rets.push(r); }
if (rets.length < 20) return w;
const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
const pv = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) * 100;
const tot = Object.values(w).reduce((a, b) => a + b, 0);
// 목표보다 출렁이면 줄이고, 덜 출렁이면 늘림 (현금 없이 다 담는 데까지)
const k = Math.min(pv > 0 ? p.target / pv : Infinity, 1 / tot);
for (const t in w) { w[t] *= k; ctx.notes[t] = \`위험 균형 \${(w[t] * 100).toFixed(0)}% (전체 변동성 \${pv.toFixed(0)}% → 목표 \${p.target}%)\`; }
return w;`;

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
  {
    id: "lev_mix",
    name: "레버리지 분산 (50·25·25)",
    description: "레버리지 ETF 50%, 나머지는 장기 국채·금에 똑같이. 분기마다 비중을 다시 맞춤. 종목은 직접 입력(가장 많이 출렁이는 종목이 레버리지 몫).",
    params: [
      { key: "main", label: "레버리지 비중(%)", default: 50, min: 10, max: 90, step: 5 },
      { key: "months", label: "다시 맞추는 주기(개월)", default: 3, min: 1, max: 12 },
    ],
    rebalance: "D", stopLoss: null, takeProfit: null,
    warmup: () => 61,
    targetWeights: compileStrategy(levMixCode),
    code: levMixCode,
  },
  {
    id: "lev_guard",
    name: "레버리지 분산 + 변동성 방어",
    description: "평소 레버리지 ETF 60%, 나머지는 중기 국채·금. 레버리지 종목이 크게 출렁이기 시작하면 단계적으로 10%까지 줄였다가 잠잠해지면 되돌림. 200일선 아래로 내려가면 레버리지를 60%에서 35%로(최소 비중을 넘는 몫의 절반) 줄임. 종목은 직접 입력(가장 많이 출렁이는 종목이 레버리지 몫).",
    params: [
      { key: "main", label: "평소 레버리지 비중(%)", default: 60, min: 10, max: 100, step: 5 },
      { key: "low", label: "가장 위험할 때 비중(%)", default: 10, min: 0, max: 100, step: 5 },
      { key: "v0", label: "줄이기 시작하는 변동성(연 %)", default: 80, min: 20, max: 300, step: 5 },
      { key: "v1", label: "최소로 줄이는 변동성(연 %)", default: 160, min: 20, max: 400, step: 5 },
      { key: "back", label: "되돌리는 기준(기준의 %)", default: 85, min: 50, max: 100, step: 5 },
      { key: "ma", label: "추세 이동평균(일, 0 = 끔)", default: 200, min: 0, max: 400, step: 10 },
      { key: "cut", label: "이평선 아래일 때 레버리지 줄이는 비율(%)", default: 50, min: 0, max: 100, step: 10 },
      { key: "band", label: "이평선 위아래 여유(%)", default: 3, min: 0, max: 20, step: 1 },
      { key: "months", label: "다시 맞추는 주기(개월)", default: 3, min: 1, max: 12 },
    ],
    rebalance: "D", stopLoss: null, takeProfit: null,
    warmup: (p) => Math.max(61, (p.ma ?? 0) + 1),
    targetWeights: compileStrategy(levGuardCode),
    code: levGuardCode,
  },
  {
    id: "rotation",
    name: "모멘텀 상위 N 회전",
    description: "매달 말, 1·3·6·12개월 평균 수익률이 가장 높은 3종목을 똑같이 보유. 모멘텀이 0 이하인 종목 몫은 현금. 종목은 직접 입력(주식·채권·금처럼 서로 다르게 움직이는 ETF 몇 개).",
    params: [
      { key: "topK", label: "보유 종목 수", default: 3, min: 1, max: 10 },
      { key: "minMom", label: "이 모멘텀(%) 이하는 현금", default: 0, min: -20, max: 20, step: 1 },
    ],
    rebalance: "M", stopLoss: null, takeProfit: null,
    warmup: () => 253,
    targetWeights: compileStrategy(rotationCode),
    code: rotationCode,
  },
  {
    id: "rotation_plus",
    name: "모멘텀 회전 (조절 많은 버전)",
    description: "모멘텀 상위 N 회전에 조절 장치를 더한 것. 모멘텀 재는 법, 고른 종목 비중(같게·덜 출렁이는 쪽 더), 남는 몫을 가장 덜 출렁이는 종목(피난처)에 넣기, 오르는 종목이 적을 때 줄이기, 변동성 목표를 고를 수 있음. 기본값은 '모멘텀 상위 N 회전'과 같음. 종목은 직접 입력.",
    params: [
      { key: "topK", label: "보유 종목 수", default: 3, min: 1, max: 10 },
      { key: "minMom", label: "이 모멘텀(%) 이하는 현금", default: 0, min: -20, max: 20, step: 1 },
      { key: "lb", label: "모멘텀 재는 법(0 1·3·6·12 평균, 1 최근 무게, 2 3·6·12, 3 6개월, 4 12개월-1)", default: 0, min: 0, max: 4 },
      { key: "wmode", label: "비중(0 같게, 1 덜 출렁이는 쪽 더)", default: 0, min: 0, max: 1 },
      { key: "safe", label: "남는 몫을 피난처에(0 끔, 1 켬)", default: 0, min: 0, max: 1 },
      { key: "canary", label: "오르는 종목 비율 기준(%, 0 = 끔)", default: 0, min: 0, max: 100, step: 5 },
      { key: "cut", label: "기준 밑일 때 주식 몫(%)", default: 50, min: 0, max: 100, step: 10 },
      { key: "volT", label: "변동성 목표(연 %, 0 = 끔)", default: 0, min: 0, max: 200, step: 5 },
    ],
    rebalance: "M", stopLoss: null, takeProfit: null,
    warmup: () => 253,
    targetWeights: compileStrategy(rotationPlusCode),
    code: rotationPlusCode,
  },
  {
    id: "trend_parity",
    name: "추세 + 위험 균형",
    description: "매달 말, 덜 출렁이는 종목을 더 많이 담고(변동성 역수), 200일선 아래이거나 3개월 수익률이 0 이하인 종목은 현금. 전체 변동성이 목표를 넘으면 비중을 줄임. 종목은 직접 입력.",
    params: [
      { key: "target", label: "목표 변동성(연 %)", default: 15, min: 3, max: 60, step: 1 },
      { key: "ma", label: "추세 이동평균(일)", default: 200, min: 20, max: 400, step: 10 },
    ],
    rebalance: "M", stopLoss: null, takeProfit: null,
    warmup: (p) => Math.max(64, (p.ma ?? 200) + 1),
    targetWeights: compileStrategy(trendParityCode),
    code: trendParityCode,
  },
  {
    id: "cc_mix",
    name: "비중 고정 (종목별 비중)",
    description: "종목마다 정한 비중으로 나눠 들고 분기마다 다시 맞춤. 비중을 비우면 똑같이.",
    params: [
      { key: "months", label: "다시 맞추는 주기(개월)", default: 3, min: 1, max: 12 },
    ],
    rebalance: "D", stopLoss: null, takeProfit: null,
    warmup: () => 2,
    targetWeights: compileStrategy(FIXED_MIX_CODE),
    code: FIXED_MIX_CODE,
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
