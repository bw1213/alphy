export interface WeakPeriod {
  peak: string;
  trough: string;
  /** 전 고점을 다시 넘은 날. 끝까지 회복 못 했으면 null */
  recovered: string | null;
  depth: number;
  days: number;
  i0: number; iTrough: number; i1: number;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

export function weakPeriods(dates: string[], values: number[], top = 5, minDepth = 0.05): WeakPeriod[] {
  const out: WeakPeriod[] = [];
  let peak = -Infinity, pk = -1, tr = -1;
  const close = (end: number, recovered: boolean) => {
    if (pk < 0 || tr < 0) return;
    const depth = values[tr] / peak - 1;
    if (-depth >= minDepth) out.push({
      peak: dates[pk], trough: dates[tr], recovered: recovered ? dates[end] : null, depth,
      days: dayDiff(dates[pk], dates[end]), i0: pk, iTrough: tr, i1: end,
    });
  };
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v)) continue;
    if (v >= peak) {
      if (tr >= 0) close(k, true);
      peak = v; pk = k; tr = -1;
    } else if (tr < 0 || v < values[tr]) tr = k;
  }
  if (tr >= 0) close(values.length - 1, false);
  return out.sort((a, b) => a.depth - b.depth).slice(0, top);
}

export function rollingReturn(dates: string[], values: (number | null)[], days = 365): (number | null)[] {
  const t = dates.map((d) => Date.parse(d));
  const out: (number | null)[] = [];
  let j = 0;
  const first = values.findIndex((v) => v != null && Number.isFinite(v));
  for (let k = 0; k < dates.length; k++) {
    const v = values[k];
    const back = t[k] - days * 864e5;
    while (j + 1 <= k && t[j + 1] <= back) j++;
    if (first < 0 || v == null || !Number.isFinite(v) || t[first] > back || j < first) { out.push(null); continue; }
    const b = values[j];
    out.push(b != null && b > 0 ? v / b - 1 : null);
  }
  return out;
}

export function relative(a: (number | null)[], b: (number | null)[]): (number | null)[] {
  let base: number | null = null;
  return a.map((x, k) => {
    const y = b[k];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return null;
    const r = x / y;
    if (base == null) base = r;
    return (r / base) * 100;
  });
}

export function periodReturn(values: (number | null)[], i0: number, i1: number): number | null {
  const a = values[i0], b = values[i1];
  return a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && a > 0 ? b / a - 1 : null;
}
