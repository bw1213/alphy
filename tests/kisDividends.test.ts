import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exDateFromRecord, mergeDividends, parseKisDividends, parseKisUsRights, toEngineDividends, toEngineUsDividends, usSettleDays,
} from "@/lib/kis/dividends";
import type { Bar } from "@/lib/engine/types";

const bars = (dates: string[], close = 100): Bar[] => dates.map((date) => ({ date, open: close, high: close, low: close, close, volume: 10 }));

describe("한국투자증권 배당 → 엔진 배당", () => {
  it("예탁원 응답: 현금배당 있는 줄만, 기준일 YYYY-MM-DD", () => {
    const rows = parseKisDividends([
      { record_date: "20250630", sht_cd: "005930", per_sto_divi_amt: "367", divi_kind: "분기", divi_pay_dt: "20250820" },
      { record_date: "20241231", sht_cd: "005930", per_sto_divi_amt: "1,446", divi_kind: "결산", divi_pay_dt: "20250417" },
      { record_date: "20241231", sht_cd: "005930", per_sto_divi_amt: "1,446", divi_kind: "결산", divi_pay_dt: "20250417" }, // 페이지 겹침
      { record_date: "20240331", sht_cd: "000660", per_sto_divi_amt: "300" }, // 다른 종목
      { record_date: "20230331", sht_cd: "005930", per_sto_divi_amt: "0" },
    ], "005930");
    expect(rows).toEqual([
      { recordDate: "2024-12-31", amount: 1446, kind: "결산", payDate: "2025-04-17" },
      { recordDate: "2025-06-30", amount: 367, kind: "분기", payDate: "2025-08-20" },
    ]);
  });

  it("배당락일 = 결제(T+2)가 기준일을 넘는 첫 거래일", () => {
    // 2025-06-30(월) 기준일 → 06-27(금) 배당락
    expect(exDateFromRecord("2025-06-30", ["2025-06-26", "2025-06-27", "2025-06-30", "2025-07-01"])).toBe("2025-06-27");
    // 연말: 12-31 휴장·마지막 거래일 12-28 → 12-27 배당락 (2023년 실제와 같음)
    expect(exDateFromRecord("2023-12-31", ["2023-12-26", "2023-12-27", "2023-12-28", "2024-01-02"])).toBe("2023-12-27");
    // 기준일 뒤 거래일이 아직 없으면 null
    expect(exDateFromRecord("2025-06-30", ["2025-06-27", "2025-06-30"])).toBeNull();
  });

  it("액면분할 전 배당은 그 달 수정 종가 ÷ 원주가 비율로 줄인다", () => {
    const b = [...bars(["2017-12-26", "2017-12-27", "2017-12-28", "2018-01-02"], 50_000), ...bars(["2025-06-26", "2025-06-27", "2025-06-30", "2025-07-01"], 60_000)];
    const rows = [
      { recordDate: "2017-12-31", amount: 21_000, kind: "결산", payDate: "" },
      { recordDate: "2025-06-30", amount: 367, kind: "분기", payDate: "" },
      { recordDate: "2025-03-31", amount: 365, kind: "분기", payDate: "" }, // 시세 없음 → 날짜 없음
    ];
    const raw = { "2017-12": 2_500_000, "2025-06": 60_000 }; // 50:1 분할 전
    const t = toEngineDividends(rows, b, raw);
    expect(t.divs).toEqual([{ date: "2017-12-27", amount: 420 }, { date: "2025-06-27", amount: 367 }]);
    expect(t.skipped).toBe(0);
    expect(toEngineDividends([rows[1]], b, {}).skipped).toBe(1);
  });

  it("한국투자증권 기록이 시작되기 전만 Yahoo 로 채운다", () => {
    const m = mergeDividends([{ date: "2015-04-28", amount: 10 }, { date: "2016-04-27", amount: 12 }],
      [{ date: "2013-04-26", amount: 7 }, { date: "2014-04-28", amount: 8 }, { date: "2015-04-29", amount: 99 }]);
    expect(m.divs.map((d) => d.amount)).toEqual([7, 8, 10, 12]);
    expect(m.fromYahoo).toBe(2);
    expect(mergeDividends([], [{ date: "2014-04-28", amount: 8 }]).divs).toHaveLength(1);
  });
});

describe("미국 주식 배당 (해외주식 권리)", () => {
  it("배당·특별배당만, 같은 기준일은 합침", () => {
    const rows = parseKisUsRights([
      { rght_type_cd: "03", pdno: "AAPL", acpl_bass_dt: "20251110", alct_frcr_unpr: "0.26" },
      { rght_type_cd: "75", pdno: "AAPL", acpl_bass_dt: "20251110", alct_frcr_unpr: "1.00" },
      { rght_type_cd: "14", pdno: "AAPL", acpl_bass_dt: "20200828", alct_frcr_unpr: "0" },
      { rght_type_cd: "03", pdno: "AAPL", acpl_bass_dt: "20200810", alct_frcr_unpr: "0.82" },
    ], "AAPL");
    expect(rows.map((r) => [r.recordDate, r.amount])).toEqual([["2020-08-10", 0.82], ["2025-11-10", 1.26]]);
  });

  it("결제: 2024-05-28 부터 T+1(배당락=기준일), 그 전 T+2", () => {
    expect(usSettleDays("2024-05-31")).toBe(1);
    expect(usSettleDays("2024-03-15")).toBe(2);
    const dates = ["2020-08-06", "2020-08-07", "2020-08-10", "2020-08-11", "2025-11-07", "2025-11-10", "2025-11-11"];
    const d = toEngineUsDividends([
      { recordDate: "2020-08-10", amount: 0.82, kind: "배당", payDate: "" },
      { recordDate: "2025-11-10", amount: 0.26, kind: "배당", payDate: "" },
    ], dates, [{ date: "2020-08-31", ratio: 4 }]);
    // 2020년 배당은 4:1 분할 전이라 1/4
    expect(d).toEqual([{ date: "2020-08-07", amount: 0.205 }, { date: "2025-11-10", amount: 0.26 }]);
  });
});

describe("loadData: 한국투자증권 배당 우선", () => {
  const cwd = process.cwd();
  afterEach(() => { process.chdir(cwd); vi.unstubAllGlobals(); vi.resetModules(); });

  it("한국투자증권 배당이 있으면 쓰고, 그 전 기간은 Yahoo, 실패하면 Yahoo 만", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "alphy-kisdiv-"));
    process.chdir(dir);
    const ds: string[] = [];
    for (const d = new Date("2022-01-03T00:00:00Z"); ds.length < 700; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) ds.push(d.toISOString().slice(0, 10));
    const xml = ds.map((d) => `<item data="${d.replace(/-/g, "")}|100|100|100|100|10" />`).join("");
    const ts = (d: string) => Date.parse(d + "T00:00:00Z") / 1000;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/oauth2/tokenP") return new Response(JSON.stringify({ access_token: "T", expires_in: 86400 }));
      if (u.pathname.endsWith("/ksdinfo/dividend")) {
        const code = u.searchParams.get("SHT_CD");
        calls.push(`div ${code}`);
        if (code === "222220") return new Response(JSON.stringify({ rt_cd: "1", msg_cd: "X", msg1: "조회 오류" }));
        return new Response(JSON.stringify({ rt_cd: "0", output1: [{ record_date: "20230630", sht_cd: code, per_sto_divi_amt: "300" }] }));
      }
      if (u.pathname.endsWith("/inquire-daily-itemchartprice")) {
        calls.push(`raw ${u.searchParams.get("FID_PERIOD_DIV_CODE")}${u.searchParams.get("FID_ORG_ADJ_PRC")}`);
        return new Response(JSON.stringify({ rt_cd: "0", output2: [{ stck_bsop_date: "20230630", stck_clpr: "100" }] }));
      }
      if (url.includes("yahoo.com")) {
        const ev = { a: { amount: 5, date: ts("2022-04-28") }, b: { amount: 7, date: ts("2023-06-29") } };
        return new Response(JSON.stringify({ chart: { result: [{ meta: { gmtoffset: 0 }, events: { dividends: ev } }] } }));
      }
      return new Response(xml);
    }));
    try {
      vi.resetModules();
      const { loadData } = await import("@/lib/data/server");
      const cred = { env: "real" as const, appKey: "K", appSecret: "S" };
      const r = await loadData({ source: "naver", start: "2022-01-03", end: "2024-09-30", tickers: ["111110", "222220"] }, { kisDividendCred: cred });
      // 111110: 한국투자증권 2023-06-30(금) 기준일 → 06-29 배당락, 그 전 2022 Yahoo 배당은 채움, 2023 Yahoo 는 버림
      expect(r.dividends!["111110"]).toEqual([{ date: "2022-04-28", amount: 5 }, { date: "2023-06-29", amount: 300 }]);
      // 222220: 한국투자증권 실패 → Yahoo 그대로
      expect(r.dividends!["222220"]).toEqual([{ date: "2022-04-28", amount: 5 }, { date: "2023-06-29", amount: 7 }]);
      expect(calls).toContain("raw M1");
      const w = r.warnings.join(" ");
      expect(w).toMatch(/한국투자증권 \+ 그 이전 기간은 Yahoo 1종목/);
      expect(w).toMatch(/Yahoo Finance 1종목/);
      expect(w).toMatch(/일부 실패.*222220/);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
