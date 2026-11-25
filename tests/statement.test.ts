import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PdfPasswordError, findLabel, parseHanwha, parseStatement, readPdfText, toLedgerTsv } from "@/lib/accounts/statement";
import { parseLedgerText } from "@/lib/accounts/ledger";

const file = (name = "hanwha") => new Uint8Array(readFileSync(path.join(__dirname, `fixtures/${name}-statement-locked.pdf`)));

describe("한화투자증권 거래명세서 PDF", () => {
  it("암호가 없거나 틀리면 알려 줌", async () => {
    await expect(readPdfText(pdfjs as any, file())).rejects.toMatchObject({ wrong: false });
    await expect(readPdfText(pdfjs as any, file(), "0000")).rejects.toBeInstanceOf(PdfPasswordError);
  });

  it("암호로 열어 입금·매수·매도를 읽고 원화예수금으로 맞춰 봄 (빠진 장이 있으면 잔액이 어긋난다고 알림)", async () => {
    const r = parseHanwha(await readPdfText(pdfjs as any, file(), "1234"));
    expect(r.skipped).toEqual([]);
    expect(r.mismatches).toEqual([expect.stringMatching(/^2025-09-01 매도/)]);
    expect(r.checked).toBe(10);
    expect(r.rows.length).toBe(11);
    expect(r.rows[0]).toMatchObject({ date: "2024-03-04", kind: "입금", amount: 5000000 });
    expect(r.rows[0].note).toMatch(/옮김/);
    expect(r.rows[1]).toMatchObject({ date: "2024-03-05", kind: "매수", ticker: "069500", name: "KODEX 200", qty: 10, price: 35000, fee: 50 });
    expect(r.rows[1].note).toBeUndefined();
    expect(r.rows[6]).toMatchObject({ kind: "매도", ticker: "069500", qty: 15, price: 37000, fee: 80 });
    expect(r.rows[8]).toMatchObject({ date: "2025-09-01", kind: "매도", ticker: "069500", name: "KODEX 200", qty: 100, price: 40000, fee: 500 });
    expect(r.rows[10]).toMatchObject({ date: "2025-09-20", kind: "입금", amount: 300000 });
    const parsed = parseLedgerText(toLedgerTsv(r.rows), { today: "2026-11-25", rates: { commission: 0, sellTax: 0, usCommission: 0, usFx: 0 } });
    expect(parsed.every((p) => p.entry)).toBe(true);
    expect(parsed[1].entry).toMatchObject({ kind: "buy", ticker: "069500", qty: 10, price: 35000, fee: 50 });
  });
});

describe("미래에셋증권 거래내역서 PDF", () => {
  it("표지는 건너뛰고 매수입고·매도출고를 매매로, 결제 줄·환전은 빼고, 펀드·달러 거래·배당을 읽음", async () => {
    const pages = await readPdfText(pdfjs as any, file("mirae"), "1234");
    const r = parseStatement(pages);
    expect(r.skipped).toEqual([]);
    expect(r.mismatches).toEqual([]);
    expect(r.checked).toBe(8);
    expect(r.fx).toBe(3);
    expect(r.rows.map((x) => x.kind)).toEqual(["입금", "매수", "매수", "매수", "입금", "매수", "배당", "매도", "이자", "매도"]);
    expect(r.rows[0]).toMatchObject({ date: "2021-03-02", amount: 1000000, note: "계좌대체입금" });
    expect(r.rows[1]).toMatchObject({ ticker: "KR5123456789", name: "가짜밸류증권자투자신탁(주식)A-E", qty: 160000, price: 1.25, fee: 0 });
    expect(r.rows[2]).toMatchObject({ date: "2021-03-04", ticker: "069500", name: "KODEX 200", qty: 10, price: 35000, fee: 50 });
    expect(r.rows[2].currency).toBeUndefined();
    expect(r.rows[5]).toMatchObject({ ticker: "SPY", name: "SPDR S&P 500 ETF", qty: 2, price: 400, fee: 1.2, currency: "USD" });
    expect(r.rows[6]).toMatchObject({ date: "2021-05-10", ticker: "SPY", amount: 2.55, currency: "USD" });
    expect(r.rows[7]).toMatchObject({ ticker: "069500", qty: 10, price: 37000, fee: 740 });
    expect(r.rows[8]).toMatchObject({ amount: 120 });
    expect(r.rows[9]).toMatchObject({ ticker: "SPY", qty: 2, price: 430, fee: 1.32, currency: "USD" });
    const parsed = parseLedgerText(toLedgerTsv(r.rows), { today: "2026-11-25", rates: { commission: 0, sellTax: 0, usCommission: 0, usFx: 0 } });
    expect(parsed.map((p) => p.error)).toEqual(parsed.map(() => undefined));
    expect(parsed[1].entry).toMatchObject({ kind: "buy", ticker: "KR5123456789", qty: 160000, price: 1.25 });
    expect(parsed[5].entry).toMatchObject({ kind: "buy", ticker: "SPY", currency: "USD", price: 400, fee: 1.2 });
    expect(parsed[6].entry).toMatchObject({ kind: "dividend", currency: "USD", amount: 2.55 });
  });

  it("한화 거래명세서는 한화로 읽음", async () => {
    expect(parseStatement(await readPdfText(pdfjs as any, file(), "1234")).broker).toBe("한화투자증권");
  });
});

describe("머리글 찾기", () => {
  it("글자마다 따로 나뉜 머리글도 이어 붙여 찾음", () => {
    const page = [..."예수금잔액"].map((c, i) => ({ str: c, x: 100 + i * 9, y: 50, w: 7 })).concat([{ str: "거래금액", x: 10, y: 50, w: 30 }]);
    expect(findLabel(page, /^예수금잔액$/)).toMatchObject({ x: 100, w: 43 });
    expect(findLabel(page, /^거래금액$/)).toMatchObject({ x: 10 });
    expect(findLabel(page, /^없는말$/)).toBeUndefined();
  });
});

describe("글자마다 따로 나온 PDF", () => {
  const split = (pages: Awaited<ReturnType<typeof readPdfText>>) => pages.map((pg) => pg.flatMap((t) => {
    const parts = t.str.split(/(\s+)/);
    const per = t.w / t.str.length;
    let x = t.x;
    return parts.flatMap((part) => {
      const out = /^\s+$/.test(part) ? [] : [...part].map((c, i) => ({ str: c, x: x + i * per, y: t.y, w: per }));
      x += part.length * per;
      return out;
    });
  }).concat([{ str: "2026-11-25", x: 200, y: 800, w: 39 }]));

  it("한화: 글자를 이어 붙이고 바닥글 날짜는 거래로 보지 않음", async () => {
    const whole = parseStatement(await readPdfText(pdfjs as any, file(), "1234"));
    const r = parseStatement(split(await readPdfText(pdfjs as any, file(), "1234")));
    expect(r.skipped).toEqual([]);
    expect(r.rows).toEqual(whole.rows);
    expect(r.checked).toBe(whole.checked);
  });

  it("미래에셋: 글자를 이어 붙여 읽음", async () => {
    const whole = parseStatement(await readPdfText(pdfjs as any, file("mirae"), "1234"));
    const r = parseStatement(split(await readPdfText(pdfjs as any, file("mirae"), "1234")));
    expect(r.skipped).toEqual([]);
    expect(r.rows).toEqual(whole.rows);
    expect(r.checked).toBe(8);
  });

  it("예탁금이용료는 이자", async () => {
    const { joinGlyphs } = await import("@/lib/accounts/statement");
    expect(joinGlyphs([{ str: "[입금]", x: 0, y: 1, w: 20 }, { str: "예탁금", x: 22, y: 1, w: 15 }, { str: "이용료입금", x: 37, y: 1, w: 25 }])).toEqual([{ str: "[입금] 예탁금이용료입금", x: 0, y: 1, w: 62 }]);
  });
});
