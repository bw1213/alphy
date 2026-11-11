/** 서버 측 데이터 로딩: 캐시 → 소스 순서 */
import { promises as fs } from "fs";
import path from "path";
import type { Bar, PriceData, StockInfo } from "../engine/types";
import { fetchDaily, fetchTopMarketCap } from "./naver";
import { syntheticData } from "./synthetic";
import { quoteCredentials } from "../kis/config";
import { getClient } from "../kis/client";
import { kisDaily, kisIndexDaily } from "../kis/market";

const ROOT = process.cwd();
const CACHE = path.join(ROOT, ".cache");
const CSV_DIR = path.join(ROOT, "data", "csv");
const today = () => new Date().toISOString().slice(0, 10);

export type Source = "naver" | "kis" | "csv" | "synthetic";

export interface DataRequest {
  source: Source;
  tickers?: string[];
  universeSize?: number;
  start: string; // 로드 시작 (워밍업 포함)
  end: string;
}

export interface DataResponse {
  data: PriceData;
  names: Record<string, string>;
  benchmark: { date: string; close: number }[] | null;
  warnings: string[];
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, "utf8")) as T; } catch { return null; }
}
async function writeJson(p: string, v: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v));
}

type DailyFetcher = (symbol: string, start: string) => Promise<Bar[]>;

interface DailyCache { fetched: string; from?: string; bars: Bar[] }

const minusDays = (iso: string, n: number) => new Date(Date.parse(iso) - n * 864e5).toISOString().slice(0, 10);

/** 겹치는 날짜의 종가가 같으면(수정주가가 안 바뀌었으면) 이어 붙여도 안전 */
export function sameHistory(oldBars: Bar[], fresh: Bar[]): boolean {
  const m = new Map(oldBars.map((b) => [b.date, b.close]));
  let seen = 0;
  for (const b of fresh) {
    const c = m.get(b.date);
    if (c === undefined) continue;
    seen++;
    if (Math.abs(c - b.close) > Math.max(1e-6, Math.abs(c) * 1e-4)) return false;
  }
  return seen > 0;
}

/**
 * 일봉 캐시.
 * - 캐시에 '요청했던 시작일(from)'을 같이 저장해서, 더 앞선 기간을 요청하면 처음부터 다시 받는다
 *   (캐시의 첫 날짜가 늦은 게 신규상장 때문인지, 짧게 받아서인지 구분하기 위함)
 * - 오늘 받은 캐시면 그대로, 예전 캐시면 마지막 날짜 근처부터만 받아 이어 붙인다.
 *   액면분할·배당 등으로 수정주가가 바뀌었으면(겹치는 날 종가가 다르면) 전체를 다시 받는다
 */
export async function cachedDaily(symbol: string, start: string, src: "naver" | "kis" = "naver", fetcher: DailyFetcher = fetchDaily, cacheDir = CACHE): Promise<Bar[]> {
  const p = path.join(cacheDir, src, `${symbol}.json`);
  const c = await readJson<DailyCache>(p);
  const covers = !!c && Array.isArray(c.bars) && c.bars.length > 0 && (c.from ?? c.bars[0].date) <= start;
  if (c && covers) {
    if (c.fetched === today()) return c.bars;
    try {
      const overlapFrom = minusDays(c.bars[c.bars.length - 1].date, 10);
      const fresh = await fetcher(symbol, overlapFrom);
      if (sameHistory(c.bars, fresh)) {
        const byDate = new Map(c.bars.map((b) => [b.date, b]));
        for (const b of fresh) byDate.set(b.date, b);
        const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
        await writeJson(p, { fetched: today(), from: c.from ?? c.bars[0].date, bars } satisfies DailyCache);
        return bars;
      }
    } catch { /* 이어 받기 실패 → 아래에서 전체 다시 */ }
  }
  const from = c?.from && c.from < start ? c.from : start;
  const bars = await fetcher(symbol, from);
  await writeJson(p, { fetched: today(), from, bars } satisfies DailyCache);
  return bars;
}

/** 한국투자증권 일봉 (오늘까지 받아 캐시, 요청 구간은 호출부에서 자름) */
function kisFetcher(): DailyFetcher {
  const cred = quoteCredentials();
  if (!cred) throw new Error("한국투자증권 앱키가 설정되지 않았습니다. 설정 화면(/settings)에서 실전 또는 모의투자 앱키·앱시크릿을 넣으세요.");
  const client = getClient(cred);
  const end = today();
  return (symbol, start) => symbol === "KOSPI" ? kisIndexDaily(client, start, end) : kisDaily(client, symbol, start, end);
}

async function cachedUniverse(n: number): Promise<StockInfo[]> {
  const p = path.join(CACHE, "universe", `${today()}.json`);
  const c = await readJson<StockInfo[]>(p);
  if (c && c.length >= n) return c.slice(0, n);
  const list = await fetchTopMarketCap(Math.max(n, 200));
  await writeJson(p, list);
  return list.slice(0, n);
}

async function pool<T, R>(items: T[], k: number, f: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await f(items[i]) }; }
      catch (e) { out[i] = { status: "rejected", reason: e }; }
    }
  }));
  return out;
}

function parseCsv(text: string): Bar[] {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].toLowerCase().split(",").map((s) => s.trim());
  const ix = (k: string) => head.indexOf(k);
  const [d, o, h, l, c, v] = ["date", "open", "high", "low", "close", "volume"].map(ix);
  if ([d, o, h, l, c].some((k) => k < 0)) throw new Error("CSV 헤더는 Date,Open,High,Low,Close,Volume 이어야 합니다");
  return lines.slice(1).map((ln) => {
    const x = ln.split(",");
    return { date: x[d].trim().slice(0, 10), open: +x[o], high: +x[h], low: +x[l], close: +x[c], volume: v >= 0 ? +x[v] : 1 };
  }).filter((b) => Number.isFinite(b.close)).sort((a, b) => a.date.localeCompare(b.date));
}

const clip = (bars: Bar[], s: string, e: string) => bars.filter((b) => b.date >= s && b.date <= e);

export async function loadData(req: DataRequest): Promise<DataResponse> {
  const warnings: string[] = [];
  if (req.source === "synthetic") {
    const n = req.tickers?.length || req.universeSize || 50;
    return { ...syntheticData(n, req.start, req.end), warnings: ["가상(랜덤) 데이터입니다. 코드 동작 확인용이며 수익률은 의미가 없습니다."] };
  }

  if (req.source === "csv") {
    const files = (await fs.readdir(CSV_DIR).catch(() => [])).filter((f) => f.endsWith(".csv"));
    const want = req.tickers?.length ? new Set(req.tickers) : null;
    const data: PriceData = {}, names: Record<string, string> = {};
    for (const f of files) {
      const code = f.replace(/\.csv$/, "");
      if (want && !want.has(code)) continue;
      if (code.toUpperCase() === "KOSPI") continue;
      data[code] = clip(parseCsv(await fs.readFile(path.join(CSV_DIR, f), "utf8")), req.start, req.end);
      names[code] = code;
    }
    let benchmark = null;
    try {
      benchmark = clip(parseCsv(await fs.readFile(path.join(CSV_DIR, "KOSPI.csv"), "utf8")), req.start, req.end)
        .map((b) => ({ date: b.date, close: b.close }));
    } catch { warnings.push("data/csv/KOSPI.csv 가 없어 지수 비교·시장 필터를 쓸 수 없습니다."); }
    if (!Object.keys(data).length) throw new Error("data/csv/ 폴더에 CSV 파일이 없습니다");
    return { data, names, benchmark, warnings };
  }

  // naver / kis (kis 는 시세만 한국투자증권, 시총 순위는 네이버)
  const isKis = req.source === "kis";
  const fetcher = isKis ? kisFetcher() : fetchDaily;
  const src = isKis ? "kis" : "naver";
  let list: StockInfo[];
  if (req.tickers?.length) list = req.tickers.map((code) => ({ code, name: code }));
  else {
    try {
      list = await cachedUniverse(req.universeSize ?? 100);
    } catch (e) {
      const cause = (e as any)?.cause?.code ?? (e as Error).message;
      throw new Error(`네이버 증권에서 시총 순위를 받지 못했습니다 (${cause}). 인터넷 연결이나 방화벽을 확인하세요.${isKis ? " 한국투자증권 시세만 쓰려면 '종목 직접 입력'으로 종목코드를 넣으세요." : " 오프라인이면 '내 CSV 파일' 데이터를 쓰세요."}`);
    }
    warnings.push("유니버스는 '현재' 시총 상위 종목입니다. 과거에 상장폐지된 종목이 빠져 있어 성과가 실제보다 좋게 나올 수 있습니다(생존편향).");
  }
  const results = await pool(list, 6, (s) => cachedDaily(s.code, req.start, src, fetcher));
  const data: PriceData = {}, names: Record<string, string> = {};
  results.forEach((r, k) => {
    const s = list[k];
    if (r.status === "fulfilled") { data[s.code] = clip(r.value, req.start, req.end); names[s.code] = s.name; }
    else warnings.push(`${s.code} 건너뜀: ${(r.reason as Error)?.message ?? r.reason}`);
  });
  if (!Object.keys(data).length) throw new Error(`가격 데이터를 하나도 받지 못했습니다. 네트워크 상태를 확인하세요. (${warnings[0] ?? ""})`);
  let benchmark = null;
  try {
    let idx: Bar[];
    try { idx = await cachedDaily("KOSPI", req.start, src, fetcher); }
    catch (e) {
      if (!isKis) throw e;
      warnings.push(`한국투자증권 KOSPI 지수 조회 실패(${(e as Error).message}), 네이버 지수로 대체했습니다.`);
      idx = await cachedDaily("KOSPI", req.start);
    }
    benchmark = clip(idx, req.start, req.end).map((b) => ({ date: b.date, close: b.close }));
  } catch (e) { warnings.push(`KOSPI 지수 조회 실패: ${(e as Error).message}`); }
  return { data, names, benchmark, warnings };
}
