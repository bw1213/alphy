import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PdfPasswordError, parseHanwha, readPdfText, toLedgerTsv } from "@/lib/accounts/statement";
import { parseLedgerText } from "@/lib/accounts/ledger";

const file = () => new Uint8Array(readFileSync(path.join(__dirname, "fixtures/hanwha-statement-locked.pdf")));

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
