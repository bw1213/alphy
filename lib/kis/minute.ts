/**
 * 국내 종목 1분봉 (주식일별분봉조회 FHKST03010230).
 * 한 번에 120건, 기준 시각부터 과거로. 한국투자증권 서버는 최근 1년치만 보관합니다.
 */
import type { KisClient } from "./client";

/** [시각 HHMM, 시가, 고가, 저가, 종가, 거래량] */
export type MinuteBar = [number, number, number, number, number, number];

const num = (s: unknown) => Number(String(s ?? "").replace(/,/g, ""));

export function parseMinuteRows(rows: any[] | undefined, date: string): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (const r of rows ?? []) {
    if (String(r?.stck_bsop_date ?? "") !== date) continue;
    const t = String(r?.stck_cntg_hour ?? "");
    if (!/^\d{6}$/.test(t)) continue;
    const c = num(r.stck_prpr);
    if (!(c > 0)) continue;
    const o = num(r.stck_oprc) || c, h = num(r.stck_hgpr) || c, l = num(r.stck_lwpr) || c;
    out.push([Number(t.slice(0, 4)), o, Math.max(h, o, c), Math.min(l, o, c), c, num(r.cntg_vol) || 0]);
  }
  return out;
}

/** 하루치 1분봉 (오름차순). date = YYYYMMDD. 보관 기간이 지나면 빈 배열 */
export async function kisMinuteDay(client: KisClient, code: string, date: string): Promise<MinuteBar[]> {
  const byTime = new Map<number, MinuteBar>();
  let hour = "163000";
  for (let page = 0; page < 12; page++) {
    const { body } = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice",
      trId: "FHKST03010230",
      query: {
        FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code,
        FID_INPUT_HOUR_1: hour, FID_INPUT_DATE_1: date,
        FID_PW_DATA_INCU_YN: "N", FID_FAKE_TICK_INCU_YN: "",
      },
    });
    const rows = (body.output2 as any[] | undefined) ?? [];
    const bars = parseMinuteRows(rows, date);
    for (const b of bars) byTime.set(b[0], b);
    if (!bars.length || bars.length < rows.length || rows.length < 120) break;
    const earliest = Math.min(...bars.map((b) => b[0]));
    if (earliest <= 900) break;
    const next = `${String(earliest).padStart(4, "0")}00`;
    if (next >= hour) break;
    hour = next;
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}
