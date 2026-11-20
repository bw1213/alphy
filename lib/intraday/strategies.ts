/** 단타 전략 (매수만, 그날 안에 정리). 각 전략은 파라미터 후보 묶음을 함께 가짐 */
import { toMin, type Day, type DayRule, type RawTrade } from "./engine";

export interface IntradayStrategy<P = any> {
  id: string;
  name: string;
  desc: string;
  grid: P[];
  label: (p: P) => string;
  rule: DayRule<P>;
  /** 비교용 (단타 전략이 아님) */
  baseline?: boolean;
}

const grid = <T extends Record<string, unknown[]>>(axes: T): { [K in keyof T]: T[K][number] }[] =>
  Object.entries(axes).reduce<any[]>((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);

const close = (d: Day) => d.bars[d.bars.length - 1][4];
const openT = (d: Day) => toMin(d.bars[0][0]);
const at = (d: Day, i: number) => toMin(d.bars[i][0]) - openT(d);
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** i 봉부터 들고 있다가 손절가에 닿으면 손절, 아니면 종가 */
function holdToClose(d: Day, i: number, entry: number, stop: number | null): RawTrade {
  for (let j = i; j <= d.lastCont; j++) {
    const [, o, , l] = d.bars[j];
    if (stop != null && l <= stop) return { inPrice: entry, inKind: "market", outPrice: Math.min(stop, o), outKind: "stop" };
  }
  return { inPrice: entry, inKind: "market", outPrice: close(d), outKind: "auction" };
}

const orb: IntradayStrategy<{ range: number; stop: "low" | "mid"; until: number }> = {
  id: "orb",
  name: "시가 범위 돌파",
  desc: "장 시작 뒤 몇 분의 고가를 넘으면 사고, 그 범위 저가(또는 가운데) 아래로 가면 손절, 아니면 종가에 팝니다.",
  grid: grid({ range: [5, 15, 30], stop: ["low", "mid"] as ("low" | "mid")[], until: [90, 300] }),
  label: (p) => `처음 ${p.range}분 · 손절 ${p.stop === "low" ? "범위 저가" : "범위 가운데"} · 진입 ${hm(9 * 60 + p.until)}까지`,
  rule(d, p) {
    let hi = -Infinity, lo = Infinity, k = 0;
    for (; k <= d.lastCont && at(d, k) < p.range; k++) { hi = Math.max(hi, d.bars[k][2]); lo = Math.min(lo, d.bars[k][3]); }
    if (!Number.isFinite(hi)) return [];
    for (let i = k; i < d.lastCont; i++) {
      if (at(d, i) > p.until) break;
      if (d.bars[i][4] > hi) {
        const stop = p.stop === "low" ? lo : (hi + lo) / 2;
        return [holdToClose(d, i + 1, d.bars[i + 1][1], stop)];
      }
    }
    return [];
  },
};

const gapDown: IntradayStrategy<{ gap: number; target: "fill" | "close"; stop: boolean }> = {
  id: "gap_down",
  name: "갭 하락 되돌림",
  desc: "전날 종가보다 크게 낮게 시작하면 시가에 사고, 전날 종가까지 오르면(또는 종가에) 팝니다.",
  grid: grid({ gap: [1, 2, 3], target: ["fill", "close"] as ("fill" | "close")[], stop: [false, true] }),
  label: (p) => `${p.gap}% 이상 낮게 시작 · ${p.target === "fill" ? "전날 종가 회복 때" : "종가에"} 매도${p.stop ? ` · 손절 -${p.gap}%` : ""}`,
  rule(d, p) {
    if (!d.prevClose) return [];
    const open = d.bars[0][1];
    if (open > d.prevClose * (1 - p.gap / 100)) return [];
    const stop = p.stop ? open * (1 - p.gap / 100) : null;
    for (let j = 0; j <= d.lastCont; j++) {
      const [, o, h, l] = d.bars[j];
      if (stop != null && l <= stop) return [{ inPrice: open, inKind: "auction", outPrice: Math.min(stop, o), outKind: "stop" }];
      if (p.target === "fill" && h > d.prevClose) return [{ inPrice: open, inKind: "auction", outPrice: Math.max(d.prevClose, o), outKind: "limit" }];
    }
    return [{ inPrice: open, inKind: "auction", outPrice: close(d), outKind: "auction" }];
  },
};

const gapUp: IntradayStrategy<{ gap: number; wait: number }> = {
  id: "gap_up",
  name: "갭 상승 추세",
  desc: "전날 종가보다 높게 시작하고 몇 분 뒤에도 시가 위에 있으면 사서, 그때까지의 저가 아래로 가면 손절, 아니면 종가에 팝니다.",
  grid: grid({ gap: [1, 2, 3], wait: [5, 15, 30] }),
  label: (p) => `${p.gap}% 이상 높게 시작 · ${p.wait}분 뒤 시가 위면 매수`,
  rule(d, p) {
    if (!d.prevClose) return [];
    const open = d.bars[0][1];
    if (open < d.prevClose * (1 + p.gap / 100)) return [];
    let lo = Infinity;
    for (let i = 0; i < d.lastCont; i++) {
      lo = Math.min(lo, d.bars[i][3]);
      if (at(d, i + 1) < p.wait) continue;
      if (d.bars[i][4] <= open) return [];
      return [holdToClose(d, i + 1, d.bars[i + 1][1], lo)];
    }
    return [];
  },
};

const lateMomentum: IntradayStrategy<{ first: number; entry: number; min: number }> = {
  id: "late_momentum",
  name: "오전 흐름 따라 막판 매수",
  desc: "전날 종가 대비 장 초반 수익률이 플러스면 오후에 사서 종가에 팝니다 (장 초반 흐름이 막판까지 이어진다는 연구에 기반).",
  grid: grid({ first: [30, 60], entry: [300, 330, 360], min: [0, 0.5] }),
  label: (p) => `처음 ${p.first}분 ${p.min ? `+${p.min}% 이상` : "플러스"}면 ${hm(9 * 60 + p.entry)} 매수`,
  rule(d, p) {
    if (!d.prevClose) return [];
    let k = -1;
    for (let i = 0; i <= d.lastCont && at(d, i) < p.first; i++) k = i;
    if (k < 0 || d.bars[k][4] / d.prevClose - 1 <= p.min / 100) return [];
    for (let i = k + 1; i <= d.lastCont; i++) {
      if (at(d, i) >= p.entry) return [{ inPrice: d.bars[i][1], inKind: "market", outPrice: close(d), outKind: "auction" }];
    }
    return [];
  },
};

const vwapRevert: IntradayStrategy<{ dip: number; stop: number }> = {
  id: "vwap_revert",
  name: "평균 체결가 아래 매수",
  desc: "오늘 평균 체결가(VWAP)보다 일정 % 넘게 내려가면 사서, 평균 체결가로 돌아오면 팔고 손절선을 지킵니다. 하루 최대 3번.",
  grid: grid({ dip: [0.5, 1, 2], stop: [1, 2] }),
  label: (p) => `평균가보다 ${p.dip}% 아래면 매수 · 손절 -${p.stop}%`,
  rule(d, p) {
    const out: RawTrade[] = [];
    let pv = 0, vol = 0;
    let entry: number | null = null;
    const lastEntry = toMin(d.bars[d.lastCont][0]) - openT(d) - 30;
    for (let i = 0; i <= d.lastCont; i++) {
      const [, o, h, l, c, v] = d.bars[i];
      const vwap = vol > 0 ? pv / vol : o;
      if (entry != null) {
        if (l <= entry * (1 - p.stop / 100)) { out.push({ inPrice: entry, inKind: "market", outPrice: Math.min(entry * (1 - p.stop / 100), o), outKind: "stop" }); entry = null; }
        else if (h > vwap) { out.push({ inPrice: entry, inKind: "market", outPrice: Math.max(vwap, o), outKind: "limit" }); entry = null; }
      }
      pv += ((h + l + c) / 3) * v; vol += v;
      if (entry == null && out.length < 3 && at(d, i) >= 30 && at(d, i) < lastEntry && i < d.lastCont && vol > 0 && c < (pv / vol) * (1 - p.dip / 100)) {
        entry = d.bars[i + 1][1];
      }
    }
    if (entry != null) out.push({ inPrice: entry, inKind: "market", outPrice: close(d), outKind: "auction" });
    return out;
  },
};

const intraday: IntradayStrategy<Record<string, never>> = {
  id: "open_close",
  name: "시가 매수 · 종가 매도 (비교용)",
  desc: "매일 시가에 사서 종가에 팝니다. 낮 동안만 들고 있으면 얼마인지 보는 기준선입니다.",
  grid: [{}],
  label: () => "매일",
  baseline: true,
  rule: (d) => [{ inPrice: d.bars[0][1], inKind: "auction", outPrice: close(d), outKind: "auction" }],
};

const overnight: IntradayStrategy<Record<string, never>> = {
  id: "overnight",
  name: "종가 매수 · 다음 날 시가 매도 (비교용)",
  desc: "단타가 아니라 밤사이만 들고 있는 기준선입니다. 주가 상승이 낮과 밤 중 어디서 나오는지 비교하려고 넣었습니다.",
  grid: [{}],
  label: () => "매일",
  baseline: true,
  rule: (d, _p, next) => (next ? [{ inPrice: close(d), inKind: "auction", outPrice: next.bars[0][1], outKind: "auction", overnight: true }] : []),
};

export const INTRADAY_STRATEGIES: IntradayStrategy[] = [orb, gapDown, gapUp, lateMomentum, vwapRevert, intraday, overnight];
