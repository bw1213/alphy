/**
 * 계좌 누적 수익률 (입금·출금 효과를 뺀 시간가중 수익률). 서버·화면 함께 씀.
 *
 * 기록 사이 수익률 = (이번 평가액 − 그 사이 입출금) ÷ 지난 평가액. 이를 곱해 이어 간다.
 * 입출금은 그 뒤 처음 찍힌 기록에 붙인다. 첫 기록 전 입출금은 첫 평가액에 이미 들어 있어 뺀다.
 */

export interface Flow {
  id: string;
  date: string;
  /** 입금 +, 출금 − (원) */
  amount: number;
  /** 기록한 시각 */
  at: string;
  note?: string;
  /** 수동 계좌를 고쳐서 저절로 생긴 기록 */
  auto?: boolean;
  /** 수동 계좌 예수금에 더한 기록 (고치거나 지우면 예수금도 되돌림) */
  cash?: boolean;
}

export interface ValuePoint { date: string; total: number; at?: string }
export interface ReturnPoint { date: string; total: number; flow: number; ret: number }

/** 시각이 없는 옛 기록은 그날 끝(한국 시각)에 찍은 것으로 본다 */
const pointAt = (p: ValuePoint) => p.at ?? `${p.date}T14:59:59.999Z`;

/** 입출금이 붙는 기록 번호 (없으면 -1: 아직 반영 안 된 입출금) */
export function flowIndex(points: ValuePoint[], f: Pick<Flow, "date" | "at">): number {
  return points.findIndex((p) => p.date > f.date || (p.date === f.date && pointAt(p) >= f.at));
}

/** 기록마다 그 사이 입출금 합 */
export function flowsByPoint(points: ValuePoint[], flows: Flow[]): number[] {
  const out = points.map(() => 0);
  for (const f of flows) {
    const i = flowIndex(points, f);
    if (i > 0) out[i] += f.amount;
  }
  return out;
}

/** 날짜순 평가액·입출금 → 누적 수익률(%) */
export function chain(rows: { date: string; total: number; flow: number }[]): ReturnPoint[] {
  let g = 1;
  return rows.map((r, i) => {
    if (i > 0) {
      const prev = rows[i - 1].total;
      const step = prev > 0 ? (r.total - r.flow) / prev : r.flow > 0 ? r.total / r.flow : 1;
      if (Number.isFinite(step) && step > 0) g *= step;
    }
    return { date: r.date, total: r.total, flow: r.flow, ret: (g - 1) * 100 };
  });
}

export function accountReturns(points: ValuePoint[], flows: Flow[]): ReturnPoint[] {
  const ps = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const fs = flowsByPoint(ps, flows);
  return chain(ps.map((p, i) => ({ date: p.date, total: p.total, flow: fs[i] })));
}

/**
 * 여러 계좌를 합친 누적 수익률. 기록이 없는 날은 그 계좌의 직전 평가액으로 이어 가고,
 * 나중에 생긴 계좌의 첫 평가액은 그날 들어온 입금으로 본다.
 */
export function combinedReturns(accounts: { points: ValuePoint[]; flows: Flow[] }[]): ReturnPoint[] {
  const per = accounts.map((a) => {
    const ps = [...a.points].sort((x, y) => x.date.localeCompare(y.date));
    const fs = flowsByPoint(ps, a.flows);
    return new Map(ps.map((p, i) => [p.date, { total: p.total, flow: i === 0 ? p.total : fs[i] }]));
  });
  const dates = [...new Set(per.flatMap((m) => [...m.keys()]))].sort();
  const last = per.map(() => 0);
  const rows = dates.map((date, di) => {
    let total = 0, flow = 0;
    per.forEach((m, k) => {
      const p = m.get(date);
      if (p) { last[k] = p.total; flow += p.flow; }
      total += last[k];
    });
    return { date, total, flow: di === 0 ? 0 : flow };
  });
  return chain(rows);
}

/** from 날짜부터 다시 0%로 맞춘 누적 수익률 (from 직전 기록이 출발점) */
export function since(list: ReturnPoint[], from: string): ReturnPoint[] {
  if (!list.length) return [];
  let start = 0;
  for (let i = 0; i < list.length; i++) if (list[i].date <= from) start = i;
  const b = 1 + list[start].ret / 100;
  return list.slice(start).map((p) => ({ ...p, ret: ((1 + p.ret / 100) / b - 1) * 100 }));
}

const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 864e5;

/** 해마다 수익률 (그해 마지막 기록 ÷ 전해 마지막 기록). 첫해는 첫 기록부터 */
export function yearlyReturns(list: ReturnPoint[]): { year: string; ret: number; from: string; to: string }[] {
  const out: { year: string; ret: number; from: string; to: string }[] = [];
  let base = list[0];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const y = p.date.slice(0, 4);
    if (i === list.length - 1 || list[i + 1].date.slice(0, 4) !== y) {
      out.push({ year: y, ret: ((1 + p.ret / 100) / (1 + base.ret / 100) - 1) * 100, from: base.date, to: p.date });
      base = p;
    }
  }
  return out;
}

/** 연평균 (시간가중). 1년 안 되면 null */
export function annualized(list: ReturnPoint[]): number | null {
  if (list.length < 2) return null;
  const d = days(list[0].date, list.at(-1)!.date);
  if (d < 365) return null;
  return (Math.pow(1 + list.at(-1)!.ret / 100, 365 / d) - 1) * 100;
}

/** 넣은 돈(첫 평가액 + 그 뒤 순입금)과 지금 평가액 */
export function moneySummary(list: ReturnPoint[]): { invested: number; value: number; profit: number } | null {
  if (!list.length) return null;
  const invested = list[0].total + list.slice(1).reduce((s, p) => s + p.flow, 0);
  const value = list.at(-1)!.total;
  return { invested, value, profit: value - invested };
}

/** 금액가중 수익률(연, %): 첫 평가액과 입출금을 넣은 돈으로, 지금 평가액을 받는 돈으로 보는 내부수익률 */
export function moneyWeighted(list: ReturnPoint[]): number | null {
  if (list.length < 2) return null;
  const t0 = list[0].date;
  const end = list.at(-1)!;
  if (days(t0, end.date) < 30) return null;
  const cfs = [{ t: 0, v: -list[0].total }, ...list.slice(1).filter((p) => p.flow).map((p) => ({ t: days(t0, p.date) / 365, v: -p.flow })), { t: days(t0, end.date) / 365, v: end.total }];
  const npv = (r: number) => cfs.reduce((s, c) => s + c.v / Math.pow(1 + r, c.t), 0);
  let lo = -0.99, hi = 10;
  const a = npv(lo), b = npv(hi);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a * b > 0) return null;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (npv(m) * a > 0) lo = m; else hi = m;
  }
  return ((lo + hi) / 2) * 100;
}

/** 가장 크게 빠진 폭 (%) */
export function maxDrawdown(list: ReturnPoint[]): number {
  let peak = 1, mdd = 0;
  for (const p of list) { const g = 1 + p.ret / 100; peak = Math.max(peak, g); mdd = Math.min(mdd, g / peak - 1); }
  return mdd * 100;
}
