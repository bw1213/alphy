import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import iconv from "iconv-lite";
import {
  addCustom, allStocks, choseong, lookupCodes, parseKisMaster, refreshStocks, removeCustom, searchStocks, unzipFirst,
  type Provider, type StockEntry,
} from "@/lib/stocks/master";

/** 파일 하나짜리 zip (deflate) */
function makeZip(name: string, data: Buffer): Buffer {
  const comp = zlib.deflateRawSync(data);
  const fn = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fn.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(fn.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + fn.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + fn.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, fn, comp, cd, fn, eocd]);
}

/** 한국투자증권 마스터 형식의 한 줄: 단축코드 9 + 표준코드 12 + 이름(40바이트) + tail */
function mstLine(code: string, name: string, group: string, tail: number): Buffer {
  const nm = iconv.encode(name, "cp949");
  const pad = Buffer.alloc(Math.max(0, 40 - nm.length), 0x20);
  return Buffer.concat([Buffer.from(code.padEnd(9) + "KR7" + code + "000"), nm, pad, Buffer.from(group + " ".repeat(tail - 2))]);
}

describe("종목 마스터 파일", () => {
  it("zip 을 풀고 줄마다 코드·이름·종류를 읽는다 (신주인수권·수익증권은 뺌)", () => {
    const raw = Buffer.concat([
      mstLine("005930", "삼성전자", "ST", 227), Buffer.from("\n"),
      mstLine("069500", "KODEX 200", "EF", 227), Buffer.from("\r\n"),
      mstLine("F70100", "한투한미넥스트혁신성장1(A)", "BC", 227), Buffer.from("\n"),
      mstLine("123456", "어떤신주인수권", "SW", 227), Buffer.from("\n"),
    ]);
    const rows = parseKisMaster(unzipFirst(makeZip("kospi_code.mst", raw)), "KOSPI", 227);
    expect(rows).toEqual([
      { code: "005930", name: "삼성전자", market: "KOSPI", type: "주식" },
      { code: "069500", name: "KODEX 200", market: "KOSPI", type: "ETF" },
    ]);
  });

  it("KOSDAQ 은 tail 길이가 다르다", () => {
    const rows = parseKisMaster(mstLine("196170", "알테오젠", "ST", 221), "KOSDAQ", 221);
    expect(rows).toEqual([{ code: "196170", name: "알테오젠", market: "KOSDAQ", type: "주식" }]);
  });
});

const LIST: StockEntry[] = [
  { code: "005930", name: "삼성전자", market: "KOSPI", type: "주식" },
  { code: "005935", name: "삼성전자우", market: "KOSPI", type: "주식" },
  { code: "006400", name: "삼성SDI", market: "KOSPI", type: "주식" },
  { code: "069500", name: "KODEX 200", market: "KOSPI", type: "ETF" },
  { code: "102780", name: "KODEX 삼성그룹", market: "KOSPI", type: "ETF" },
  { code: "000660", name: "SK하이닉스", market: "KOSPI", type: "주식" },
];

describe("이름 검색", () => {
  it("이름 앞부분이 맞는 종목이 먼저, 그다음 자주 쓰는 종목 순", () => {
    expect(searchStocks(LIST, "삼성").map((s) => s.code)).toEqual(["005930", "005935", "006400", "102780"]);
  });
  it("정확히 같은 이름이 맨 위", () => {
    expect(searchStocks(LIST, "삼성전자")[0].code).toBe("005930");
  });
  it("띄어쓰기·대소문자는 무시", () => {
    expect(searchStocks(LIST, "kodex200").map((s) => s.code)).toEqual(["069500"]);
    expect(searchStocks(LIST, "sk 하이").map((s) => s.code)).toEqual(["000660"]);
  });
  it("코드로도 찾는다", () => {
    expect(searchStocks(LIST, "0059").map((s) => s.code)).toEqual(["005930", "005935"]);
  });
  it("초성으로 찾는다", () => {
    expect(choseong("삼성전자")).toBe("ㅅㅅㅈㅈ");
    expect(searchStocks(LIST, "ㅅㅅㅈㅈ").map((s) => s.code)).toEqual(["005930", "005935"]);
  });
  it("빈 검색어는 빈 결과", () => {
    expect(searchStocks(LIST, "  ")).toEqual([]);
  });
});

describe("저장·새로 받기", () => {
  const tmpEnv = () => ({ ALPHY_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "alphy-stocks-")) });
  const okProvider = (market: string, rows: StockEntry[]): Provider => ({ label: market, load: async () => rows });
  const badProvider = (market: string): Provider => ({ label: market, load: async () => { throw new Error("막힘"); } });

  it("받기 전에는 기본 목록으로 검색된다", () => {
    const env = tmpEnv();
    expect(searchStocks(allStocks(env).all, "KODEX 200")[0].code).toBe("069500");
  });

  it("받은 목록을 저장하고, 한 시장이 실패하면 그 시장은 예전 목록을 유지", async () => {
    const env = tmpEnv();
    await refreshStocks(env, fetch, [okProvider("KOSPI", [LIST[0]]), okProvider("KOSDAQ", [{ code: "196170", name: "알테오젠", market: "KOSDAQ" }])]);
    const s = await refreshStocks(env, fetch, [okProvider("KOSPI", [LIST[0], LIST[2]]), badProvider("KOSDAQ")]);
    expect(s.entries.map((e) => e.code).sort()).toEqual(["005930", "006400", "196170"]);
    expect(s.error).toContain("KOSDAQ");
    expect(s.updated).toBeTruthy();
    expect(fs.statSync(path.join(env.ALPHY_CONFIG_DIR, "stocks.json")).mode & 0o777).toBe(0o600);
  });

  it("모두 실패하면 받은 시각을 바꾸지 않는다", async () => {
    const env = tmpEnv();
    const s = await refreshStocks(env, fetch, [badProvider("KOSPI")]);
    expect(s.updated).toBeUndefined();
    expect(s.error).toContain("막힘");
  });

  it("직접 추가한 종목은 검색·이름 조회에 나오고 뺄 수 있다", () => {
    const env = tmpEnv();
    addCustom({ code: "999990", name: "내가넣은종목", market: "KOSDAQ" }, env);
    expect(searchStocks(allStocks(env).all, "내가넣은")[0].code).toBe("999990");
    expect(lookupCodes(["999990", "005930", "없음"], env).map((s) => s.name)).toEqual(["내가넣은종목", "삼성전자"]);
    removeCustom("999990", "KOSDAQ", env);
    expect(searchStocks(allStocks(env).all, "내가넣은")).toEqual([]);
    expect(() => addCustom({ code: "", name: "x", market: "KOSPI" }, env)).toThrow();
  });
});
