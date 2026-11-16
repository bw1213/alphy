/**
 * 한국투자증권 예탁원정보(배당일정) [국내주식-145]: 국내 주식·ETF 의 배당 기준일·1주당 현금배당금·지급일.
 * GET /uapi/domestic-stock/v1/ksdinfo/dividend, tr_id HHKDB669102C0. 실전 키로만 될 수 있음(모의 미지원 가능).
 *
 * 백테스트 엔진은 "배당락일 + 시세와 같은 수정 기준의 1주당 금액"을 쓰므로 여기서 두 가지를 바꾼다.
 *  1) 기준일 → 배당락일: 한국은 결제가 T+2 라서 기준일에 주주이려면 2거래일 전까지 사야 한다.
 *     → 배당락일 = "그날 사면 결제일(2거래일 뒤)이 기준일을 넘는" 첫 거래일 = (기준일보다 뒤인 첫 거래일) 에서 2거래일 앞.
 *  2) 원래 금액 → 수정 금액: 예탁원 금액은 그때의 1주 기준이라 이후 액면분할·무상증자가 있으면 수정주가와 안 맞는다.
 *     그 달의 수정 종가 ÷ 원래(원주가) 종가 비율을 곱해 맞춘다 (원주가 월봉은 한국투자증권에서 받음).
 */
import type { Bar, Dividend } from "../engine/types";
import type { KisClient } from "./client";
import { prevDay } from "./market";

const DIV_PATH = "/uapi/domestic-stock/v1/ksdinfo/dividend";
const DIV_TR = "HHKDB669102C0";
const num = (s: unknown) => Number(String(s ?? "").replace(/,/g, ""));
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

export interface KisDividendRow {
  /** 배당 기준일 YYYY-MM-DD */
  recordDate: string;
  /** 1주당 현금배당금 (그때 1주 기준, 원) */
  amount: number;
  /** 배당 종류 (결산·중간·분기 등, 증권사 표기 그대로) */
  kind: string;
  /** 지급일 YYYY-MM-DD (없으면 "") */
  payDate: string;
}

/** output1 → 현금배당이 있는 줄만, 같은 기준일은 합침, 날짜 오름차순 */
export function parseKisDividends(rows: any[] | undefined, code?: string): KisDividendRow[] {
  const by = new Map<string, KisDividendRow>();
  for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) {
    const rd = String(r?.record_date ?? "").replace(/\D/g, "");
    const amt = num(r?.per_sto_divi_amt);
    if (!/^\d{8}$/.test(rd) || !(amt > 0)) continue;
    if (code && r?.sht_cd && String(r.sht_cd).trim().toUpperCase().replace(/^A/, "") !== code) continue;
    const pd = String(r?.divi_pay_dt ?? "").replace(/\D/g, "");
    const key = iso(rd);
    const cur = by.get(key);
    if (cur && cur.amount === amt) continue; // 같은 줄이 두 번 (페이지 겹침)
    by.set(key, { recordDate: key, amount: (cur?.amount ?? 0) + amt, kind: String(r?.divi_kind ?? "").trim(), payDate: /^\d{8}$/.test(pd) ? iso(pd) : "" });
  }
  return [...by.values()].sort((a, b) => a.recordDate.localeCompare(b.recordDate));
}

/** 한 종목의 배당 일정 (from~to, YYYY-MM-DD). 다음 페이지가 있으면(tr_cont M/F) 이어 받는다 */
export async function kisDividendRows(client: KisClient, code: string, from: string, to: string): Promise<KisDividendRow[]> {
  const all: any[] = [];
  let cts = "", trCont = "";
  for (let page = 0; page < 30; page++) {
    const res = await client.call({
      method: "GET", path: DIV_PATH, trId: DIV_TR, trCont,
      query: { CTS: cts, GB1: "0", F_DT: from.replace(/-/g, ""), T_DT: to.replace(/-/g, ""), SHT_CD: code, HIGH_GB: "" },
    });
    const out = (res.body as any).output1;
    all.push(...(Array.isArray(out) ? out : out ? [out] : []));
    const next = String((res.body as any).ctx_area_nk ?? (res.body as any).CTS ?? (res.body as any).cts ?? "").trim();
    if (!(res.trCont === "M" || res.trCont === "F") || !next) break;
    cts = next; trCont = "N";
  }
  return parseKisDividends(all, code);
}

/** 원주가(수정 안 한) 월봉: 월(YYYY-MM) → 그 달 종가. 한 번에 100개월씩 */
export async function kisRawMonthly(client: KisClient, code: string, from: string, to: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let end = to.replace(/-/g, "");
  const start = from.replace(/-/g, "");
  let last = "";
  for (let i = 0; i < 20 && end >= start; i++) {
    const { body } = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      trId: "FHKST03010100",
      query: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: start, FID_INPUT_DATE_2: end, FID_PERIOD_DIV_CODE: "M", FID_ORG_ADJ_PRC: "1" },
    });
    const rows = ((body.output2 as any[]) ?? []).filter((r) => /^\d{8}$/.test(String(r?.stck_bsop_date ?? "")) && num(r.stck_clpr) > 0);
    if (!rows.length) break;
    for (const r of rows) out[iso(r.stck_bsop_date).slice(0, 7)] = num(r.stck_clpr);
    const oldest = rows.map((r) => String(r.stck_bsop_date)).sort()[0];
    if (oldest <= start || oldest === last) break;
    last = oldest;
    end = prevDay(oldest.slice(0, 6) + "01");
  }
  return out;
}

/**
 * 배당락일: 그날 사면 결제일(2거래일 뒤)이 기준일보다 늦어지는 첫 거래일.
 * dates 는 오름차순 거래일. 기준일 뒤 거래일이 데이터에 없으면(아직 안 옴) null.
 */
export function exDateFromRecord(record: string, dates: string[], settleDays = 2): string | null {
  let lo = 0, hi = dates.length; // 기준일보다 뒤인 첫 거래일
  while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] <= record) lo = m + 1; else hi = m; }
  if (lo >= dates.length) return null;
  // 기준일 근처 시세가 없으면(거래정지·데이터 구멍) 엉뚱한 날이 되므로 버림
  if (Date.parse(dates[lo]) - Date.parse(record) > 15 * 864e5) return null;
  const k = lo - settleDays;
  return k >= 0 ? dates[k] : null;
}

/**
 * 예탁원 배당 → 엔진용 배당 (배당락일, 수정 금액).
 * bars: 시세(수정주가), rawMonthly: 원주가 월 종가. 원주가가 없는 달은 수정 비율을 알 수 없어 뺀다(→ 그 건은 Yahoo 로 채움).
 */
export function toEngineDividends(rows: KisDividendRow[], bars: Bar[], rawMonthly: Record<string, number>): { divs: Dividend[]; skipped: number } {
  const dates = bars.map((b) => b.date);
  const adjMonth = new Map<string, number>();
  for (const b of bars) adjMonth.set(b.date.slice(0, 7), b.close); // 마지막 거래일 종가가 남음
  const divs: Dividend[] = [];
  let skipped = 0;
  for (const r of rows) {
    const ex = exDateFromRecord(r.recordDate, dates);
    if (!ex) continue; // 데이터 밖
    const m = r.recordDate.slice(0, 7);
    const raw = rawMonthly[m], adj = adjMonth.get(m);
    if (!(raw > 0) || !(adj! > 0)) { skipped++; continue; }
    let f = adj! / raw;
    if (Math.abs(f - 1) < 0.03) f = 1; // 반올림 차이
    divs.push({ date: ex, amount: r.amount * f });
  }
  return { divs, skipped };
}

/**
 * 한국투자증권 배당을 기본으로, 그보다 앞선 기간(한국투자증권 기록이 시작되기 전)만 Yahoo 로 채운다.
 * kis 가 비어 있으면 yahoo 그대로.
 */
export function mergeDividends(kis: Dividend[], yahoo: Dividend[]): { divs: Dividend[]; fromYahoo: number } {
  if (!kis.length) return { divs: yahoo, fromYahoo: yahoo.length };
  const first = Date.parse(kis[0].date) - 20 * 864e5; // 날짜 표기 차이(기준일/배당락일) 여유
  const before = yahoo.filter((d) => Date.parse(d.date) < first);
  return { divs: [...before, ...kis].sort((a, b) => a.date.localeCompare(b.date)), fromYahoo: before.length };
}

// ---------------------------------------------------------------------------
// 미국 주식: 해외주식 기간별권리조회 (CTRGT011R). 권리유형 03 배당, 75 특별배당. 금액은 1주당 달러(그때 1주 기준)
// ---------------------------------------------------------------------------

const US_PRDT: Record<string, string> = { NASDAQ: "512", NYSE: "513", AMEX: "529" };
/** 미국 결제일: 2024-05-28 부터 T+1, 그 전 T+2 */
export const usSettleDays = (record: string) => (record >= "2024-05-28" ? 1 : 2);

/** output → 현금배당 줄만 (기준일 합침) */
export function parseKisUsRights(rows: any[] | undefined, symbol?: string): KisDividendRow[] {
  const by = new Map<string, KisDividendRow>();
  for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) {
    const type = String(r?.rght_type_cd ?? "").trim();
    if (type !== "03" && type !== "75") continue;
    if (symbol && r?.pdno && String(r.pdno).trim().toUpperCase() !== symbol.toUpperCase()) continue;
    const rd = String(r?.acpl_bass_dt || r?.bass_dt || "").replace(/\D/g, "");
    const amt = num(r?.alct_frcr_unpr);
    if (!/^\d{8}$/.test(rd) || !(amt > 0)) continue;
    const key = iso(rd) + ":" + type;
    if (by.has(key)) continue; // 같은 권리가 두 번 (확정 전/후 등)
    by.set(key, { recordDate: iso(rd), amount: amt, kind: type === "75" ? "특별배당" : "배당", payDate: "" });
  }
  // 같은 기준일의 정기+특별은 합침
  const merged = new Map<string, KisDividendRow>();
  for (const r of by.values()) {
    const cur = merged.get(r.recordDate);
    merged.set(r.recordDate, cur ? { ...cur, amount: cur.amount + r.amount, kind: `${cur.kind}+${r.kind}` } : r);
  }
  return [...merged.values()].sort((a, b) => a.recordDate.localeCompare(b.recordDate));
}

export async function kisUsDividendRows(client: KisClient, symbol: string, market: string, from: string, to: string): Promise<KisDividendRow[]> {
  const prdt = US_PRDT[market] ?? "512";
  const all: any[] = [];
  let nk = "", fk = "", trCont = "";
  for (let page = 0; page < 30; page++) {
    const res = await client.call({
      method: "GET", path: "/uapi/overseas-price/v1/quotations/period-rights", trId: "CTRGT011R", trCont,
      query: {
        RGHT_TYPE_CD: "%%", INQR_DVSN_CD: "02", INQR_STRT_DT: from.replace(/-/g, ""), INQR_END_DT: to.replace(/-/g, ""),
        PDNO: symbol, PRDT_TYPE_CD: prdt, CTX_AREA_NK50: nk, CTX_AREA_FK50: fk,
      },
    });
    const b = res.body as any;
    const out = b.output ?? b.output1;
    all.push(...(Array.isArray(out) ? out : out ? [out] : []));
    const nextNk = String(b.ctx_area_nk50 ?? "").trim();
    if (!(res.trCont === "M" || res.trCont === "F") || !nextNk) break;
    nk = nextNk; fk = String(b.ctx_area_fk50 ?? "").trim(); trCont = "N";
  }
  return parseKisUsRights(all, symbol);
}

/**
 * 미국 배당 → 엔진용 (배당락일, 달러 수정 금액). 원화 환산은 호출부에서.
 * splits: 액면분할 [{date, ratio}] (ratio 4 = 1주가 4주로). 그 뒤에 있었던 분할만큼 1주당 금액을 나눈다(시세가 분할 반영 가격이라서).
 */
export function toEngineUsDividends(rows: KisDividendRow[], dates: string[], splits: { date: string; ratio: number }[]): Dividend[] {
  const out: Dividend[] = [];
  for (const r of rows) {
    const ex = exDateFromRecord(r.recordDate, dates, usSettleDays(r.recordDate));
    if (!ex) continue;
    let f = 1;
    for (const sp of splits) if (sp.date > ex && sp.ratio > 0) f /= sp.ratio;
    out.push({ date: ex, amount: r.amount * f });
  }
  return out;
}
