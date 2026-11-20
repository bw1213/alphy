/** 단타 전략 찾기를 서버에서 돌리는 연결부 (한국투자증권 시세) */
import { cachedDaily, loadData } from "../data/server";
import { getClient } from "../kis/client";
import type { KisCredentials } from "../kis/config";
import { kisMinuteDay } from "../kis/minute";
import { allStocks, lookupCodes } from "../stocks/master";
import { cachedMinuteDays } from "./data";
import { runStudy, type IntradayRequest, type StudyDeps } from "./study";
import { runDayTrade, type DayTradeDeps, type DayTradeRequest } from "./daytrade";

export function kisStudyDeps(cred: KisCredentials): StudyDeps {
  const client = getClient(cred);
  return {
    async daily(tickers, start, end) {
      const d = await loadData({ source: "kis", tickers, start, end, dividends: false, indices: true }, { kisCred: cred });
      const dates = Object.fromEntries(Object.entries(d.data).map(([k, bars]) => [k, bars.map((b) => b.date)]));
      return { dates, names: d.names, indices: d.indices ?? [], warnings: d.warnings };
    },
    minute: (code, dates, onDay) => cachedMinuteDays(code, dates, (ymd) => kisMinuteDay(client, code, ymd), { onDay }),
    info(code) {
      try {
        const e = lookupCodes([code])[0];
        return { name: e?.name, etf: e?.type === "ETF" || e?.type === "ETN" };
      } catch { return { etf: false }; }
    },
  };
}

export function runKisStudy(req: IntradayRequest, cred: KisCredentials | null, onProgress?: (done: number, total: number) => void) {
  if (!cred) throw new Error("한국투자증권 앱키가 없어 분봉을 받을 수 없습니다. 설정 화면에서 넣어 주세요.");
  return runStudy(req, kisStudyDeps(cred), onProgress);
}

export function kisDayTradeDeps(cred: KisCredentials): DayTradeDeps {
  const client = getClient(cred);
  return {
    stocks: () => allStocks().all
      .filter((s) => (s.market === "KOSPI" || s.market === "KOSDAQ") && s.type === "주식" && /^[0-9A-Z]{6}$/.test(s.code) && !/스팩/.test(s.name))
      .map((s) => ({ code: s.code, name: s.name })),
    daily: (code, start) => cachedDaily(code, start),
    async calendar(start, end) {
      const d = await loadData({ source: "kis", tickers: ["069500"], start, end, dividends: false, indices: true }, { kisCred: cred });
      return { dates: (d.data["069500"] ?? []).map((b) => b.date), indices: d.indices ?? [] };
    },
    minute: async (code, date) => (await cachedMinuteDays(code, [date], (ymd) => kisMinuteDay(client, code, ymd)))[0]?.bars ?? [],
  };
}

export function runKisDayTrade(req: DayTradeRequest, cred: KisCredentials | null, onProgress?: (done: number, total: number) => void) {
  if (!cred) throw new Error("한국투자증권 앱키가 없어 분봉을 받을 수 없습니다. 설정 화면에서 넣어 주세요.");
  return runDayTrade(req, kisDayTradeDeps(cred), onProgress);
}
