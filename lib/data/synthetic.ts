import type { Bar, PriceData } from "../engine/types";

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r: () => number) {
  const u = Math.max(r(), 1e-12), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function businessDays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z"), e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** 오프라인 테스트용 랜덤워크 데이터 (실제 시장과 무관) */
export function syntheticSeries(dates: string[], seed: number): Bar[] {
  const r = mulberry32(seed);
  const drift = 0.0003 + normal(r) * 0.0004;
  const vol = 0.012 + r() * 0.018;
  let c = 10000;
  return dates.map((date) => {
    c *= Math.exp(drift + vol * normal(r));
    const o = c * Math.exp((normal(r) * vol) / 3);
    const h = Math.max(o, c) * (1 + Math.abs(normal(r) * vol) / 2);
    const l = Math.min(o, c) * (1 - Math.abs(normal(r) * vol) / 2);
    return { date, open: o, high: h, low: l, close: c, volume: Math.floor(50_000 + r() * 2_000_000) };
  });
}

export function syntheticData(n: number, start: string, end: string) {
  const dates = businessDays(start, end);
  const data: PriceData = {};
  const names: Record<string, string> = {};
  for (let k = 0; k < n; k++) {
    const code = `S${String(k).padStart(5, "0")}`;
    data[code] = syntheticSeries(dates, 42 + k);
    names[code] = `가상종목${k + 1}`;
  }
  const benchmark = syntheticSeries(dates, 7).map((b) => ({ date: b.date, close: b.close }));
  return { data, names, benchmark };
}
