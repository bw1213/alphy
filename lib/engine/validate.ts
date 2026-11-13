/**
 * 과최적화 점검용 지표.
 * - 기간 분할: 앞 구간(파라미터를 고르는 구간)과 뒤 구간(확인 구간)의 성과를 따로 계산
 * - 1년 구간 수익률: 아무 날에 시작해 1년 뒤의 수익률 분포
 * - 파라미터 민감도: 파라미터를 조금씩 바꿔 다시 돌린 결과의 흔들림
 */
import { perf, stats, TARGET_CAGR, type Stats } from "./metrics";
import type { EquityPoint } from "./types";

export interface PeriodStats extends Stats { start: string; end: string; days: number; bench: Stats | null }

export interface SplitResult { first: PeriodStats; second: PeriodStats; splitDate: string }

function period(eq: EquityPoint[]): PeriodStats {
  const dates = eq.map((e) => e.date);
  const hasBench = eq.every((e) => e.benchmark != null && Number.isFinite(e.benchmark));
  return {
    ...stats(dates, eq.map(perf)),
    start: dates[0], end: dates[dates.length - 1], days: eq.length,
    bench: hasBench ? stats(dates, eq.map((e) => e.benchmark as number)) : null,
  };
}

/** 뒤쪽 ratio(기본 30%)를 확인 구간으로 나눔. 구간이 너무 짧으면 null */
export function splitStats(eq: EquityPoint[], ratio = 0.3): SplitResult | null {
  const k = Math.floor(eq.length * (1 - ratio));
  if (k < 60 || eq.length - k < 60) return null;
  // 두 구간이 경계일을 공유해야 수익률이 끊기지 않음
  return { first: period(eq.slice(0, k + 1)), second: period(eq.slice(k)), splitDate: eq[k].date };
}

export interface RollingResult { n: number; hit: number; positive: number; worst: number; median: number; best: number }

/** window 영업일(기본 252 = 약 1년) 보유했을 때의 수익률 분포 */
export function rollingReturns(values: number[], window = 252, target = TARGET_CAGR): RollingResult | null {
  const r: number[] = [];
  for (let k = window; k < values.length; k++) r.push(values[k] / values[k - window] - 1);
  if (r.length < 20) return null;
  const sorted = [...r].sort((a, b) => a - b);
  return {
    n: r.length,
    hit: r.filter((x) => x >= target).length / r.length,
    positive: r.filter((x) => x > 0).length / r.length,
    worst: sorted[0], median: sorted[Math.floor(sorted.length / 2)], best: sorted[sorted.length - 1],
  };
}

export interface ParamVariant { key: string; value: number; label: string }

/** 숫자 파라미터를 하나씩 ±20% 바꾼 조합 (정수 파라미터는 정수로, 값이 안 바뀌면 제외). 이름이 Mode 로 끝나면 선택지 번호라 제외 */
export function paramVariants(p: Record<string, unknown>, pct = 0.2): ParamVariant[] {
  const out: ParamVariant[] = [];
  for (const [key, v] of Object.entries(p)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v === 0 || /Mode$/.test(key)) continue;
    for (const m of [1 - pct, 1 + pct]) {
      let value: number = v * m;
      if (Number.isInteger(v)) value = Math.max(1, Math.round(value));
      else value = Number(value.toPrecision(6));
      if (value !== v) out.push({ key, value, label: `${key} ${v} → ${value}` });
    }
  }
  return out;
}

export interface SensitivityRow { label: string; cagr: number; mdd: number }

export interface SensitivityResult {
  base: SensitivityRow;
  rows: SensitivityRow[];
  /** 바꾼 조합 중 가장 나쁜·좋은 CAGR, 목표를 넘는 비율 */
  worst: number; best: number; hit: number;
}

export function summarizeSensitivity(base: SensitivityRow, rows: SensitivityRow[], target = TARGET_CAGR): SensitivityResult {
  const c = rows.map((r) => r.cagr).filter(Number.isFinite);
  return {
    base, rows,
    worst: c.length ? Math.min(...c) : NaN, best: c.length ? Math.max(...c) : NaN,
    hit: c.length ? c.filter((x) => x >= target).length / c.length : NaN,
  };
}
