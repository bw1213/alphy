/**
 * 배당금(주식)·분배금(ETF) 이력 (서버 전용).
 *
 * 출처: Yahoo Finance chart API (events=div).
 *  - 한국 종목은 "코드.KS"(코스피), 없으면 "코드.KQ"(코스닥). 6자리 코드가 아니면(미국 티커 등) 그대로 조회.
 *  - 날짜는 배당락일(이날 시가에 산 사람은 못 받음), 금액은 1주(1좌)당 세전 금액이며 액면분할이 반영돼 있다.
 *    네이버·한국투자증권의 수정주가도 분할만 반영하고 현금배당은 반영하지 않으므로 그대로 더해도 이중 계산이 아니다.
 *  - 한국 종목은 2006년 무렵부터, ETF 는 상장 초부터 나온다. 일부 종목(특히 월배당 ETF)은 중간 기록이 빠져 있을 수 있다.
 */
import type { Dividend, DividendData } from "../engine/types";
export { dividendIndex } from "../engine/dividends";

const UA = { "User-Agent": "Mozilla/5.0" };
const HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];

/** 조회할 Yahoo 심볼 후보 (앞에서부터 시도) */
export function yahooSymbols(code: string): string[] {
  const c = code.trim().toUpperCase();
  if (/^[0-9][0-9A-Z]{5}$/.test(c)) return [`${c}.KS`, `${c}.KQ`];
  return [c.replace(/\./g, "-")]; // BRK.B → BRK-B (Yahoo 표기)
}

/** chart API 응답 → 배당 목록 (날짜 오름차순, 거래소 현지 날짜). 종목이 없으면 null */
export function parseYahooDividends(json: any): Dividend[] | null {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const off = Number(r.meta?.gmtoffset) || 0;
  const ev = r.events?.dividends ?? {};
  const byDate = new Map<string, number>();
  for (const x of Object.values<any>(ev)) {
    const ts = Number(x?.date), amt = Number(x?.amount);
    if (!Number.isFinite(ts) || !(amt > 0)) continue;
    const d = new Date((ts + off) * 1000).toISOString().slice(0, 10);
    byDate.set(d, (byDate.get(d) ?? 0) + amt);
  }
  return [...byDate.entries()].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date));
}

async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { headers: UA, cache: "no-store" });
  let json: any = null;
  try { json = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, json };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 한 종목의 전체 배당 이력. 배당이 한 번도 없으면 [] */
export async function fetchDividends(code: string): Promise<Dividend[]> {
  let lastErr = "데이터 없음";
  for (const sym of yahooSymbols(code)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = HOSTS[attempt % HOSTS.length];
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?period1=0&period2=9999999999&interval=3mo&events=div`;
      const { status, json } = await getJson(url);
      if (status === 429 || status >= 500) { lastErr = `HTTP ${status}`; await wait(800 * (attempt + 1)); continue; }
      const divs = status === 200 ? parseYahooDividends(json) : null;
      if (divs) return divs;
      lastErr = status === 404 ? "종목 없음" : `HTTP ${status}`;
      break; // 이 심볼엔 없음 → 다음 후보(.KQ)
    }
  }
  throw new Error(`${code}: 배당 이력 조회 실패 (${lastErr})`);
}

/**
 * 기록이 빠졌을 수 있는 구간: 평소 간격(중앙값)의 2.5배 넘게, 그리고 400일 넘게(연 1회 배당이 한 해 거른 정도는 빼고) 배당이 없던 구간.
 * 기간 [from, to] 안에 걸치는 것만.
 */
export function dividendGaps(divs: Dividend[], from: string, to: string): { from: string; to: string }[] {
  if (divs.length < 4) return [];
  const t = divs.map((d) => Date.parse(d.date));
  const gaps = t.slice(1).map((x, k) => x - t[k]).sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  const out: { from: string; to: string }[] = [];
  for (let k = 1; k < divs.length; k++) {
    const g = t[k] - t[k - 1];
    if (g > med * 2.5 && g > 400 * 864e5 && divs[k].date >= from && divs[k - 1].date <= to) out.push({ from: divs[k - 1].date, to: divs[k].date });
  }
  return out;
}

/** data/csv/dividends.csv: date,code,amount (date = 배당락일, amount = 1주당 세전 금액) */
export function parseDividendCsv(text: string): DividendData {
  const out: DividendData = {};
  for (const ln of text.trim().split(/\r?\n/)) {
    const [d, code, amt] = ln.split(",").map((x) => x.trim());
    const a = Number(amt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? "") || !code || !(a > 0)) continue; // 헤더·빈 줄
    (out[code] ??= []).push({ date: d, amount: a });
  }
  for (const k in out) out[k].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
