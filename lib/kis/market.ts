/**
 * KIS 시세 조회: 국내주식 기간별 일봉(수정주가), 업종(KOSPI 지수) 일봉, 현재가.
 * 한 번 호출에 최대 100건만 오므로 종료일을 뒤로 당기며 반복 조회합니다.
 */
import type { Bar } from "../engine/types";
import type { KisClient } from "./client";

const ymd = (iso: string) => iso.replace(/-/g, "");
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const num = (s: unknown) => Number(String(s ?? "").replace(/,/g, ""));

/** YYYYMMDD 하루 전 */
export function prevDay(d: string): string {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - 864e5;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}

/** inquire-daily-itemchartprice output2 → Bar[] (오름차순) */
export function parseStockDaily(rows: any[] | undefined): Bar[] {
  return (rows ?? [])
    .filter((r) => /^\d{8}$/.test(String(r?.stck_bsop_date ?? "")))
    .map((r) => ({
      date: iso(r.stck_bsop_date),
      open: num(r.stck_oprc), high: num(r.stck_hgpr), low: num(r.stck_lwpr), close: num(r.stck_clpr),
      volume: num(r.acml_vol),
    }))
    .filter((b) => b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** inquire-daily-indexchartprice output2 → Bar[] (오름차순) */
export function parseIndexDaily(rows: any[] | undefined): Bar[] {
  return (rows ?? [])
    .filter((r) => /^\d{8}$/.test(String(r?.stck_bsop_date ?? "")))
    .map((r) => ({
      date: iso(r.stck_bsop_date),
      open: num(r.bstp_nmix_oprc), high: num(r.bstp_nmix_hgpr), low: num(r.bstp_nmix_lwpr), close: num(r.bstp_nmix_prpr),
      volume: num(r.acml_vol),
    }))
    .filter((b) => b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 종료일부터 과거로 100건씩 받아 합침 */
async function paginate(start: string, end: string, page: (from: string, to: string) => Promise<Bar[]>): Promise<Bar[]> {
  const s = ymd(start);
  let to = ymd(end);
  const byDate = new Map<string, Bar>();
  let last = "";
  for (let i = 0; i < 200 && to >= s; i++) {
    const bars = await page(s, to);
    if (!bars.length) break;
    for (const b of bars) byDate.set(b.date, b);
    const oldest = ymd(bars[0].date);
    if (oldest <= s || oldest === last) break; // 시작일 도달 또는 더 과거 데이터 없음
    last = oldest;
    to = prevDay(oldest);
  }
  return [...byDate.values()].filter((b) => b.date >= start && b.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}

/** 6자리 종목코드 일봉 (수정주가) */
export async function kisDaily(client: KisClient, code: string, start: string, end: string): Promise<Bar[]> {
  const bars = await paginate(start, end, async (from, to) => {
    const { body } = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      trId: "FHKST03010100",
      query: {
        FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: from, FID_INPUT_DATE_2: to,
        FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0", // 0: 수정주가
      },
    });
    return parseStockDaily(body.output2 as any[]);
  });
  if (!bars.length) throw new Error(`${code}: 데이터 없음`);
  return bars;
}

/** 업종 지수 일봉. 0001 = KOSPI 종합 */
export async function kisIndexDaily(client: KisClient, start: string, end: string, index = "0001"): Promise<Bar[]> {
  const bars = await paginate(start, end, async (from, to) => {
    const { body } = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",
      trId: "FHKUP03500100",
      query: {
        FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: index,
        FID_INPUT_DATE_1: from, FID_INPUT_DATE_2: to, FID_PERIOD_DIV_CODE: "D",
      },
    });
    return parseIndexDaily(body.output2 as any[]);
  });
  if (!bars.length) throw new Error("KOSPI 지수 데이터 없음");
  return bars;
}

export interface Quote { code: string; name?: string; price: number; change: number; changeRate: number; volume: number }

export async function kisQuote(client: KisClient, code: string): Promise<Quote> {
  const { body } = await client.call({
    method: "GET",
    path: "/uapi/domestic-stock/v1/quotations/inquire-price",
    trId: "FHKST01010100",
    query: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
  });
  const o = (body.output ?? {}) as Record<string, string>;
  return {
    code, name: o.hts_kor_isnm || undefined, price: num(o.stck_prpr),
    change: num(o.prdy_vrss), changeRate: num(o.prdy_ctrt), volume: num(o.acml_vol),
  };
}

/* ───────── 해외(미국) 주식 일봉, 환율, 해외 지수 ───────── */

/** 한국투자증권 거래소 코드 */
export type KisExchange = "NAS" | "NYS" | "AMS";
export const KIS_EXCHANGE: Record<string, KisExchange> = { NASDAQ: "NAS", NYSE: "NYS", AMEX: "AMS" };

/** BRK.B → BRK/B (한국투자증권 표기) */
export const kisUsSymbol = (t: string) => t.replace(/\./g, "/");

/** 해외주식 기간별시세 output2 → Bar[] (오름차순) */
export function parseOverseasDaily(rows: any[] | undefined): Bar[] {
  return (rows ?? [])
    .filter((r) => /^\d{8}$/.test(String(r?.xymd ?? "")))
    .map((r) => ({ date: iso(r.xymd), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.clos), volume: num(r.tvol) }))
    .filter((b) => b.close > 0 && b.open > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 미국 주식·ETF 일봉 (달러). 한 번에 100일씩, 기준일을 과거로 당기며 받는다.
 * adjusted=true(수정주가)는 액면분할뿐 아니라 배당까지 반영된 값이다 (2026-11-16 실서버 확인: AAPL 2010-01-04 종가 6.39,
 * 분할만 반영하면 7.64). 백테스트에는 kisUsSplitOnlyDaily(분할만 반영)를 쓴다.
 * 거래소를 모르면 exchanges 를 순서대로 시도한다
 */
export async function kisUsDaily(client: KisClient, ticker: string, start: string, end: string, exchanges: KisExchange[] = ["NAS", "NYS", "AMS"], adjusted = true): Promise<Bar[]> {
  let lastErr: Error | null = null;
  for (const excd of exchanges) {
    try {
      const bars = await paginate(start, end, async (_from, to) => {
        const { body } = await client.call({
          method: "GET",
          path: "/uapi/overseas-price/v1/quotations/dailyprice",
          trId: "HHDFS76240000",
          query: { AUTH: "", EXCD: excd, SYMB: kisUsSymbol(ticker), GUBN: "0", BYMD: to, MODP: adjusted ? "1" : "0" }, // GUBN 0: 일, MODP 1: 수정주가 0: 원래 가격
        });
        return parseOverseasDaily(body.output2 as any[]);
      });
      if (bars.length) return bars;
    } catch (e) { lastErr = e as Error; }
  }
  throw new Error(`${ticker}: 한국투자증권 해외 시세 없음${lastErr ? ` (${lastErr.message})` : ""}`);
}

export interface SplitEvent { date: string; ratio: number }

/** 2, 3, 1.5, 0.125 처럼 깔끔한 비율에 0.3% 안으로 가까우면 그 값으로 (분사 때문에 생긴 1.324 같은 비율은 그대로) */
function snapRatio(x: number): number {
  let best = x, err = 0.003;
  for (let den = 1; den <= 10; den++) {
    const num = Math.round(x * den);
    if (num < 1 || num > 100) continue;
    const e = Math.abs(num / den - x) / x;
    if (e < err) { err = e; best = num / den; }
  }
  return best;
}

/**
 * 원래 가격(raw)과 수정주가(adj)를 비교해 액면분할을 찾는다.
 * 하루 등락률이 두 쪽에서 20% 넘게 다르면 분할(배당은 보통 몇 % 이하라 걸리지 않음). ratio 4 = 1주가 4주로
 */
export function detectSplits(raw: Bar[], adj: Bar[]): SplitEvent[] {
  const a = new Map(adj.map((b) => [b.date, b.close]));
  const out: SplitEvent[] = [];
  let prev: { raw: number; adj: number } | null = null;
  for (const b of raw) {
    const ac = a.get(b.date);
    if (!(ac! > 0) || !(b.close > 0)) continue;
    if (prev) {
      const q = (b.close / prev.raw) / (ac! / prev.adj); // 분할이면 1/ratio
      if (q < 1 / 1.2 || q > 1.2) out.push({ date: b.date, ratio: snapRatio(1 / q) });
    }
    prev = { raw: b.close, adj: ac! };
  }
  return out;
}

/** 원래 가격에 액면분할만 반영 (그날 이후의 분할만큼 가격은 나누고 거래량은 곱함) */
export function applySplits(raw: Bar[], splits: SplitEvent[]): Bar[] {
  const sp = [...splits].sort((x, y) => x.date.localeCompare(y.date));
  let k = sp.length - 1, f = 1;
  const out: Bar[] = new Array(raw.length);
  for (let i = raw.length - 1; i >= 0; i--) {
    const b = raw[i];
    while (k >= 0 && sp[k].date > b.date) { f *= sp[k].ratio; k--; }
    const r = (x: number) => Math.round((x / f) * 1e6) / 1e6;
    out[i] = f === 1 ? b : { date: b.date, open: r(b.open), high: r(b.high), low: r(b.low), close: r(b.close), volume: Math.round(b.volume * f) };
  }
  return out;
}

/**
 * 미국 일봉, 액면분할만 반영하고 배당은 가격에 넣지 않음 (한국 종목·야후 시세와 같은 기준 → 배당은 현금으로 따로 계산).
 * 한국투자증권에는 분할 목록이 따로 없어 원래 가격과 수정주가를 둘 다 받아 비교해 분할을 찾는다
 */
export async function kisUsSplitOnlyDaily(client: KisClient, ticker: string, start: string, end: string, exchanges?: KisExchange[]): Promise<Bar[]> {
  const raw = await kisUsDaily(client, ticker, start, end, exchanges, false);
  let adj: Bar[];
  try { adj = await kisUsDaily(client, ticker, start, end, exchanges, true); }
  catch (e) { throw new Error(`${ticker}: 한국투자증권 수정주가를 못 받아 액면분할을 확인할 수 없습니다 (${(e as Error).message})`); }
  return applySplits(raw, detectSplits(raw, adj));
}

/** 해외 지수·환율 기간별시세 output2 → Bar[] (오름차순) */
export function parseOverseasChart(rows: any[] | undefined): Bar[] {
  return (rows ?? [])
    .filter((r) => /^\d{8}$/.test(String(r?.stck_bsop_date ?? "")))
    .map((r) => {
      const close = num(r.ovrs_nmix_prpr);
      const or = (v: unknown) => (num(v) > 0 ? num(v) : close);
      return { date: iso(r.stck_bsop_date), open: or(r.ovrs_nmix_oprc), high: or(r.ovrs_nmix_hgpr), low: or(r.ovrs_nmix_lwpr), close, volume: num(r.acml_vol) || 0 };
    })
    .filter((b) => b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function kisOverseasChart(client: KisClient, div: "N" | "X", code: string, start: string, end: string): Promise<Bar[]> {
  const bars = await paginate(start, end, async (from, to) => {
    const { body } = await client.call({
      method: "GET",
      path: "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice",
      trId: "FHKST03030100",
      query: { FID_COND_MRKT_DIV_CODE: div, FID_INPUT_ISCD: code, FID_INPUT_DATE_1: from, FID_INPUT_DATE_2: to, FID_PERIOD_DIV_CODE: "D" },
    });
    return parseOverseasChart(body.output2 as any[]);
  });
  if (!bars.length) throw new Error(`${code}: 한국투자증권 데이터 없음`);
  return bars;
}

/** 원/달러 환율 일별 */
export const kisUsdKrwDaily = (client: KisClient, start: string, end: string) => kisOverseasChart(client, "X", "FX@KRW", start, end);
/** S&P 500 지수 일별 */
export const kisSp500Daily = (client: KisClient, start: string, end: string) => kisOverseasChart(client, "N", "SPX", start, end);
