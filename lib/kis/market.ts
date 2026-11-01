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
