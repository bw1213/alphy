import { tradingDay } from "../market/holidays";
import type { Session } from "./session";

type Env = Record<string, string | undefined>;

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const later = (hm: string, n: number) => toHm(toMin(hm) + n);

/** 그날 장 시작이 늦거나(한국 새해 첫날 10시) 일찍 끝나면(미국 13시) 주문·감시 시각을 맞춤 */
export function sessionOn(ses: Session, date: string, e: Env = process.env): Session {
  const t = tradingDay(ses.market, date, e);
  let s = ses;
  if (t.openAt) {
    const n = toMin(t.openAt) - toMin(ses.watchFrom);
    if (n > 0) s = { ...s, followFrom: later(s.followFrom, n), buyFrom: later(s.buyFrom, n), buyBy: later(s.buyBy, n), cutoff: later(s.cutoff, n), watchFrom: later(s.watchFrom, n) };
  }
  if (t.closeAt && t.closeAt < s.close) {
    s = { ...s, close: t.closeAt, watchUntil: later(t.closeAt, -10), cutoff: s.cutoff < t.closeAt ? s.cutoff : later(t.closeAt, -30) };
  } else if (t.closeAt && t.closeAt > s.close) {
    const n = toMin(t.closeAt) - toMin(s.close);
    s = { ...s, close: t.closeAt, watchUntil: later(s.watchUntil, n) };
  }
  return s;
}
