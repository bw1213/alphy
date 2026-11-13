/**
 * KRX 정보데이터시스템(data.krx.co.kr) 조회 (서버 전용). 생존편향 없는 백테스트용.
 * - 전종목 시세(특정 날짜에 상장돼 있던 모든 종목과 시가총액): 지금은 상장폐지된 종목도 그 날짜 목록에는 들어 있다
 * - 개별종목 시세(수정주가): 표준코드(ISIN)로 조회하므로 상장폐지 종목도 받을 수 있다
 * 공개 API 가 아니라 웹 화면이 쓰는 주소라서 형식이 바뀌거나 로그인을 요구할 수 있다. 실패하면 호출부에서 안내한다.
 */
import type { Bar, UniverseSnapshot } from "../engine/types";

const URL_JSON = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Referer: "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020101",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
};

export interface KrxListing { code: string; isin: string; name: string; marketCap: number; close: number }

const num = (s: unknown) => Number(String(s ?? "").replace(/,/g, "")) || 0;
const ymd = (iso: string) => iso.replace(/-/g, "");

let lastCall = 0;
async function krxPost(form: Record<string, string>, f: typeof fetch = fetch): Promise<any> {
  const wait = lastCall + 400 - Date.now(); // 서버에 부담을 주지 않도록 간격을 둠
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await f(URL_JSON, { method: "POST", headers: HEADERS, body: new URLSearchParams(form).toString(), cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`KRX HTTP ${res.status}`);
  try { return JSON.parse(text); }
  catch { throw new Error(/login|로그인/i.test(text) ? "KRX 가 로그인을 요구합니다" : "KRX 응답 형식이 예상과 다릅니다"); }
}

/** 전종목 시세 응답 → 보통주만, 시총 큰 순 */
export function parseListings(j: any): KrxListing[] {
  const rows: any[] = j?.OutBlock_1 ?? j?.output ?? [];
  return rows
    .map((r) => ({
      code: String(r.ISU_SRT_CD ?? ""), isin: String(r.ISU_CD ?? ""), name: String(r.ISU_ABBRV ?? "").trim(),
      marketCap: num(r.MKTCAP), close: num(r.TDD_CLSPRC),
    }))
    .filter((r) => /^[0-9A-Z]{6}$/.test(r.code) && r.code.endsWith("0") && !/스팩|SPAC/i.test(r.name) && r.marketCap > 0)
    .sort((a, b) => b.marketCap - a.marketCap);
}

/** 개별종목 시세 응답 → Bar[] (오름차순) */
export function parseKrxDaily(j: any): Bar[] {
  const rows: any[] = j?.output ?? j?.OutBlock_1 ?? [];
  return rows
    .map((r) => ({
      date: String(r.TRD_DD ?? "").replace(/\//g, "-"),
      open: num(r.TDD_OPNPRC), high: num(r.TDD_HGPRC), low: num(r.TDD_LWPRC), close: num(r.TDD_CLSPRC), volume: num(r.ACC_TRDVOL),
    }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.close > 0)
    // 거래정지일은 시가·고가·저가가 0 으로 온다 → 종가로 채우고 거래량 0 이라 엔진이 매매하지 않음
    .map((b) => ({ ...b, open: b.open || b.close, high: b.high || b.close, low: b.low || b.close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 그 날짜의 KOSPI 전종목 (휴장일이면 빈 배열) */
export async function krxListings(date: string, f: typeof fetch = fetch): Promise<KrxListing[]> {
  return parseListings(await krxPost({
    bld: "dbms/MDC/STAT/standard/MDCSTAT01501", locale: "ko_KR", mktId: "STK", trdDd: ymd(date), share: "1", money: "1", csvxls_isNo: "false",
  }, f));
}

/** 수정주가 일봉. isin 은 krxListings 의 표준코드 */
export async function krxDaily(isin: string, start: string, end: string, f: typeof fetch = fetch): Promise<Bar[]> {
  return parseKrxDaily(await krxPost({
    bld: "dbms/MDC/STAT/standard/MDCSTAT01701", locale: "ko_KR", isuCd: isin, strtDd: ymd(start), endDd: ymd(end),
    adjStkPrc: "2", adjStkPrc_check: "Y", share: "1", money: "1", csvxls_isNo: "false",
  }, f));
}

/** start~end 사이 분기 말 날짜들 + 시작 직전 분기 말 (시작 시점의 목록용) */
export function snapshotDates(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00Z");
  let y = s.getUTCFullYear(), q = Math.floor(s.getUTCMonth() / 3); // 시작일이 속한 분기의 직전 분기 말부터
  for (;;) {
    const d = new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10); // q*3 월의 0일 = 직전 분기 마지막 날
    if (d > end) break;
    out.push(d);
    if (++q > 3) { q = 0; y++; }
  }
  return out;
}

export interface PitUniverse {
  snapshots: UniverseSnapshot[];
  /** 한 번이라도 목록에 든 종목 */
  listings: Map<string, { isin: string; name: string }>;
}

/**
 * 분기마다 그 시점의 시총 상위 n 종목 목록을 만든다.
 * getListings 는 캐시를 끼운 조회 함수(휴장일이면 빈 배열 → 하루씩 앞으로 가며 최대 7일 재시도).
 */
export async function buildPitUniverse(start: string, end: string, n: number,
  getListings: (date: string) => Promise<KrxListing[]>): Promise<PitUniverse> {
  const snapshots: UniverseSnapshot[] = [];
  const listings = new Map<string, { isin: string; name: string }>();
  for (const target of snapshotDates(start, end)) {
    let rows: KrxListing[] = [];
    let d = target;
    for (let back = 0; back < 7 && !rows.length; back++) {
      rows = await getListings(d);
      if (!rows.length) d = new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
    }
    if (!rows.length) continue;
    const top = rows.slice(0, n);
    for (const r of top) listings.set(r.code, { isin: r.isin, name: r.name }); // 나중 목록의 이름으로 덮어씀
    snapshots.push({ date: d, tickers: top.map((r) => r.code) });
  }
  if (!snapshots.length) throw new Error("KRX 에서 과거 종목 목록을 하나도 받지 못했습니다");
  return { snapshots, listings };
}
