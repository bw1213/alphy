/** 서버 측 데이터 로딩: 캐시 → 소스 순서 */
import { promises as fs } from "fs";
import path from "path";
import type { Bar, Dividend, DividendData, PriceData, StockInfo, UniverseSnapshot } from "../engine/types";
import { dividendGaps, fetchDividends, fetchSplits, parseDividendCsv } from "./dividends";
import { buildPitUniverse, krxDaily, krxListings, type KrxListing } from "./krx";
import { fetchDaily, fetchTopMarketCap } from "./naver";
import { syntheticData } from "./synthetic";
import { isKrTicker, isUsTicker } from "./market";
import { fetchUsMaster, type UsStock } from "./usMaster";
import { fetchYahooDaily, SP500, toKrw, USDKRW } from "./yahoo";
import { credentialsFor, quoteCredentials, type KisCredentials } from "../kis/config";
import { kisDividendRows, kisRawMonthly, kisUsDividendRows, mergeDividends, toEngineDividends, toEngineUsDividends, type KisDividendRow } from "../kis/dividends";
import { getClient } from "../kis/client";
import { KIS_EXCHANGE, kisDaily, kisIndexDaily, kisSp500Daily, kisUsDaily, kisUsdKrwDaily, type KisExchange } from "../kis/market";

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
  /** 시점별 시총 상위 목록 사용 (생존편향 제거). naver/kis 의 '시총 상위 N' 에서만 */
  pit?: boolean;
  /** 배당금·분배금 이력도 받기 (기본 true) */
  dividends?: boolean;
}

export interface DataResponse {
  data: PriceData;
  names: Record<string, string>;
  benchmark: { date: string; close: number }[] | null;
  warnings: string[];
  /** 시점별 종목 목록 (pit 또는 CSV 의 universe.csv) */
  universe?: UniverseSnapshot[];
  /** 비교 지수 이름. 기본 KOSPI, 미국 종목만 넣으면 S&P 500 (원화 환산) */
  benchmarkName?: string;
  /** 배당금·분배금 이력 (1주당 원화, 배당락일). 못 받은 종목은 빠짐 */
  dividends?: DividendData;
  /** 원/달러 환율 (미국 종목이 있을 때) */
  fx?: { date: string; close: number }[];
  /** 시세에 배당이 이미 반영된 종목 (한국투자증권 미국 수정주가). 배당을 현금으로 또 넣으면 두 번 세는 것이라 배당 이력에서 뺀다 */
  dividendAdjusted?: string[];
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, "utf8")) as T; } catch { return null; }
}
async function writeJson(p: string, v: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v));
}

type DailyFetcher = (symbol: string, start: string) => Promise<Bar[]>;

interface DailyCache { fetched: string; from?: string; bars: Bar[]; /** 받은 시각(ms) */ fetchedAt?: number }

/**
 * 오늘 받은 캐시라도 장 마감(한국 시간 15:40) 전에 받은 것이면, 마감 뒤에는 한 번 더 받는다.
 * 낮에 백테스트를 돌려 캐시가 생겼어도 저녁 자동 계산이 오늘 종가를 쓰게 하려는 것.
 */
export function needsAfterCloseRefresh(fetchedAt: number | undefined, now = Date.now()): boolean {
  const kstDay = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const close = Date.parse(`${kstDay}T15:40:00+09:00`);
  return now >= close && (fetchedAt ?? 0) < close;
}

const plusDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
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
export async function cachedDaily(symbol: string, start: string, src: "naver" | "kis" | "krx" | "yahoo" = "naver", fetcher: DailyFetcher = fetchDaily, cacheDir = CACHE): Promise<Bar[]> {
  const p = path.join(cacheDir, src, `${symbol}.json`);
  const c = await readJson<DailyCache>(p);
  const covers = !!c && Array.isArray(c.bars) && c.bars.length > 0 && (c.from ?? c.bars[0].date) <= start;
  if (c && covers) {
    if (c.fetched === today() && !needsAfterCloseRefresh(c.fetchedAt)) return c.bars;
    try {
      const overlapFrom = minusDays(c.bars[c.bars.length - 1].date, 10);
      const fresh = await fetcher(symbol, overlapFrom);
      if (sameHistory(c.bars, fresh)) {
        const byDate = new Map(c.bars.map((b) => [b.date, b]));
        for (const b of fresh) byDate.set(b.date, b);
        const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
        await writeJson(p, { fetched: today(), fetchedAt: Date.now(), from: c.from ?? c.bars[0].date, bars } satisfies DailyCache);
        return bars;
      }
    } catch { /* 이어 받기 실패 → 아래에서 전체 다시 */ }
  }
  const from = c?.from && c.from < start ? c.from : start;
  const bars = await fetcher(symbol, from);
  await writeJson(p, { fetched: today(), fetchedAt: Date.now(), from, bars } satisfies DailyCache);
  return bars;
}

/** 한국투자증권 일봉 (오늘까지 받아 캐시, 요청 구간은 호출부에서 자름) */
function kisFetcher(given?: KisCredentials | null): DailyFetcher {
  const cred = given === undefined ? quoteCredentials() : given;
  if (!cred) throw new Error("한국투자증권 앱키가 설정되지 않았습니다. 설정 화면(/settings)에서 실전 또는 모의투자 앱키·앱시크릿을 넣으세요.");
  const client = getClient(cred);
  const end = today();
  return (symbol, start) => symbol === "KOSPI" ? kisIndexDaily(client, start, end) : kisDaily(client, symbol, start, end);
}

/** KRX 전종목 시세. 지난 날짜의 목록은 바뀌지 않으므로 계속 캐시 (휴장일의 빈 결과는 저장하지 않음) */
async function cachedListings(date: string): Promise<KrxListing[]> {
  const p = path.join(CACHE, "krx", "listings", `${date}.json`);
  const c = await readJson<KrxListing[]>(p);
  if (c && c.length) return c;
  const rows = await krxListings(date);
  if (rows.length) await writeJson(p, rows);
  return rows;
}

/** data/csv/universe.csv: date,code[,name] → 날짜별 종목 목록 */
export function parseUniverseCsv(text: string): { snapshots: UniverseSnapshot[]; names: Record<string, string> } {
  const by = new Map<string, string[]>();
  const names: Record<string, string> = {};
  for (const ln of text.trim().split(/\r?\n/)) {
    const [d, code, name] = ln.split(",").map((x) => x.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? "") || !/^[0-9A-Z]{6}$/.test(code ?? "")) continue; // 헤더·빈 줄
    if (!by.has(d)) by.set(d, []);
    by.get(d)!.push(code);
    if (name) names[code] = name;
  }
  return { snapshots: [...by.entries()].map(([date, tickers]) => ({ date, tickers })).sort((a, b) => a.date.localeCompare(b.date)), names };
}

async function cachedUniverse(n: number): Promise<StockInfo[]> {
  const p = path.join(CACHE, "universe", `${today()}.json`);
  const c = await readJson<StockInfo[]>(p);
  if (c && c.length >= n) return c.slice(0, n);
  const list = await fetchTopMarketCap(Math.max(n, 200));
  await writeJson(p, list);
  return list.slice(0, n);
}

/** 미국 종목 이름 (한국투자증권 해외 종목 마스터, 7일마다 새로 받음). 못 받으면 빈 목록 */
export async function cachedUsMaster(): Promise<UsStock[]> {
  const p = path.join(CACHE, "us-master.json");
  const c = await readJson<{ fetched: string; list: UsStock[] }>(p);
  if (c?.list?.length && Date.parse(today()) - Date.parse(c.fetched) < 7 * 864e5) return c.list;
  try {
    const list = await fetchUsMaster();
    if (list.length) await writeJson(p, { fetched: today(), list });
    return list;
  } catch { return c?.list ?? []; }
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

/** kisCred: 한국투자증권 시세에 쓸 키 (안 주면 owner 것). 로그인한 사람의 키를 넘김 */
export interface LoadOptions {
  kisCred?: KisCredentials | null;
  /** 종목 시세를 하나 받을 때마다 (받은 수, 전체 수) */
  onProgress?: (done: number, total: number) => void;
  /** 한국 종목 배당 일정(예탁원)에 쓸 한국투자증권 키 (안 주면 owner 의 실전 키). null = 쓰지 않음(Yahoo 만) */
  kisDividendCred?: KisCredentials | null;
}

export async function loadData(req: DataRequest, opts: LoadOptions = {}): Promise<DataResponse> {
  const out = await loadPrices(req, opts);
  if (req.dividends === false || req.source === "synthetic") return out;
  try {
    out.dividends = req.source === "csv" ? await csvDividends(Object.keys(out.data)) : await onlineDividends(Object.keys(out.data), req, out, opts);
  } catch (e) { out.warnings.push(`배당금·분배금 이력을 받지 못해 배당 없이 계산합니다: ${(e as Error).message}`); }
  return out;
}

const isKrCode = isKrTicker;

/** 그 날짜(또는 직전)의 환율 */
function fxOn(fx: { date: string; close: number }[], date: string): number | null {
  let lo = 0, hi = fx.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fx[m].date <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? fx[ans].close : fx.length ? fx[0].close : null;
}

interface DividendCache { fetched: string; divs: { date: string; amount: number }[] }

/** 배당 이력 캐시: 하루 한 번만 새로 받음. 실패하면 예전 캐시라도 씀 */
export async function cachedDividends(code: string, fetcher = fetchDividends, cacheDir = CACHE) {
  const p = path.join(cacheDir, "dividends", `${code}.json`);
  const c = await readJson<DividendCache>(p);
  if (c && c.fetched === today() && Array.isArray(c.divs)) return c.divs;
  try {
    const divs = await fetcher(code);
    await writeJson(p, { fetched: today(), divs } satisfies DividendCache);
    return divs;
  } catch (e) {
    if (c && Array.isArray(c.divs)) return c.divs;
    throw e;
  }
}

interface KisDividendCache { fetched: string; rows: KisDividendRow[]; raw?: Record<string, number>; splits?: { date: string; ratio: number }[] }
/** 한국투자증권 배당 일정은 이 날짜부터 받음 (캐시 키를 하나로 두려고 고정) */
const KIS_DIV_FROM = "2000-01-01";

/** 한국투자증권 배당 일정(+ 수정 금액 계산용 원주가 월봉·액면분할) 캐시: 하루 한 번만. 실패하면 예전 캐시라도 씀 */
export async function cachedKisDividends(code: string, fetcher: (code: string) => Promise<Omit<KisDividendCache, "fetched">>, cacheDir = CACHE) {
  const p = path.join(cacheDir, "dividends-kis", `${code.replace(/[^0-9A-Z.-]/gi, "_")}.json`);
  const c = await readJson<KisDividendCache>(p);
  if (c && c.fetched === today() && Array.isArray(c.rows)) return c;
  try {
    const fresh: KisDividendCache = { fetched: today(), ...(await fetcher(code)) };
    await writeJson(p, fresh);
    return fresh;
  } catch (e) {
    if (c && Array.isArray(c.rows)) return c;
    throw e;
  }
}

/** 한국 종목: 예탁원 배당 일정 + 원주가 월봉. 미국 종목: 해외주식 기간별권리조회 + 야후 액면분할 */
function kisDividendFetcher(cred: KisCredentials, usMarket: Map<string, string>) {
  const client = getClient(cred);
  return async (code: string): Promise<Omit<KisDividendCache, "fetched">> => {
    if (isKrCode(code)) {
      const rows = await kisDividendRows(client, code, KIS_DIV_FROM, today());
      const raw = rows.length ? await kisRawMonthly(client, code, rows[0].recordDate.slice(0, 7) + "-01", today()) : {};
      return { rows, raw };
    }
    const rows = await kisUsDividendRows(client, code, usMarket.get(code) ?? "NASDAQ", KIS_DIV_FROM, today());
    const splits = rows.length ? await fetchSplits(code) : [];
    return { rows, splits };
  };
}

async function onlineDividends(codes: string[], req: DataRequest, out: DataResponse, opts: LoadOptions = {}): Promise<DividendData> {
  // 한국투자증권 미국 수정주가는 배당까지 반영된 가격이라 현금 배당을 따로 넣지 않는다
  const inPrice = new Set(out.dividendAdjusted ?? []);
  if (inPrice.size) {
    const list = codes.filter((c) => inPrice.has(c));
    codes = codes.filter((c) => !inPrice.has(c));
    out.warnings.push(`${list.slice(0, 8).join(", ")}${list.length > 8 ? " 등" : ""}: 한국투자증권 미국 시세는 배당이 가격에 이미 반영된 수정주가라서 배당금을 현금으로 따로 넣지 않았습니다(배당을 받는 대로 다시 산 것과 같고, 배당소득세는 빠지지 않습니다).`);
  }
  const yahoo = await pool(codes, 3, (c) => cachedDividends(c));
  // 한국투자증권(한국: 예탁원 배당 일정, 미국: 해외주식 권리) 먼저, 없거나 실패하면 Yahoo
  const cred = opts.kisDividendCred === undefined ? credentialsFor("real") : opts.kisDividendCred;
  const usCodes = codes.filter((c) => !isKrCode(c));
  const usMarket = new Map<string, string>();
  if (cred && usCodes.length) { try { for (const u of await cachedUsMaster()) usMarket.set(u.code, u.market); } catch { /* 모르면 NASDAQ 로 시도 */ } }
  /** 한국투자증권 기준 배당 (현지 통화: 한국 원, 미국 달러) */
  const kisBy = new Map<string, Dividend[]>();
  let kisError = "", skipped = 0;
  if (cred) {
    const fetcher = kisDividendFetcher(cred, usMarket);
    const kr = await pool(codes, 3, (c) => cachedKisDividends(c, fetcher));
    kr.forEach((r, k) => {
      const code = codes[k];
      if (r.status !== "fulfilled") { kisError ||= `${code}: ${(r.reason as Error)?.message ?? r.reason}`; return; }
      const bars = out.data[code] ?? [];
      if (isKrCode(code)) {
        const t = toEngineDividends(r.value.rows, bars, r.value.raw ?? {});
        skipped += t.skipped;
        if (t.divs.length) kisBy.set(code, t.divs);
      } else {
        // 미국 시세는 원화로 바뀌어 있지만 날짜는 그대로 → 날짜만 씀
        const d = toEngineUsDividends(r.value.rows, bars.map((b) => b.date), r.value.splits ?? []);
        if (d.length) kisBy.set(code, d);
      }
    });
  }
  const res: DividendData = {};
  const failed: string[] = [], gaps: string[] = [];
  let count = 0, nKis = 0, nMixed = 0;
  codes.forEach((code, k) => {
    const r = yahoo[k];
    const y = r.status === "fulfilled" ? r.value : null;
    const kis = kisBy.get(code);
    let divs: Dividend[];
    if (kis?.length) {
      const m = mergeDividends(kis, y ?? []);
      divs = m.divs.filter((d) => d.date >= req.start && d.date <= req.end);
      const early = Date.parse(kis[0].date) - 20 * 864e5;
      if (divs.some((d) => Date.parse(d.date) < early)) nMixed++; else nKis++;
    } else {
      if (!y) { failed.push(code); return; }
      divs = y.filter((d) => d.date >= req.start && d.date <= req.end);
      const g = dividendGaps(y, req.start, req.end);
      if (g.length) gaps.push(`${code}(${g.map((x) => `${x.from}~${x.to}`).join(", ")})`);
    }
    if (!isKrCode(code)) {
      // 미국 종목: 시세가 원화로 바뀌어 있으므로 배당도 배당락일 환율로 원화 환산
      if (!out.fx?.length) { failed.push(code); return; }
      divs = divs.map((d) => ({ date: d.date, amount: d.amount * (fxOn(out.fx!, d.date) ?? NaN) })).filter((d) => d.amount > 0);
    }
    if (divs.length) { res[code] = divs; count++; }
  });
  if (count) {
    const nY = count - nKis - nMixed;
    const src = [nKis && `한국투자증권 ${nKis}종목`, nMixed && `한국투자증권 + 그 이전 기간은 Yahoo ${nMixed}종목`, nY > 0 && `Yahoo Finance ${nY}종목`].filter(Boolean).join(", ");
    out.warnings.push(`배당금·분배금: ${count}종목의 배당 이력을 반영했습니다 (${src}). 배당락일 장 시작 전에 들고 있던 수량만큼 세후 금액이 현금으로 들어옵니다.`);
  }
  if (kisError) out.warnings.push(`한국투자증권 배당 조회가 일부 실패해 그 종목은 Yahoo 배당을 썼습니다 (${kisError}).`);
  else if (!cred) out.warnings.push("한국투자증권 앱키가 없어 배당은 Yahoo Finance 기록을 썼습니다. 설정에서 실전 앱키를 넣으면 한국투자증권 배당 정보를 씁니다.");
  if (skipped) out.warnings.push(`한국투자증권 배당 ${skipped}건은 그 달 원주가를 못 받아 수정 금액을 계산할 수 없어 뺐습니다.`);
  if (failed.length) out.warnings.push(`배당 이력을 못 받아 배당 없이 계산한 종목: ${failed.slice(0, 10).join(", ")}${failed.length > 10 ? ` 외 ${failed.length - 10}개` : ""}`);
  if (gaps.length) out.warnings.push(`배당 기록이 평소보다 오래 비어 있어 일부가 빠졌을 수 있는 종목: ${gaps.slice(0, 5).join("; ")}${gaps.length > 5 ? ` 외 ${gaps.length - 5}개` : ""}`);
  return res;
}

async function csvDividends(codes: string[]): Promise<DividendData> {
  let text: string;
  try { text = await fs.readFile(path.join(CSV_DIR, "dividends.csv"), "utf8"); } catch { return {}; }
  const all = parseDividendCsv(text);
  return Object.fromEntries(codes.filter((c) => all[c]?.length).map((c) => [c, all[c]]));
}

async function loadPrices(req: DataRequest, opts: LoadOptions = {}): Promise<DataResponse> {
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
      if (code.toUpperCase() === "KOSPI" || code.toLowerCase() === "universe" || code.toLowerCase() === "dividends") continue;
      data[code] = clip(parseCsv(await fs.readFile(path.join(CSV_DIR, f), "utf8")), req.start, req.end);
      names[code] = code;
    }
    let benchmark = null;
    try {
      benchmark = clip(parseCsv(await fs.readFile(path.join(CSV_DIR, "KOSPI.csv"), "utf8")), req.start, req.end)
        .map((b) => ({ date: b.date, close: b.close }));
    } catch { warnings.push("data/csv/KOSPI.csv 가 없어 지수 비교·시장 필터를 쓸 수 없습니다."); }
    if (!Object.keys(data).length) throw new Error("data/csv/ 폴더에 CSV 파일이 없습니다");
    let universe: UniverseSnapshot[] | undefined;
    try {
      const u = parseUniverseCsv(await fs.readFile(path.join(CSV_DIR, "universe.csv"), "utf8"));
      if (u.snapshots.length) { universe = u.snapshots; Object.assign(names, u.names); warnings.push(`data/csv/universe.csv 의 시점별 종목 목록(${u.snapshots.length}개 시점)을 적용했습니다.`); }
    } catch { /* 없으면 전체 종목 */ }
    return { data, names, benchmark, warnings, universe };
  }

  // naver / kis (kis 는 시세만 한국투자증권, 시총 순위는 네이버)
  const isKis = req.source === "kis";
  const fetcher = isKis ? kisFetcher(opts.kisCred) : fetchDaily;
  const src = isKis ? "kis" : "naver";
  let list: StockInfo[];
  let universe: UniverseSnapshot[] | undefined;
  const isin = new Map<string, string>();
  if (req.tickers?.length) list = req.tickers.map((code) => ({ code, name: code }));
  else if (req.pit) {
    try {
      const u = await buildPitUniverse(req.start, req.end, req.universeSize ?? 100, cachedListings);
      universe = u.snapshots;
      list = [...u.listings.entries()].map(([code, v]) => { isin.set(code, v.isin); return { code, name: v.name }; });
    } catch (e) {
      const cause = (e as any)?.cause?.code ?? (e as Error).message;
      throw new Error(`KRX 정보데이터시스템에서 과거 종목 목록을 받지 못했습니다 (${cause}). KRX 가 접속 방식을 바꿨거나 로그인을 요구할 수 있습니다. '과거 시점의 시총 상위 종목 사용'을 끄고 다시 실행하거나, data/csv/universe.csv 를 직접 넣어 '내 CSV 파일'로 쓰세요.`);
    }
    warnings.push(`분기마다 그 시점의 시총 상위 ${req.universeSize ?? 100}종목으로 종목 목록을 바꿉니다(${universe.length}개 시점, 모두 ${list.length}종목). 상장폐지된 종목도 포함해 생존편향을 줄였습니다.`);
  } else {
    try {
      list = await cachedUniverse(req.universeSize ?? 100);
    } catch (e) {
      const cause = (e as any)?.cause?.code ?? (e as Error).message;
      throw new Error(`네이버 증권에서 시총 순위를 받지 못했습니다 (${cause}). 인터넷 연결이나 방화벽을 확인하세요.${isKis ? " 한국투자증권 시세만 쓰려면 '종목 직접 입력'으로 종목코드를 넣으세요." : " 오프라인이면 '내 CSV 파일' 데이터를 쓰세요."}`);
    }
    warnings.push("유니버스는 '현재' 시총 상위 종목입니다. 과거에 상장폐지된 종목이 빠져 있어 성과가 실제보다 좋게 나올 수 있습니다(생존편향). '과거 시점의 시총 상위 종목 사용'을 켜면 줄일 수 있습니다.");
  }
  // 상장폐지 종목은 네이버·한국투자증권에 시세가 없을 수 있어 KRX 개별종목 시세로 대신 받는다
  const krxFetcher = (code: string): DailyFetcher => async (_, start) => {
    const bars = await krxDaily(isin.get(code)!, start, today());
    if (!bars.length) throw new Error(`${code}: 데이터 없음`);
    return bars;
  };
  let fromKrx = 0;
  // 미국 종목 시세(달러) → 아래에서 원화로 환산.
  // 데이터가 한국투자증권이면 한국투자증권 해외 시세를 먼저 쓰고, 못 받거나 과거가 모자라면 야후 파이낸스로 넘어간다
  const usCodes = list.filter((s) => isUsTicker(s.code)).map((s) => s.code);
  const usMaster = usCodes.length ? await cachedUsMaster() : [];
  const usVia = new Map<string, "kis" | "yahoo">();
  const kisUs = isKis && usCodes.length ? getClient((opts.kisCred === undefined ? quoteCredentials() : opts.kisCred)!) : null;
  /** 한국투자증권 먼저, 안 되면 야후. 한국투자증권 쪽 시작이 늦으면 야후와 비교해 더 긴 쪽 */
  const kisFirst = async (key: string, yahooSym: string, from: string, kis: DailyFetcher): Promise<Bar[]> => {
    const viaYahoo = () => cachedDaily(yahooSym, from, "yahoo", fetchYahooDaily);
    if (!kisUs) { usVia.set(key, "yahoo"); return viaYahoo(); }
    let bars: Bar[];
    try { bars = await cachedDaily(key, from, "kis", kis); }
    catch { usVia.set(key, "yahoo"); return viaYahoo(); }
    if (bars[0].date > plusDays(from, 14)) {
      try {
        const y = await viaYahoo();
        if (y.length && y[0].date < minusDays(bars[0].date, 14)) { usVia.set(key, "yahoo"); return y; }
      } catch { /* 야후도 안 되면 한국투자증권 것 그대로 */ }
    }
    usVia.set(key, "kis");
    return bars;
  };
  const usDaily = (code: string) => {
    const m = usMaster.find((u) => u.code === code)?.market;
    const ex: KisExchange[] | undefined = m ? [KIS_EXCHANGE[m]] : undefined;
    return kisFirst(code, code, req.start, (sym, start) => kisUsDaily(kisUs!, sym, start, today(), ex));
  };
  let got = 0;
  opts.onProgress?.(0, list.length);
  const results = await pool(list, 6, async (s) => {
    try {
      if (isUsTicker(s.code)) return await usDaily(s.code);
      try { return await cachedDaily(s.code, req.start, src, fetcher); }
      catch (e) {
        if (!isin.get(s.code)) throw e;
        const bars = await cachedDaily(s.code, req.start, "krx", krxFetcher(s.code));
        fromKrx++;
        return bars;
      }
    } finally { opts.onProgress?.(++got, list.length); }
  });
  let fx: { date: string; close: number }[] | undefined;
  if (usCodes.length) {
    try {
      fx = (await kisFirst("FX@KRW", USDKRW, minusDays(req.start, 10), (_, start) => kisUsdKrwDaily(kisUs!, start, today()))).map((b) => ({ date: b.date, close: b.close }));
    } catch (e) {
      throw new Error(`원/달러 환율을 받지 못해 미국 종목을 원화로 바꿀 수 없습니다 (${(e as Error).message}). 잠시 뒤 다시 실행하세요.`);
    }
  }
  const usNames = new Map(usMaster.map((u) => [u.code, u.name]));
  const data: PriceData = {}, names: Record<string, string> = {};
  results.forEach((r, k) => {
    const s = list[k];
    if (r.status === "fulfilled") {
      const us = isUsTicker(s.code);
      data[s.code] = clip(us ? toKrw(r.value, fx!) : r.value, req.start, req.end);
      names[s.code] = us ? usNames.get(s.code) ?? s.name : s.name;
    }
    else warnings.push(`${s.code} 건너뜀: ${(r.reason as Error)?.message ?? r.reason}`);
  });
  const usLoaded = usCodes.filter((t) => t in data);
  if (usLoaded.length) {
    const fromKis = usLoaded.filter((t) => usVia.get(t) === "kis"), fromYahoo = usLoaded.filter((t) => usVia.get(t) !== "kis");
    const where = !fromYahoo.length ? "한국투자증권" : !fromKis.length ? "야후 파이낸스" : "한국투자증권·야후 파이낸스";
    warnings.push(`미국 종목 ${usLoaded.length}개(${usLoaded.slice(0, 5).join(", ")}${usLoaded.length > 5 ? " 등" : ""})는 ${where} 시세를 그날 원/달러 환율(${usVia.get("FX@KRW") === "kis" ? "한국투자증권" : "야후 파이낸스"})로 원화로 바꿔 계산했습니다. 환율 변동이 수익률에 들어가고, 미국 종목 비용은 '자금·비용'의 미국 수수료·환전 비용을 씁니다. 양도소득세(연 250만 원 넘는 차익의 22%)는 계산하지 않습니다.`);
    if (fromKis.length && req.dividends === false) warnings.push(`${fromKis.slice(0, 8).join(", ")}${fromKis.length > 8 ? " 등" : ""}: 한국투자증권 미국 시세는 배당이 가격에 이미 반영된 수정주가라서, 배당 반영을 꺼도 이 종목 수익률에는 배당이 들어 있습니다.`);
    if (isKis && fromYahoo.length) warnings.push(`${fromYahoo.slice(0, 8).join(", ")}${fromYahoo.length > 8 ? " 등" : ""}: 한국투자증권에서 시세를 못 받았거나 과거 기간이 모자라 야후 파이낸스 시세를 썼습니다.`);
    if (!isKis) warnings.push("데이터를 '한국투자증권 API'로 고르면 미국 종목 시세·환율도 한국투자증권에서 받습니다.");
  }
  if (!Object.keys(data).length) throw new Error(`가격 데이터를 하나도 받지 못했습니다. 네트워크 상태를 확인하세요. (${warnings[0] ?? ""})`);
  const adjusted = usLoaded.filter((t) => usVia.get(t) === "kis");
  const divAdj = adjusted.length ? { dividendAdjusted: adjusted } : {};
  let benchmark = null;
  // 미국 종목만 넣었으면 S&P 500 (원화 환산)을 비교 지수로
  const usOnly = list.length > 0 && list.every((x) => isUsTicker(x.code));
  if (usOnly) {
    try {
      const idx = toKrw(await kisFirst("SPX", SP500, req.start, (_, start) => kisSp500Daily(kisUs!, start, today())), fx!);
      benchmark = clip(idx, req.start, req.end).map((b) => ({ date: b.date, close: b.close }));
    } catch (e) { warnings.push(`S&P 500 지수 조회 실패: ${(e as Error).message}`); }
    if (fromKrx) warnings.push(`${fromKrx}종목은 KRX 시세를 썼습니다.`);
    return { data, names, benchmark, warnings, universe, benchmarkName: "S&P 500", fx, ...divAdj };
  }
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
  if (fromKrx) warnings.push(`${fromKrx}종목은 ${isKis ? "한국투자증권" : "네이버"}에 시세가 없어(상장폐지 등) KRX 시세를 썼습니다.`);
  return { data, names, benchmark, warnings, universe, benchmarkName: "KOSPI", ...(fx ? { fx } : {}), ...divAdj };
}
