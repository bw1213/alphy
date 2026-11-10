/**
 * 네이버 증권 시세 (서버 전용). 브라우저에서 직접 호출하면 CORS 로 막히므로 API 라우트에서 사용.
 * - 일봉: fchart.stock.naver.com (수정주가)
 * - 시총 순위: m.stock.naver.com API, 실패 시 finance.naver.com 시가총액 페이지 파싱
 */
import iconv from "iconv-lite";
import type { Bar, StockInfo } from "../engine/types";

const UA = { "User-Agent": "Mozilla/5.0 (kospi-backtest)" };

export function parseFchart(xml: string): Bar[] {
  const out: Bar[] = [];
  const re = /data="(\d{8})\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, d, o, h, l, c, v] = m;
    out.push({
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      open: +o, high: +h, low: +l, close: +c, volume: +v,
    });
  }
  return out;
}

/** symbol: 6자리 종목코드 또는 "KOSPI" */
export async function fetchDaily(symbol: string, start: string): Promise<Bar[]> {
  const days = Math.ceil((Date.now() - Date.parse(start)) / 864e5);
  const count = Math.max(30, Math.ceil(days * 0.72) + 30);
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(symbol)}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetch(url, { headers: UA, cache: "no-store" });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const bars = parseFchart(await res.text());
  if (!bars.length) throw new Error(`${symbol}: 데이터 없음`);
  return bars;
}

const isCommon = (s: StockInfo) => s.code.endsWith("0") && !/스팩|SPAC/i.test(s.name);

export async function fetchTopMarketCap(n: number): Promise<StockInfo[]> {
  try {
    const out: StockInfo[] = [];
    for (let page = 1; out.length < n && page <= 20; page++) {
      const res = await fetch(`https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=${page}&pageSize=100`,
        { headers: UA, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const rows: any[] = j.stocks ?? j.result?.stocks ?? [];
      if (!rows.length) break;
      for (const r of rows) {
        const s: StockInfo = { code: String(r.itemCode ?? r.code), name: String(r.stockName ?? r.name ?? ""),
          marketCap: Number(String(r.marketValueRaw ?? r.marketValue ?? "").replace(/,/g, "")) || undefined };
        if (/^[0-9A-Z]{6}$/.test(s.code) && isCommon(s)) out.push(s);
      }
    }
    if (out.length) return out.slice(0, n);
  } catch { /* fallback below */ }
  return fetchTopMarketCapHtml(n);
}

export function parseMarketSumHtml(html: string): StockInfo[] {
  const out: StockInfo[] = [];
  const re = /\/item\/main\.naver\?code=([0-9A-Z]{6})"[^>]*class="tltle"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ code: m[1], name: m[2].trim() });
  return out;
}

async function fetchTopMarketCapHtml(n: number): Promise<StockInfo[]> {
  const out: StockInfo[] = [];
  for (let page = 1; out.length < n && page <= 40; page++) {
    const res = await fetch(`https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=${page}`,
      { headers: UA, cache: "no-store" });
    if (!res.ok) throw new Error(`시총 순위 조회 실패: HTTP ${res.status}`);
    const html = iconv.decode(Buffer.from(await res.arrayBuffer()), "euc-kr");
    const rows = parseMarketSumHtml(html);
    if (!rows.length) break;
    out.push(...rows.filter(isCommon));
  }
  if (!out.length) throw new Error("시총 순위를 가져오지 못했습니다");
  return out.slice(0, n);
}
