/**
 * 종목 목록(코드·이름) 저장과 이름 검색 (서버 전용).
 *
 * 받는 곳: 한국투자증권 종목 마스터 파일 (로그인·앱키 없이 공개로 받을 수 있는 zip)
 *   https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip  (KOSPI 주식·ETF·ETN·리츠 등)
 *   https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip (KOSDAQ)
 * 저장 위치: {설정 폴더}/stocks.json  — 7일이 지나면 검색할 때 뒤에서 새로 받음. 설정 화면에서 바로 받을 수도 있음
 * 받기 전이거나 인터넷이 안 되면 아래 기본 목록(SEED)과 사용자가 직접 추가한 종목으로 검색
 *
 * 다른 시장(미국 등)을 넣으려면 PROVIDERS 에 함수를 하나 더하면 된다. market 값으로 구분.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import iconv from "iconv-lite";
import { configDir } from "../settings/store";
import { fetchUsMarket } from "../data/usMaster";

export interface StockEntry {
  code: string;
  name: string;
  /** "KOSPI" | "KOSDAQ" (미국 등은 "NASDAQ" | "NYSE" | "AMEX" 처럼 추가) */
  market: string;
  /** 주식 | ETF | ETN | 리츠 | 인프라 | DR | 외국주 */
  type?: string;
}

export interface StockStore {
  /** 마지막으로 받은 시각 (ISO) */
  updated?: string;
  /** 받은 목록 */
  entries: StockEntry[];
  /** 사용자가 설정 화면에서 직접 넣은 종목 (받은 목록보다 우선) */
  custom: StockEntry[];
  /** 마지막으로 받기 실패한 이유 */
  error?: string;
  errorAt?: string;
}

const REFRESH_MS = 7 * 864e5;
const RETRY_MS = 6 * 3600e3; // 실패하면 6시간 동안은 다시 시도하지 않음
const MASTER_BASE = "https://new.real.download.dws.co.kr/common/master";

// ───────── zip / 마스터 파일 파싱 ─────────

/** zip 안의 첫 번째 파일 내용 (중앙 디렉터리 기준, 저장·deflate 만) */
export function unzipFirst(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip 형식이 아닙니다");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip 목록이 깨졌습니다");
  const method = buf.readUInt16LE(cd + 10);
  const csize = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip 파일 머리가 깨졌습니다");
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + csize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip 압축 방식 ${method} 은 지원하지 않습니다`);
}

/** 한국투자증권 마스터 파일의 그룹코드 → 종류. 목록에 없는 것(신주인수권·수익증권 등)은 뺀다 */
const KIND: Record<string, string> = { ST: "주식", EF: "ETF", EN: "ETN", RT: "리츠", IF: "인프라", DR: "DR", FS: "외국주", MF: "펀드" };

/**
 * kospi_code.mst / kosdaq_code.mst (cp949, 한 줄에 한 종목).
 * 앞부분: 단축코드 9 + 표준코드 12 + 한글명(나머지), 뒷부분: 고정 길이 tail 바이트(첫 2자리가 그룹코드)
 * tail 길이(줄바꿈 제외): KOSPI 227, KOSDAQ 221
 */
export function parseKisMaster(raw: Buffer, market: string, tail: number): StockEntry[] {
  const out: StockEntry[] = [];
  let pos = 0;
  while (pos < raw.length) {
    let end = raw.indexOf(0x0a, pos);
    if (end < 0) end = raw.length;
    let line = raw.subarray(pos, end);
    pos = end + 1;
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length < 21 + tail) continue;
    const code = line.subarray(0, 9).toString("latin1").trim();
    const group = line.subarray(line.length - tail, line.length - tail + 2).toString("latin1");
    const type = KIND[group];
    if (!type || !/^[0-9A-Z]{6}$/.test(code)) continue;
    const name = iconv.decode(line.subarray(21, line.length - tail), "cp949").trim();
    if (name) out.push({ code, name, market, type });
  }
  return out;
}

async function fetchMaster(file: string, market: string, tail: number, f: typeof fetch): Promise<StockEntry[]> {
  const res = await f(`${MASTER_BASE}/${file}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const rows = parseKisMaster(unzipFirst(Buffer.from(await res.arrayBuffer())), market, tail);
  if (rows.length < 100) throw new Error(`${file}: 종목이 너무 적습니다(${rows.length})`);
  return rows;
}

export type Provider = { label: string; load: (f: typeof fetch) => Promise<StockEntry[]> };

export const PROVIDERS: Provider[] = [
  { label: "KOSPI", load: (f) => fetchMaster("kospi_code.mst.zip", "KOSPI", 227, f) },
  { label: "KOSDAQ", load: (f) => fetchMaster("kosdaq_code.mst.zip", "KOSDAQ", 221, f) },
  // 미국: 한국투자증권 해외 종목 마스터 (한글 이름). 거래소별로 나눠 하나가 실패해도 나머지 예전 목록 유지
  ...(["NASDAQ", "NYSE", "AMEX"] as const).map((m): Provider => ({
    label: m,
    load: async (f) => (await fetchUsMarket(m, f)).map((u) => ({ code: u.code, name: u.name, market: m, type: u.type === "etf" ? "ETF" : "주식" })),
  })),
];

/** 받기 전에도 검색되도록 넣어 둔 기본 목록 (자주 쓰는 종목·ETF) */
export const SEED: StockEntry[] = ([
  ["005930", "삼성전자"], ["000660", "SK하이닉스"], ["005935", "삼성전자우"], ["402340", "SK스퀘어"], ["373220", "LG에너지솔루션"],
  ["207940", "삼성바이오로직스"], ["009150", "삼성전기"], ["105560", "KB금융"], ["005380", "현대차"], ["032830", "삼성생명"],
  ["068270", "셀트리온"], ["028260", "삼성물산"], ["055550", "신한지주"], ["006400", "삼성SDI"], ["000270", "기아"],
  ["034730", "SK"], ["086790", "하나금융지주"], ["012450", "한화에어로스페이스"], ["012330", "현대모비스"], ["034020", "두산에너빌리티"],
  ["329180", "HD현대중공업"], ["035420", "NAVER"], ["316140", "우리금융지주"], ["000810", "삼성화재"], ["066570", "LG전자"],
  ["005490", "POSCO홀딩스"], ["011200", "HMM"], ["138040", "메리츠금융지주"], ["035720", "카카오"], ["051910", "LG화학"],
].map(([code, name]) => ({ code, name, market: "KOSPI", type: "주식" })) as StockEntry[]).concat(([
  ["196170", "알테오젠"], ["086520", "에코프로"], ["247540", "에코프로비엠"], ["036930", "주성엔지니어링"], ["277810", "레인보우로보틱스"],
  ["222800", "심텍"], ["039030", "이오테크닉스"], ["000250", "삼천당제약"], ["058470", "리노공업"], ["028300", "HLB"],
].map(([code, name]) => ({ code, name, market: "KOSDAQ", type: "주식" }))), ([
  ["069500", "KODEX 200"], ["102110", "TIGER 200"], ["114800", "KODEX 인버스"], ["122630", "KODEX 레버리지"], ["133690", "TIGER 미국나스닥100"],
  ["148070", "KIWOOM 국고채10년"], ["153130", "KODEX 단기채권"], ["229200", "KODEX 코스닥150"], ["252670", "KODEX 200선물인버스2X"], ["305720", "KODEX 2차전지산업"],
  ["360750", "TIGER 미국S&P500"], ["379800", "KODEX 미국S&P500"], ["381170", "TIGER 미국테크TOP10 INDXX"], ["458730", "TIGER 미국배당다우존스"],
].map(([code, name]) => ({ code, name, market: "KOSPI", type: "ETF" }))), ([
  ["AAPL", "애플", "NASDAQ"], ["MSFT", "마이크로소프트", "NASDAQ"], ["NVDA", "엔비디아", "NASDAQ"], ["AMZN", "아마존닷컴", "NASDAQ"],
  ["GOOGL", "알파벳 A", "NASDAQ"], ["META", "메타 플랫폼스", "NASDAQ"], ["TSLA", "테슬라", "NASDAQ"], ["BRK.B", "버크셔 해서웨이 B", "NYSE"],
].map(([code, name, market]) => ({ code, name, market, type: "주식" }))), ([
  ["SPY", "SPDR S&P 500", "AMEX"], ["VOO", "뱅가드 S&P 500", "AMEX"], ["QQQ", "인베스코 QQQ (나스닥100)", "NASDAQ"], ["SCHD", "슈왑 미국 배당", "AMEX"],
].map(([code, name, market]) => ({ code, name, market, type: "ETF" }))));

// ───────── 검색 ─────────

/** 같은 점수면 기본 목록(자주 쓰는 종목)을 먼저 */
const POPULAR = new Map(SEED.map((e, i) => [e.code, i]));

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** 한글 초성만 뽑기 ("삼성전자" → "ㅅㅅㅈㅈ"), 한글이 아닌 글자는 그대로 */
export function choseong(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
const isChoQuery = (q: string) => /^[ㄱ-ㅎ]+$/.test(q);

/** 점수가 낮을수록 위. 맞지 않으면 null */
function score(e: StockEntry, q: string, cho: boolean): number | null {
  const code = e.code.toLowerCase(), name = norm(e.name);
  if (cho) {
    const c = choseong(name);
    return c.startsWith(q) ? 6 : c.includes(q) ? 7 : null;
  }
  if (code === q) return 0;
  if (name === q) return 1;
  if (code.startsWith(q)) return 2;
  if (name.startsWith(q)) return 3;
  if (name.includes(q)) return 4;
  return null;
}

const TYPE_ORDER: Record<string, number> = { 주식: 0, stock: 0, ETF: 1, etf: 1 };

/** 이름·코드·초성으로 찾기 */
export function searchStocks(list: StockEntry[], query: string, limit = 20): StockEntry[] {
  const q = norm(query);
  if (!q) return [];
  const cho = isChoQuery(q);
  const hits: { e: StockEntry; s: number }[] = [];
  for (const e of list) {
    const s = score(e, q, cho);
    if (s !== null) hits.push({ e, s });
  }
  hits.sort((a, b) => a.s - b.s
    || (POPULAR.get(a.e.code) ?? 999) - (POPULAR.get(b.e.code) ?? 999)
    || (TYPE_ORDER[a.e.type ?? ""] ?? 2) - (TYPE_ORDER[b.e.type ?? ""] ?? 2)
    || a.e.name.length - b.e.name.length
    || a.e.name.localeCompare(b.e.name, "ko"));
  return hits.slice(0, limit).map((h) => h.e);
}

/** 사용자 추가 > 받은 목록 > 기본 목록 순서로 코드 중복 제거 */
export function mergeLists(...lists: StockEntry[][]): StockEntry[] {
  const seen = new Map<string, StockEntry>();
  for (const l of lists) for (const e of l) {
    const k = `${e.market}:${e.code}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()];
}

// ───────── 저장 ─────────

type Env = Record<string, string | undefined>;
export const stocksPath = (e: Env = process.env) => path.join(configDir(e), "stocks.json");

let mem: { file: string; mtimeMs: number; store: StockStore; all: StockEntry[] } | null = null;

export function loadStore(e: Env = process.env): StockStore {
  const file = stocksPath(e);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { updated: raw.updated, entries: Array.isArray(raw.entries) ? raw.entries : [], custom: Array.isArray(raw.custom) ? raw.custom : [], error: raw.error, errorAt: raw.errorAt };
  } catch { return { entries: [], custom: [] }; }
}

export function saveStore(s: StockStore, e: Env = process.env) {
  const file = stocksPath(e);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, file);
  mem = null;
}

/** 검색에 쓰는 전체 목록 (파일이 바뀌지 않았으면 메모리 캐시) */
export function allStocks(e: Env = process.env): { store: StockStore; all: StockEntry[] } {
  const file = stocksPath(e);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 없음 */ }
  if (mem && mem.file === file && mem.mtimeMs === mtimeMs) return mem;
  const store = loadStore(e);
  const all = mergeLists(store.custom, store.entries, SEED);
  mem = { file, mtimeMs, store, all };
  return mem;
}

let inflight: Promise<StockStore> | null = null;

/** 마스터 파일을 새로 받아 저장. 일부 시장만 실패하면 그 시장은 예전 목록을 유지 */
export function refreshStocks(e: Env = process.env, f: typeof fetch = fetch, providers: Provider[] = PROVIDERS): Promise<StockStore> {
  if (inflight) return inflight;
  inflight = (async () => {
    const old = loadStore(e);
    const got = await Promise.allSettled(providers.map((p) => p.load(f)));
    const entries: StockEntry[] = [];
    const errors: string[] = [];
    got.forEach((r, i) => {
      if (r.status === "fulfilled") entries.push(...r.value);
      else {
        const label = providers[i].label;
        errors.push(`${label}: ${(r.reason as Error)?.message ?? r.reason}`);
        // 실패한 시장은 예전 목록을 그대로 둔다 (provider 하나가 시장 하나를 맡는다고 가정)
        entries.push(...old.entries.filter((x) => x.market === label));
      }
    });
    const ok = got.some((r) => r.status === "fulfilled");
    const now = new Date().toISOString();
    const next: StockStore = {
      ...old,
      entries: ok ? entries : old.entries,
      updated: ok ? now : old.updated,
      error: errors.length ? errors.join(" / ") : undefined,
      errorAt: errors.length ? now : undefined,
    };
    saveStore(next, e);
    return next;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** 오래됐으면 뒤에서 새로 받기 시작 (기다리지 않음) */
export function refreshIfStale(e: Env = process.env, now = Date.now()) {
  const s = allStocks(e).store;
  const age = s.updated ? now - Date.parse(s.updated) : Infinity;
  const recentFail = s.errorAt && now - Date.parse(s.errorAt) < RETRY_MS;
  if (age > REFRESH_MS && !recentFail && !inflight) refreshStocks(e).catch((err) => console.error(`[stocks] 종목 목록 받기 실패: ${(err as Error).message}`));
}

/** 코드 → 이름 */
export function lookupCodes(codes: string[], e: Env = process.env): StockEntry[] {
  const { all } = allStocks(e);
  const by = new Map<string, StockEntry>();
  for (const x of all) if (!by.has(x.code.toUpperCase())) by.set(x.code.toUpperCase(), x);
  return codes.map((c) => by.get(c.toUpperCase())).filter((x): x is StockEntry => !!x);
}

export function addCustom(entry: StockEntry, e: Env = process.env): StockStore {
  const code = entry.code.trim().toUpperCase(), name = entry.name.trim(), market = (entry.market || "KOSPI").trim().toUpperCase();
  if (!/^[0-9A-Z.\-]{1,12}$/.test(code)) throw new Error("종목코드는 영문 대문자·숫자 12자 이내로 넣어 주세요");
  if (!name || name.length > 60) throw new Error("종목 이름을 60자 이내로 넣어 주세요");
  const s = loadStore(e);
  s.custom = [{ code, name, market, type: entry.type?.trim() || undefined }, ...s.custom.filter((x) => !(x.code === code && x.market === market))];
  saveStore(s, e);
  return s;
}

export function removeCustom(code: string, market: string | undefined, e: Env = process.env): StockStore {
  const s = loadStore(e);
  s.custom = s.custom.filter((x) => !(x.code === code.toUpperCase() && (!market || x.market === market)));
  saveStore(s, e);
  return s;
}
