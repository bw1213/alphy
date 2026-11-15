/**
 * 미국 종목 목록 (서버 전용): 한국투자증권 해외주식 종목 마스터 파일.
 * 나스닥·뉴욕·아멕스 3개 파일(zip 안의 탭 구분 CP949 텍스트)에 티커, 한글 이름, 영문 이름, 종류가 있다.
 *  칸: 0 국가, 1 ?, 2 거래소코드(NAS/NYS/AMS), 3 거래소 한글, 4 심볼(BRK/B), 5 실시간심볼, 6 한글명, 7 영문명, 8 종류(2 주식, 3 ETF), 9 통화
 */
import { inflateRawSync } from "zlib";
import iconv from "iconv-lite";
import { normalizeTicker } from "./market";

export interface UsStock { code: string; name: string; nameEn: string; market: "NASDAQ" | "NYSE" | "AMEX"; type: "stock" | "etf" }

const FILES = [
  { url: "https://new.real.download.dws.co.kr/common/master/nasmst.cod.zip", market: "NASDAQ" as const },
  { url: "https://new.real.download.dws.co.kr/common/master/nysmst.cod.zip", market: "NYSE" as const },
  { url: "https://new.real.download.dws.co.kr/common/master/amsmst.cod.zip", market: "AMEX" as const },
];

/** zip 첫 파일 꺼내기 (중앙 디렉터리에서 크기를 읽어 압축 해제) */
export function firstFileInZip(buf: Buffer): Buffer {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("zip 형식이 아닙니다");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip 목록을 읽지 못했습니다");
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`지원하지 않는 zip 압축 방식 ${method}`);
}

export function parseUsMaster(text: string, market: UsStock["market"]): UsStock[] {
  const out: UsStock[] = [];
  for (const ln of text.split(/\r?\n/)) {
    const x = ln.split("\t");
    if (x.length < 9 || x[0] !== "US") continue;
    const code = normalizeTicker(x[4]);
    if (!code) continue;
    const kind = x[8].trim();
    if (kind !== "2" && kind !== "3") continue; // 주식·ETF 만 (워런트 등 제외)
    const nameEn = x[7].trim();
    out.push({ code, name: x[6].trim() || nameEn, nameEn, market, type: kind === "3" ? "etf" : "stock" });
  }
  return out;
}

/** 거래소 하나의 종목 목록 */
export async function fetchUsMarket(market: UsStock["market"]): Promise<UsStock[]> {
  const f = FILES.find((x) => x.market === market)!;
  const res = await fetch(f.url, { cache: "no-store" });
  if (!res.ok) throw new Error(`미국 종목 목록(${market}) HTTP ${res.status}`);
  const txt = iconv.decode(firstFileInZip(Buffer.from(await res.arrayBuffer())), "cp949");
  return parseUsMaster(txt, market);
}

/** 3개 거래소 합친 목록 (같은 티커는 앞의 것) */
export async function fetchUsMaster(): Promise<UsStock[]> {
  const all = await Promise.all(FILES.map((f) => fetchUsMarket(f.market)));
  const seen = new Set<string>();
  return all.flat().filter((s) => (seen.has(s.code) ? false : (seen.add(s.code), true)));
}
