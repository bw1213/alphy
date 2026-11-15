/**
 * 전략 찾기: 종목 1~3개에 써 볼 전략 후보 목록.
 *
 * 기본 제공 전략(모멘텀·신고가 등)은 수십~수백 종목 중에서 고르는 방식이라 종목이 1~3개면 잘 맞지 않는다.
 * 그래서 몇 종목만 들고 "언제 들고 언제 쉴지", "어느 종목에 얼마나 넣을지"를 정하는 규칙 6가지를 준비하고,
 * 규칙마다 숫자 몇 가지를 바꿔 본다. 후보 수를 일부러 100개 안팎으로 묶어 둔다.
 * (많이 시도할수록 우연히 과거에만 잘 맞은 설정이 1등이 될 가능성이 커진다)
 *
 * 후보 코드는 "코드 작성" 전략과 똑같은 형식이라, 찾은 뒤 그대로 백테스트 화면에 넣어 고치고 저장할 수 있다.
 */
import { CYCLE_CODE, cycleParams, cycleWarmup, defaultCycleSpec, type CycleSpec } from "../strategies/cycle";
import type { Params } from "../strategies";
import type { Rebalance } from "../engine/types";

export type FamilyId = "trend" | "cross" | "momentum" | "rsi" | "fixed" | "cycle";

export const FAMILIES: Record<FamilyId, { name: string; help: string }> = {
  trend: { name: "이평선 위에서만 보유", help: "종가가 이동평균선 위에 있는 종목만 들고, 아래로 내려오면 팔고 쉽니다." },
  cross: { name: "이평선 교차", help: "단기 이동평균선이 장기 이동평균선 위에 있을 때만 들고 있습니다." },
  momentum: { name: "모멘텀 순환", help: "최근 수익률이 높은 종목으로 갈아타고, 모두 마이너스면 현금으로 쉽니다." },
  rsi: { name: "RSI 눌림목 매수", help: "많이 빠졌을 때(RSI 낮음) 사서, 회복하면(RSI 높음) 팝니다." },
  fixed: { name: "비중 고정 리밸런싱", help: "정한 비율로 나눠 들고, 주기마다 비율을 다시 맞춥니다." },
  cycle: { name: "적립 매수·하락 시 분할 매도", help: "주기적으로 조금씩 사다가 최고가 대비 많이 빠지면 나눠 팔고, 안정되면 다시 삽니다." },
};

export interface Candidate {
  /** 같은 설정이면 같은 id */
  id: string;
  family: FamilyId;
  /** 사람이 읽는 이름 (예: "이평선 위에서만 보유 · 120일 · 매주 확인") */
  name: string;
  code: string;
  params: Params;
  rebalance: Rebalance;
  warmup: number;
  /** 적립·분할 매도는 조건 화면 값도 같이 */
  cycle?: CycleSpec;
}

const REB: Record<string, string> = { D: "매일", W: "매주", M: "매월", Q: "분기마다" };

const TREND_CODE = `// 이평선 위에서만 보유: 종가가 p.ma일 이동평균선 위에 있는 종목만 들고, 아래로 내려오면 판다
// p.splitMode = 0: 쉬는 종목 몫은 현금으로 둠 / 1: 위에 있는 종목끼리 나눠 담음
const on = ctx.tickers.filter((t) => ctx.close(t) > ctx.sma(t, p.ma));
if (p.splitMode === 1) return ctx.equal(on);
const w = {};
for (const t of on) w[t] = 1 / ctx.tickers.length;
return w;`;

const CROSS_CODE = `// 이평선 교차: p.short일 이동평균선이 p.long일 이동평균선 위에 있는 종목만 보유
// p.splitMode = 0: 쉬는 종목 몫은 현금으로 둠 / 1: 조건을 만족하는 종목끼리 나눠 담음
const on = ctx.tickers.filter((t) => ctx.sma(t, p.short) > ctx.sma(t, p.long));
if (p.splitMode === 1) return ctx.equal(on);
const w = {};
for (const t of on) w[t] = 1 / ctx.tickers.length;
return w;`;

const MOMENTUM_CODE = `// 모멘텀 순환: 최근 p.lookback일 수익률이 높은 순서로 p.topK개를 보유
// 수익률이 0 이하인 종목은 사지 않고 그 몫은 현금으로 둠 (모두 빠지면 전부 현금)
const picks = ctx.topBy((t) => ctx.ret(t, p.lookback), p.topK, (t) => ctx.ret(t, p.lookback) > 0);
const w = {};
for (const t of picks) w[t] = 1 / p.topK;
return w;`;

const RSI_CODE = `// RSI 눌림목 매수: 종목마다 따로 판단 (종목당 1/종목 수 만큼)
// 안 들고 있을 때: RSI(p.period) < p.buyBelow 이고 (p.trendMa > 0 이면) 종가가 p.trendMa일선 위면 산다
// 들고 있을 때: RSI > p.sellAbove 가 되면 판다. 그 전까지는 수량 그대로
const slice = 1 / ctx.tickers.length;
const held = ctx.held();
const w = {};
for (const t of ctx.tickers) {
  const r = ctx.rsi(t, p.period);
  if (held.includes(t)) {
    if (!(r > p.sellAbove)) w[t] = lib.HOLD;
  } else if (r < p.buyBelow && (!p.trendMa || ctx.close(t) > ctx.sma(t, p.trendMa))) {
    w[t] = slice;
  }
}
return w;`;

const FIXED_CODE = `// 비중 고정 리밸런싱: 종목마다 정한 비율(p["w_종목코드"])로 나눠 들고, 리밸런싱 주기마다 비율을 다시 맞춤
const w = {};
for (const t of ctx.tickers) if (p["w_" + t] > 0) w[t] = p["w_" + t];
return w;`;

const pctLabel = (x: number) => `${Math.round(x * 100)}`;

/** 종목 목록(1~3개)에 맞는 후보 전체 */
export function buildCandidates(tickers: string[], names: Record<string, string> = {}): Candidate[] {
  const n = tickers.length;
  const out: Candidate[] = [];
  const add = (c: Omit<Candidate, "id">) => out.push({ ...c, id: `${c.family}:${JSON.stringify(c.params)}:${c.rebalance}` });
  const splits = n > 1 ? [0, 1] : [0];
  const splitName = (s: number) => (n > 1 ? (s ? " · 남은 종목에 몰아 담기" : " · 쉬는 몫은 현금") : "");

  for (const ma of [20, 50, 100, 150, 200]) for (const reb of ["W", "M"] as const) for (const splitMode of splits)
    add({ family: "trend", name: `${FAMILIES.trend.name} · ${ma}일선 · ${REB[reb]} 확인${splitName(splitMode)}`,
      code: TREND_CODE, params: { ma, splitMode }, rebalance: reb, warmup: ma + 1 });

  for (const [short, long] of [[5, 20], [10, 50], [20, 60], [20, 120], [50, 200]]) for (const reb of ["D", "W"] as const) for (const splitMode of splits)
    add({ family: "cross", name: `${FAMILIES.cross.name} · ${short}일선 > ${long}일선 · ${REB[reb]} 확인${splitName(splitMode)}`,
      code: CROSS_CODE, params: { short, long, splitMode }, rebalance: reb, warmup: long + 1 });

  for (const lookback of [20, 60, 120, 250]) for (let topK = 1; topK <= n; topK++) for (const reb of ["W", "M"] as const)
    add({ family: "momentum", name: `${FAMILIES.momentum.name} · 최근 ${lookback}일 수익률${n > 1 ? ` · 상위 ${topK}개` : ""} · ${REB[reb]} 확인`,
      code: MOMENTUM_CODE, params: { lookback, topK }, rebalance: reb, warmup: lookback + 1 });

  for (const period of [5, 14]) for (const buyBelow of [30, 40]) for (const sellAbove of [65, 75]) for (const trendMa of [0, 200])
    add({ family: "rsi", name: `${FAMILIES.rsi.name} · RSI(${period}) ${buyBelow} 미만 매수, ${sellAbove} 초과 매도${trendMa ? ` · ${trendMa}일선 위에서만` : ""}`,
      code: RSI_CODE, params: { period, buyBelow, sellAbove, trendMa }, rebalance: "D", warmup: Math.max(period * 6, trendMa) + 1 });

  if (n > 1) {
    const sets: number[][] = n === 2 ? [[0.5, 0.5], [0.7, 0.3], [0.3, 0.7]]
      : [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.25, 0.25], [0.25, 0.5, 0.25], [0.25, 0.25, 0.5]];
    for (const ws of sets) for (const reb of ["M", "Q"] as const) {
      const params: Params = Object.fromEntries(tickers.map((t, k) => [`w_${t}`, Number(ws[k].toFixed(4))]));
      const mix = n === 3 && ws[0] === ws[1] && ws[1] === ws[2] ? "똑같이" : tickers.map((t, k) => `${names[t] ?? t} ${pctLabel(ws[k])}%`).join(" · ");
      add({ family: "fixed", name: `${FAMILIES.fixed.name} · ${mix} · ${REB[reb]} 다시 맞춤`, code: FIXED_CODE, params, rebalance: reb, warmup: 2 });
    }
  }

  for (const drop of [5, 10, 15, 20]) for (const sell of [10, 30]) for (const buy of [5, 10]) {
    const spec = defaultCycleSpec();
    spec.buy.value = buy; spec.drop.value = drop; spec.sell.value = sell;
    add({ family: "cycle", name: `${FAMILIES.cycle.name} · 매월 ${buy}% 매수 · 최고가 대비 -${drop}%에 ${sell}% 매도`,
      code: CYCLE_CODE, params: cycleParams(spec), rebalance: "D", warmup: cycleWarmup(spec), cycle: spec });
  }
  return out;
}

/** 모든 후보가 지표를 계산할 수 있게 시작일보다 먼저 받아야 하는 영업일 수 */
export const maxWarmup = (cs: Candidate[]) => cs.reduce((m, c) => Math.max(m, c.warmup), 1);
