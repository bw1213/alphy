import type { DataResponse } from "./server";

/** 시세가 요청한 종료일보다 한참 전에 끝난 종목 (데이터가 끊긴 경우) */
export function staleWarnings(d: Pick<DataResponse, "data" | "names">, end: string, now = new Date().toISOString().slice(0, 10)): string[] {
  const until = end < now ? end : now;
  const out: string[] = [];
  for (const [t, bars] of Object.entries(d.data)) {
    const last = bars.at(-1)?.date;
    if (!last) continue;
    const gap = (Date.parse(until) - Date.parse(last)) / 864e5;
    if (gap > 10) out.push(`${d.names[t] ?? t}(${t}) 시세가 ${last}까지만 있습니다. 그 뒤로는 거래·평가가 마지막 가격에 멈춰 있습니다(상장폐지·거래정지이거나 데이터 받기에 실패했을 수 있습니다).`);
  }
  return out;
}
