/** 단타 전략 찾기를 서버에서 돌리는 연결부 (한국투자증권 시세) */
import { loadData } from "../data/server";
import { getClient } from "../kis/client";
import type { KisCredentials } from "../kis/config";
import { kisMinuteDay } from "../kis/minute";
import { lookupCodes } from "../stocks/master";
import { cachedMinuteDays } from "./data";
import { runStudy, type IntradayRequest, type StudyDeps } from "./study";

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
