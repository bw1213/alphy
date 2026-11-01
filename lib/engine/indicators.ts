/** 배열 끝 기준 지표 계산 유틸 (NaN 은 건너뛰지 않으므로 결측이 있으면 NaN 반환). */
export function sma(xs: ArrayLike<number>, end: number, n: number): number {
  if (end + 1 < n) return NaN;
  let s = 0;
  for (let k = end - n + 1; k <= end; k++) s += xs[k];
  return s / n;
}

/** Wilder RSI. end 시점까지만 사용, 최근 lookback 구간으로 계산 */
export function rsi(xs: ArrayLike<number>, end: number, n = 14, lookback = n * 6): number {
  const start = Math.max(1, end - lookback);
  if (end - start < n) return NaN;
  let up = 0, dn = 0, init = false, cnt = 0;
  for (let k = start; k <= end; k++) {
    const d = xs[k] - xs[k - 1];
    if (Number.isNaN(d)) continue;
    const u = Math.max(d, 0), v = Math.max(-d, 0);
    if (!init) {
      up += u; dn += v; cnt++;
      if (cnt === n) { up /= n; dn /= n; init = true; }
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + v) / n;
    }
  }
  if (!init) return NaN;
  if (dn === 0) return 100;
  return 100 - 100 / (1 + up / dn);
}

export function stdev(xs: ArrayLike<number>, end: number, n: number): number {
  const m = sma(xs, end, n);
  if (Number.isNaN(m)) return NaN;
  let s = 0;
  for (let k = end - n + 1; k <= end; k++) s += (xs[k] - m) ** 2;
  return Math.sqrt(s / (n - 1));
}
