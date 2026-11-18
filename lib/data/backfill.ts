/**
 * 상장 전 기간 채우기: ETF 가 상장되기 전 기간을 기초지수(또는 그 지수를 오래 따라온 다른 ETF)의 움직임으로 이어 붙인다.
 *
 *  - 종목마다 이어 붙일 순서(chain)를 정한다. 예: 498400 ← 069500(KODEX 200) ← ^KS11(KOSPI)
 *    앞의 것부터 채우고, 그것도 모자라면 다음 것으로 더 앞을 채운다
 *  - 레버리지·인버스: 하루 수익률 × 배수 − (배수 − 1) × 단기금리 − 보수. 배수가 1이 아니면 배당도 수익률에 넣는다(총수익)
 *  - 배수가 1이면 가격 움직임만 잇고, 그 기간 배당은 이어 붙인 가격 비율대로 따로 넣는다
 *  - 통화: 미국 종목은 달러로 잇고 원화로 바꾼다. 한국 종목은 원화로 잇되, 환헤지(H)면 달러 수익률을 그대로 쓴다
 *  - 커버드콜·액티브처럼 지수와 운용이 다른 ETF 는 비슷하게만 따라간다 (낙폭은 비슷, 오를 때 덜 오르는 점·분배금은 다름)
 */
import type { Bar, Dividend } from "../engine/types";
import { isUsTicker } from "./market";

export interface BackfillSpec {
  /** 이어 붙일 순서: 종목 코드(069500, SPY), 야후 지수(^KS11, ^GSPC), 금리(RATE:KR, RATE:US) */
  chain: string[];
  /** 배수 (1, 2, 3, -1, -2, -3) */
  lev: number;
  /** 연 보수(%) */
  fee: number;
  /** 환헤지: 한국 종목이 미국 자산을 따라갈 때 달러 수익률을 그대로 씀 (환율 변동 없음) */
  hedged?: boolean;
}

export type Currency = "KRW" | "USD";

export interface ProxyInfo { id: string; name: string; group: string; currency: Currency; /** 가격 지수의 연 배당수익률(%) 가정: 배당이 빠진 지수라 그만큼 매일 더함 */ yield?: number }

/** 배당이 빠진 가격 지수의 평균 배당수익률 가정(연 %). 대략값 */
const INDEX_YIELD: Record<string, number> = { "^KS11": 1.8, "^KQ11": 0.6, "^GSPC": 1.9, "^NDX": 0.9, "^IXIC": 1.0, "^DJI": 2.2, "^RUT": 1.4, "^SOX": 1.2 };
export const proxyYield = (id: string) => INDEX_YIELD[id] ?? 0;

/** 고를 수 있는 지수·대용 목록 */
export const PROXIES: ProxyInfo[] = [
  ...([
    ["^KS11", "KOSPI 지수 (1996~)", "KRW"], ["^KQ11", "KOSDAQ 지수 (2000~)", "KRW"],
    ["069500", "KOSPI 200 (KODEX 200)", "KRW"], ["229200", "KOSDAQ 150 (KODEX 코스닥150)", "KRW"],
  ] as const).map(([id, name, c]) => ({ id, name, group: "한국", currency: c as Currency })),
  ...([
    ["^GSPC", "S&P 500 지수 (1970~)"], ["^NDX", "나스닥 100 지수 (1985~)"], ["^IXIC", "나스닥 종합 지수 (1971~)"],
    ["^DJI", "다우존스 지수 (1992~)"], ["^RUT", "러셀 2000 지수 (1987~)"], ["^SOX", "필라델피아 반도체 지수 (1994~)"],
  ] as const).map(([id, name]) => ({ id, name, group: "미국 지수", currency: "USD" as Currency, yield: INDEX_YIELD[id] })),
  ...([
    ["SPY", "S&P 500 (SPY, 배당 포함)"], ["QQQ", "나스닥 100 (QQQ)"], ["DIA", "다우존스 (DIA)"], ["IWM", "러셀 2000 (IWM)"],
    ["MDY", "미국 중형주 (MDY)"], ["SOXX", "미국 반도체 (SOXX)"], ["SCHD", "미국 배당 다우존스 (SCHD, 2011~)"],
    ["XLK", "미국 기술 (XLK)"], ["XLF", "미국 금융 (XLF)"], ["XLE", "미국 에너지 (XLE)"], ["XLV", "미국 헬스케어 (XLV)"],
    ["XLY", "미국 경기소비재 (XLY)"], ["XLP", "미국 필수소비재 (XLP)"], ["XLI", "미국 산업재 (XLI)"], ["XLU", "미국 유틸리티 (XLU)"],
    ["XLB", "미국 소재 (XLB)"], ["VNQ", "미국 리츠 (VNQ)"],
  ] as const).map(([id, name]) => ({ id, name, group: "미국 주식", currency: "USD" as Currency })),
  ...([
    ["EFA", "선진국 (EFA)"], ["EEM", "신흥국 (EEM)"], ["VGK", "유럽 (VGK)"], ["EWJ", "일본 (EWJ)"], ["FXI", "중국 (FXI)"],
    ["EWT", "대만 (EWT)"], ["INDA", "인도 (INDA, 2012~)"], ["EWZ", "브라질 (EWZ)"], ["EWY", "한국, 달러 기준 (EWY)"],
  ] as const).map(([id, name]) => ({ id, name, group: "해외 주식", currency: "USD" as Currency })),
  ...([
    ["TLT", "미국 장기채 20년+ (TLT)"], ["IEF", "미국 중기채 7~10년 (IEF)"], ["SHY", "미국 단기채 1~3년 (SHY)"], ["AGG", "미국 종합채권 (AGG)"],
    ["LQD", "미국 회사채 (LQD)"], ["HYG", "미국 하이일드 (HYG)"], ["TIP", "미국 물가연동채 (TIP)"],
    ["GLD", "금 (GLD)"], ["SLV", "은 (SLV)"], ["USO", "원유 (USO)"], ["DBC", "원자재 (DBC)"],
    ["VUSTX", "미국 장기 국채 펀드 (VUSTX, 1986~)"], ["VFITX", "미국 중기 국채 펀드 (VFITX, 1991~)"], ["VFISX", "미국 단기 국채 펀드 (VFISX, 1991~)"],
    ["VBMFX", "미국 종합채권 펀드 (VBMFX, 1986~)"], ["GC=F", "금 선물 (2000~)"], ["SI=F", "은 선물 (2000~)"], ["CL=F", "원유 선물 (2000~)"],
  ] as const).map(([id, name]) => ({ id, name, group: "채권·원자재", currency: "USD" as Currency })),
  { id: "RATE:KR", name: "한국 기준금리 (현금성)", group: "금리", currency: "KRW" },
  { id: "RATE:US", name: "미국 3개월 국채 금리 (^IRX)", group: "금리", currency: "USD" },
];

export const proxyName = (id: string) => PROXIES.find((p) => p.id === id)?.name ?? id;

/** 대용의 통화: 미국 티커·미국 지수·미국 금리는 달러 */
export function proxyCurrency(id: string): Currency {
  const p = PROXIES.find((x) => x.id === id);
  if (p) return p.currency;
  return isUsTicker(id) ? "USD" : "KRW";
}

const C = (chain: string[], lev = 1, fee = 0, hedged = false): BackfillSpec => ({ chain, lev, fee, ...(hedged ? { hedged } : {}) });
const LT = ["TLT", "VUSTX"], IT = ["IEF", "VFITX"], AU = ["GLD", "GC=F"], AG = ["SLV", "SI=F"];
const SP = ["SPY", "^GSPC"], NQ = ["QQQ", "^NDX"], SOX = ["SOXX", "^SOX"], K200 = ["069500", "^KS11"], KQ = ["229200", "^KQ11"];

/** 잘 알려진 ETF 의 기본 대용 */
export const KNOWN: Record<string, BackfillSpec> = {
  // 미국
  SPY: C(["^GSPC"], 1, 0.09), VOO: C(SP, 1, 0.03), IVV: C(SP, 1, 0.03), SPLG: C(SP, 1, 0.02), VTI: C(SP, 1, 0.03),
  QQQ: C(["^NDX"], 1, 0.2), QQQM: C(NQ, 1, 0.15), DIA: C(["^DJI"], 1, 0.16), IWM: C(["^RUT"], 1, 0.19),
  SOXX: C(["^SOX"], 1, 0.35), SMH: C(SOX, 1, 0.35),
  SSO: C(SP, 2, 0.89), UPRO: C(SP, 3, 0.91), SPXL: C(SP, 3, 0.91), SH: C(SP, -1, 0.89), SDS: C(SP, -2, 0.89), SPXU: C(SP, -3, 0.9), SPXS: C(SP, -3, 1.0),
  QLD: C(NQ, 2, 0.95), TQQQ: C(NQ, 3, 0.84), PSQ: C(NQ, -1, 0.95), QID: C(NQ, -2, 0.95), SQQQ: C(NQ, -3, 0.95),
  SOXL: C(SOX, 3, 0.75), SOXS: C(SOX, -3, 0.97), USD: C(SOX, 2, 0.95),
  TMF: C(LT, 3, 1.06), TMV: C(LT, -3, 1.0), UBT: C(LT, 2, 0.95), TBT: C(LT, -2, 0.9), UST: C(IT, 2, 0.95), TYD: C(IT, 3, 1.0),
  // 채권·금: 상장 전은 뱅가드 국채 펀드(1986~·1991~), 금·은은 선물(2000~)
  TLT: C(["VUSTX"], 1, 0.15), IEF: C(["VFITX"], 1, 0.15), SHY: C(["VFISX"], 1, 0.15), AGG: C(["VBMFX"], 1, 0.03),
  GLD: C(["GC=F"], 1, 0.4), IAU: C(AU, 1, 0.25), SLV: C(["SI=F"], 1, 0.5),
  TNA: C(["IWM", "^RUT"], 3, 1.08), TZA: C(["IWM", "^RUT"], -3, 1.0), UWM: C(["IWM", "^RUT"], 2, 0.95),
  UDOW: C(["DIA", "^DJI"], 3, 0.95), DDM: C(["DIA", "^DJI"], 2, 0.95), SDOW: C(["DIA", "^DJI"], -3, 0.95),
  TECL: C(["XLK"], 3, 0.94), FAS: C(["XLF"], 3, 0.93), UGL: C(AU, 2, 0.95), AGQ: C(AG, 2, 0.95),
  // 한국
  "069500": C(["^KS11"], 1, 0.15), "102110": C(K200, 1, 0.05), "498400": C(K200, 1, 0.39),
  "122630": C(K200, 2, 0.64), "114800": C(K200, -1, 0.64), "252670": C(K200, -2, 0.64),
  "229200": C(["^KQ11"], 1, 0.25), "233740": C(KQ, 2, 0.64), "251340": C(KQ, -1, 0.64),
  "360750": C(SP, 1, 0.07), "379800": C(SP, 1, 0.01), "448290": C(SP, 1, 0.05, true), "482730": C(SP, 1, 0.25),
  "133690": C(NQ, 1, 0.07), "379810": C(NQ, 1, 0.01), "381180": C(SOX, 1, 0.49), "381170": C(NQ, 1, 0.49), "474220": C(NQ, 1, 0.5),
  "280930": C(["IWM", "^RUT"], 1, 0.3, true), "446720": C(["SCHD"], 1, 0.01), "458730": C(["SCHD"], 1, 0.01),
  "453010": C(["RATE:KR"], 1, 0.05), "423160": C(["RATE:KR"], 1, 0.05), "449170": C(["RATE:KR"], 1, 0.05),
  "357870": C(["RATE:KR"], 1, 0.03), "459580": C(["RATE:KR"], 1, 0.05),
  "132030": C(AU, 1, 0.68, true), "411060": C(AU, 1, 0.5), "308620": C(IT, 1, 0.3), "304660": C(LT, 1, 0.3, true),
};

/** 이름으로 대용 추측 (한국 ETF 이름 규칙). 모르면 null */
export function guessFromName(name: string): BackfillSpec | null {
  const n = name.replace(/\s+/g, "").toUpperCase();
  const hedged = /\(H\)/.test(n);
  let chain: string[] | null = null;
  if (/KOFR|CD금리|머니마켓|MMF|단기통안|초단기/.test(n)) chain = ["RATE:KR"];
  else if (/코스닥150/.test(n)) chain = KQ;
  else if (/S&P500|S&P 500/.test(n)) chain = SP;
  else if (/나스닥100/.test(n)) chain = NQ;
  else if (/반도체/.test(n) && /미국|필라델피아/.test(n)) chain = SOX;
  else if (/러셀2000/.test(n)) chain = ["IWM", "^RUT"];
  else if (/배당다우존스/.test(n)) chain = ["SCHD"];
  else if (/다우존스/.test(n)) chain = ["DIA", "^DJI"];
  else if (/금현물|골드|GOLD/.test(n)) chain = AU;
  else if (/미국.*(30년|울트라|20년)/.test(n)) chain = LT;
  else if (/미국.*10년/.test(n)) chain = IT;
  else if (/(^|[A-Z가-힣])200($|[^0-9])/.test(n) && !/코스닥/.test(n)) chain = K200;
  if (!chain) return null;
  const lev = /인버스2X|인버스\(2X\)/.test(n) ? -2 : /인버스/.test(n) ? -1 : /레버리지|2X/.test(n) ? 2 : 1;
  const fee = lev === 1 ? (chain[0] === "RATE:KR" ? 0.05 : 0.2) : 0.64;
  return C(chain, lev, fee, hedged);
}

/** 그 종목의 기본 대용 (알려진 목록 → 이름 규칙). 모르면 null */
export function suggestSpec(code: string, name?: string): BackfillSpec | null {
  return KNOWN[code] ?? (name ? guessFromName(name) : null);
}

/** 화면·요청에서 온 값 정리 */
export function cleanSpec(x: any): BackfillSpec | null {
  const chain = (Array.isArray(x?.chain) ? x.chain : String(x?.chain ?? "").split(/[\s,>]+/)).map((s: any) => String(s).trim().toUpperCase()).filter((s: string) => /^(\^[A-Z0-9.]{2,10}|[A-Z]{1,3}=F|RATE:(KR|US)|[0-9][0-9A-Z]{5}|[A-Z][A-Z0-9.]{0,9})$/.test(s)).slice(0, 4);
  if (!chain.length) return null;
  const lev = Number(x?.lev);
  const fee = Number(x?.fee);
  return { chain, lev: Number.isFinite(lev) && lev !== 0 && Math.abs(lev) <= 5 ? lev : 1, fee: Number.isFinite(fee) && fee >= 0 && fee <= 5 ? fee : 0, ...(x?.hedged ? { hedged: true } : {}) };
}

/** 한국은행 기준금리 (변경일, 연 %) — 원화 현금성 대용·레버리지 이자 */
export const KR_BASE_RATE: [string, number][] = [
  ["1999-05-06", 4.75], ["2000-02-10", 5.0], ["2000-10-05", 5.25], ["2001-02-08", 5.0], ["2001-07-05", 4.75], ["2001-08-09", 4.5],
  ["2001-09-19", 4.0], ["2002-05-07", 4.25], ["2003-05-13", 4.0], ["2003-07-10", 3.75], ["2004-08-12", 3.5], ["2004-11-11", 3.25],
  ["2005-10-11", 3.5], ["2005-12-08", 3.75], ["2006-02-09", 4.0], ["2006-06-08", 4.25], ["2006-08-10", 4.5], ["2007-07-12", 4.75],
  ["2007-08-09", 5.0], ["2008-08-07", 5.25], ["2008-10-09", 5.0], ["2008-10-27", 4.25], ["2008-11-07", 4.0], ["2008-12-11", 3.0],
  ["2009-01-09", 2.5], ["2009-02-12", 2.0], ["2010-07-09", 2.25], ["2010-11-16", 2.5], ["2011-01-13", 2.75], ["2011-03-10", 3.0],
  ["2011-06-10", 3.25], ["2012-07-12", 3.0], ["2012-10-11", 2.75], ["2013-05-09", 2.5], ["2014-08-14", 2.25], ["2014-10-15", 2.0],
  ["2015-03-12", 1.75], ["2015-06-11", 1.5], ["2016-06-09", 1.25], ["2017-11-30", 1.5], ["2018-11-30", 1.75], ["2019-07-18", 1.5],
  ["2019-10-16", 1.25], ["2020-03-17", 0.75], ["2020-05-28", 0.5], ["2021-08-26", 0.75], ["2021-11-25", 1.0], ["2022-01-14", 1.25],
  ["2022-04-14", 1.5], ["2022-05-26", 1.75], ["2022-07-13", 2.25], ["2022-08-25", 2.5], ["2022-10-12", 3.0], ["2022-11-24", 3.25],
  ["2023-01-13", 3.5], ["2024-10-11", 3.25], ["2024-11-28", 3.0], ["2025-02-25", 2.75], ["2025-05-29", 2.5],
];

/** 날짜 → 연 금리(소수). table 은 [변경일, %] 오름차순, 또는 일별 % 막대 */
export function rateAt(table: [string, number][], date: string): number {
  let lo = 0, hi = table.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (table[m][0] <= date) { k = m; lo = m + 1; } else hi = m - 1; }
  return (k >= 0 ? table[k][1] : table.length ? table[0][1] : 0) / 100;
}

/** from~to 평일마다 금리만큼 자라는 가격 (현금성 ETF 대용) */
export function rateBars(table: [string, number][], from: string, to: string): Bar[] {
  const out: Bar[] = [];
  let px = 10_000;
  for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const date = d.toISOString().slice(0, 10);
    if (out.length) px *= 1 + rateAt(table, date) / 252;
    out.push({ date, open: px, high: px, low: px, close: px, volume: 1 });
  }
  return out;
}

/**
 * target(같은 통화) 앞 기간을 proxy 움직임으로 채움. 둘 다 같은 통화여야 함.
 * rf: 그 날짜의 연 금리(소수) — 배수가 1이 아닐 때 이자 비용/수익. carry: 가격 지수에 더할 연 배당수익률(소수)
 * 반환 bars 는 target 첫날보다 앞선 막대만 (from 이후), divs 는 그 기간 배당 (배수 1일 때만)
 */
export function extendBars(target: Bar[], proxy: Bar[], proxyDivs: Dividend[], spec: { lev: number; fee: number }, rf: (date: string) => number, from: string, carry = 0): { bars: Bar[]; divs: Dividend[] } {
  if (!target.length || proxy.length < 2) return { bars: [], divs: [] };
  const t0 = target[0].date;
  const P = proxy.filter((b) => b.close > 0);
  // 앵커: target 첫날과 같은 날(종가 맞춤) 또는 그 직전 proxy 날(target 첫날 시가에 맞춤)
  let a = -1;
  for (let i = 0; i < P.length && P[i].date <= t0; i++) a = i;
  if (a < 1) return { bars: [], divs: [] };
  const first = P.findIndex((b) => b.date >= from);
  if (first < 0 || first >= a) return { bars: [], divs: [] };
  const lev = spec.lev, fee = spec.fee / 100;
  const divOn = new Map<string, number>();
  for (const d of proxyDivs) divOn.set(d.date, (divOn.get(d.date) ?? 0) + d.amount);
  // 합성 가격 S (앵커 전까지 앞에서부터)
  const S: { o: number; h: number; l: number; c: number }[] = new Array(P.length);
  S[first] = { o: P[first].open / P[first].close, h: P[first].high / P[first].close, l: P[first].low / P[first].close, c: 1 };
  for (let i = first + 1; i <= a; i++) {
    const p = P[i - 1], q = P[i];
    // 배수가 1이 아니면 배당도 수익률에 (총수익). carry = 배당이 빠진 가격 지수에 더하는 하루 배당수익률
    const div = (lev !== 1 ? (divOn.get(q.date) ?? 0) / p.close : 0) + carry / 252;
    const cost = (lev - 1) * rf(q.date) / 252 + fee / 252;
    const step = (x: number) => 1 + lev * (x / p.close - 1);
    const prev = S[i - 1].c;
    const c = prev * Math.max(0.0001, step(q.close) + lev * div - cost);
    let o = prev * Math.max(0.0001, step(q.open)), h = prev * Math.max(0.0001, step(q.high)), l = prev * Math.max(0.0001, step(q.low));
    if (lev < 0) [h, l] = [l, h]; // 인버스는 기초가 저가일 때 고가
    S[i] = { o, h: Math.max(h, o, c), l: Math.min(l, o, c), c };
  }
  const anchorPx = P[a].date === t0 ? target[0].close : target[0].open;
  const k = anchorPx / S[a].c;
  const bars: Bar[] = [];
  const divs: Dividend[] = [];
  for (let i = first; i < a || (i === a && P[a].date < t0); i++) {
    if (P[i].date >= t0) break;
    bars.push({ date: P[i].date, open: S[i].o * k, high: S[i].h * k, low: S[i].l * k, close: S[i].c * k, volume: P[i].volume > 0 ? P[i].volume : 1 });
    const dv = divOn.get(P[i].date);
    if (lev === 1 && dv && i > first) divs.push({ date: P[i].date, amount: dv * (S[i - 1].c * k) / P[i - 1].close });
  }
  return { bars, divs };
}
