/**
 * 전략 찾기 결과 평가.
 *
 * 과거 데이터에 숫자를 맞추기만 하면 "과거에만" 잘 맞는 설정이 1등이 된다(과최적화). 그래서
 *  1) 평가 기간을 앞 구간(고르는 데 씀)과 뒤 구간(확인만 함)으로 나눠, 앞 구간 성적으로만 순위를 매긴다.
 *     뒤 구간 성적은 고를 때 보지 않았으므로 "처음 보는 기간"에서의 성과에 가깝다.
 *  2) 해마다 다시 고르기: 매년 초, 그 전까지의 데이터로만 1등을 골라 그 해 1년을 썼다면 어땠는지 이어 붙인다.
 *     "이렇게 고르는 방법 자체"가 통하는지 보는 것이다.
 *  3) 비슷한 설정(숫자 하나만 다른 것)도 성적이 비슷한지 본다. 1등만 튀면 우연일 가능성이 크다.
 *  4) 모든 비교는 같은 종목을 똑같이 나눠 사서 들고만 있는 것(매수 후 보유)과 한다.
 */
import { perf, stats, type Stats } from "../engine/metrics";
import type { BacktestResult } from "../engine/types";
import type { Candidate } from "./candidates";

/** 순위 기준: 연평균 수익률 / 최대 낙폭 기준 안에서 수익률 / 수익률 ÷ 낙폭 */
export type Objective = "cagr" | "capped" | "calmar";
export const OBJECTIVES: { id: Objective; label: string; help: string }[] = [
  { id: "cagr", label: "연평균 수익률이 가장 높은 것", help: "낙폭은 보지 않고 수익률만 봅니다." },
  { id: "capped", label: "최대 낙폭 기준 안에서 수익률이 가장 높은 것", help: "설정한 최대 낙폭(예: -25%)을 넘은 설정은 뒤로 보냅니다." },
  { id: "calmar", label: "낙폭 대비 수익률이 가장 높은 것", help: "연평균 수익률 ÷ 최대 낙폭. 덜 출렁이면서 버는 설정을 앞에 둡니다." },
];

export function score(s: Stats, obj: Objective, maxDrawdown: number): number {
  const ok = (x: number) => (Number.isFinite(x) ? x : -Infinity);
  if (obj === "calmar") return s.mdd < 0 ? ok(s.calmar) : s.cagr > 0 ? 1e6 : ok(s.cagr);
  if (obj === "capped") return s.mdd >= -maxDrawdown ? ok(s.cagr) : ok(s.cagr) - 10;
  return ok(s.cagr);
}

export interface Row {
  c: Candidate;
  full: Stats;
  train: Stats;
  test: Stats;
  /** 앞 구간·뒤 구간 매매 횟수 */
  trainTrades: number;
  testTrades: number;
  score: number;
  /** 앞 구간 순위 (1부터) */
  rank: number;
  /** 뒤 구간 순위 (참고용) */
  testRank: number;
}

export interface Check { label: string; ok: boolean; detail: string }

export interface WalkYear { year: number; pick: string; ret: number; hold: number | null }
export interface WalkResult { years: WalkYear[]; cagr: number; mdd: number; holdCagr: number | null; holdMdd: number | null; start: string; end: string }

export interface HoldStats { full: Stats; train: Stats; test: Stats }

export interface FinderReport {
  rows: Row[];
  best: Row;
  hold: HoldStats | null;
  splitDate: string;
  start: string;
  end: string;
  /** 비슷한 설정(숫자 하나만 다른 것)들의 앞 구간 연평균 수익률 중앙값 */
  neighborMedian: number | null;
  neighborCount: number;
  walk: WalkResult | null;
  checks: Check[];
  verdict: "high" | "mid" | "low";
  objective: Objective;
  tried: number;
}

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** dates/values 중 [a, b] 인덱스 구간의 지표 */
const slice = (dates: string[], v: number[], a: number, b: number) => stats(dates.slice(a, b + 1), v.slice(a, b + 1));

/** 숫자 하나만 다르고 나머지(리밸런싱 포함)는 같은 후보 */
export function isNeighbor(a: Candidate, b: Candidate): boolean {
  if (a.id === b.id || a.family !== b.family || a.rebalance !== b.rebalance) return false;
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
  let diff = 0;
  for (const k of keys) if (a.params[k] !== b.params[k]) diff++;
  // 비중 고정은 비중 여러 개가 같이 바뀌므로 같은 주기면 이웃으로 봄
  return a.family === "fixed" ? diff > 0 : diff === 1;
}

export interface EvaluateOptions {
  objective: Objective;
  /** 뒤 구간 비율 (0.3 = 마지막 30%) */
  testRatio: number;
  /** capped 기준 및 판정용 (0.25 = -25%) */
  maxDrawdown: number;
  /** 해마다 다시 고르기에서 처음 고를 때 필요한 최소 영업일 (기본 약 2년) */
  minTrainDays?: number;
}

export function evaluate(runs: { c: Candidate; res: BacktestResult }[], hold: BacktestResult | null, opt: EvaluateOptions): FinderReport {
  const ok = runs.filter((r) => r.res.equity.length >= 2);
  if (!ok.length) throw new Error("계산된 후보가 없습니다. 기간과 종목을 확인하세요.");
  const dates = ok[0].res.equity.map((e) => e.date);
  const N = dates.length;
  if (N < 250) throw new Error("평가 기간이 너무 짧습니다. 시작일을 앞당겨 최소 2년 이상으로 해 주세요 (앞 구간·뒤 구간으로 나눠야 해서).");
  const k = Math.min(N - 60, Math.max(60, Math.floor(N * (1 - opt.testRatio))));
  const splitDate = dates[k];

  // 같은 날짜 축으로 맞춤 (모든 후보는 같은 데이터·시작일이라 날짜가 같다. 다르면 빼 둔다)
  const series = (res: BacktestResult): number[] | null => {
    if (res.equity.length !== N || res.equity[0].date !== dates[0] || res.equity[N - 1].date !== dates[N - 1]) return null;
    return res.equity.map(perf);
  };

  const rows: (Row & { v: number[] })[] = [];
  for (const { c, res } of ok) {
    const v = series(res);
    if (!v) continue;
    const train = slice(dates, v, 0, k), test = slice(dates, v, k, N - 1);
    rows.push({
      c, v, full: stats(dates, v), train, test,
      trainTrades: res.trades.filter((t) => t.date < splitDate).length,
      testTrades: res.trades.filter((t) => t.date >= splitDate).length,
      score: score(train, opt.objective, opt.maxDrawdown), rank: 0, testRank: 0,
    });
  }
  if (!rows.length) throw new Error("계산된 후보가 없습니다.");
  rows.sort((a, b) => b.score - a.score || b.train.cagr - a.train.cagr);
  rows.forEach((r, i) => { r.rank = i + 1; });
  [...rows].sort((a, b) => score(b.test, opt.objective, opt.maxDrawdown) - score(a.test, opt.objective, opt.maxDrawdown))
    .forEach((r, i) => { r.testRank = i + 1; });
  const best = rows[0];

  const hv = hold ? series(hold) : null;
  const holdStats: HoldStats | null = hv ? { full: stats(dates, hv), train: slice(dates, hv, 0, k), test: slice(dates, hv, k, N - 1) } : null;

  // 비슷한 설정
  const nb = rows.filter((r) => isNeighbor(best.c, r.c));
  const neighborMedian = nb.length ? median(nb.map((r) => r.train.cagr)) : null;

  // 해마다 다시 고르기
  const walk = walkForward(dates, rows, hv, opt);

  const checks: Check[] = [];
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (holdStats) checks.push({
    label: "확인 구간에서도 매수 후 보유보다 좋음",
    ok: best.test.cagr > holdStats.test.cagr,
    detail: `확인 구간 연 ${p(best.test.cagr)} vs 보유 연 ${p(holdStats.test.cagr)}`,
  });
  checks.push({ label: "확인 구간에서도 수익", ok: best.test.cagr > 0, detail: `확인 구간 연 ${p(best.test.cagr)}` });
  if (neighborMedian != null && Number.isFinite(neighborMedian)) checks.push({
    label: "숫자를 조금 바꿔도 성적이 비슷함",
    ok: best.train.cagr > 0 && neighborMedian > 0 && neighborMedian >= best.train.cagr * 0.5,
    detail: `비슷한 설정 ${nb.length}개의 고르는 구간 연수익 중앙값 ${p(neighborMedian)} (1등 ${p(best.train.cagr)})`,
  });
  if (walk && walk.holdCagr != null) checks.push({
    label: "해마다 다시 골라도 매수 후 보유보다 좋음",
    ok: walk.cagr > walk.holdCagr,
    detail: `${walk.years.length}년 이어 붙인 결과 연 ${p(walk.cagr)} vs 보유 연 ${p(walk.holdCagr)}`,
  });
  checks.push({
    label: "매매가 충분히 일어남 (우연 한두 번이 아님)",
    ok: best.trainTrades >= 6,
    detail: `고르는 구간 매매 ${best.trainTrades}건`,
  });
  // 가장 중요한 건 "처음 보는 기간에도 그냥 들고 있는 것보다 나았나"라서, 보유와 비교한 점검을 둘 다 못 하면 낮음, 하나라도 못 하면 보통까지
  const passed = checks.filter((c) => c.ok).length;
  const holdFails = checks.filter((c) => c.label.includes("매수 후 보유") && !c.ok).length;
  let verdict: FinderReport["verdict"] = passed === checks.length ? "high" : passed >= Math.ceil(checks.length * 0.6) ? "mid" : "low";
  if (holdFails >= 2) verdict = "low";
  else if (holdFails === 1 && verdict === "high") verdict = "mid";

  return {
    rows: rows.map(({ v: _v, ...r }) => r), best: (({ v: _v, ...r }) => r)(best),
    hold: holdStats, splitDate, start: dates[0], end: dates[N - 1],
    neighborMedian, neighborCount: nb.length, walk, checks, verdict, objective: opt.objective, tried: rows.length,
  };
}

/** 매년 초, 그 전까지(평가 시작 이후) 데이터로만 1등을 골라 그 해에 쓴 결과를 이어 붙임. 갈아탈 때 드는 비용은 빠져 있음 */
export function walkForward(dates: string[], rows: { c: Candidate; v: number[] }[], hold: number[] | null, opt: EvaluateOptions): WalkResult | null {
  const N = dates.length;
  const minTrain = opt.minTrainDays ?? 500;
  const starts: number[] = [];
  for (let i = 1; i < N; i++) if (dates[i].slice(0, 4) !== dates[i - 1].slice(0, 4) && i >= minTrain) starts.push(i);
  if (!starts.length) return null;
  const years: WalkYear[] = [];
  const val = [1], hv = [1], wd = [dates[starts[0] - 1]];
  for (const [n, a] of starts.entries()) {
    const b = n + 1 < starts.length ? starts[n + 1] - 1 : N - 1;
    if (b <= a) continue;
    let top = rows[0], topS = -Infinity;
    for (const r of rows) {
      const s = score(slice(dates, r.v, 0, a - 1), opt.objective, opt.maxDrawdown);
      if (s > topS) { topS = s; top = r; }
    }
    for (let j = a; j <= b; j++) {
      val.push(val[val.length - 1] * (top.v[j] / top.v[j - 1]));
      if (hold) hv.push(hv[hv.length - 1] * (hold[j] / hold[j - 1]));
      wd.push(dates[j]);
    }
    years.push({
      year: Number(dates[a].slice(0, 4)), pick: top.c.name,
      ret: top.v[b] / top.v[a - 1] - 1, hold: hold ? hold[b] / hold[a - 1] - 1 : null,
    });
  }
  if (!years.length) return null;
  const s = stats(wd, val), h = hold ? stats(wd, hv) : null;
  return { years, cagr: s.cagr, mdd: s.mdd, holdCagr: h?.cagr ?? null, holdMdd: h?.mdd ?? null, start: wd[0], end: wd[wd.length - 1] };
}
