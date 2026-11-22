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
