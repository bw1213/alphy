/**
 * 지난 기록 지우기 (서버 전용): 지금 운용 전략을 저장하기 전의 저녁 계산 기록과, 끝난 아침 주문·장중 감시 기록을 지운다.
 * 아직 진행 중인 주문(주문됨·매도 체결 기다림)과 감시 중인 날은 남긴다. 성과 기록은 운용을 바꾸면 이미 새로 시작하므로 건드리지 않는다.
 */
import { acctFile, KIS_ID, OWNER_ID, writeUserFile } from "../settings/userdir";
import { loadLog } from "./store";
import { loadDays } from "./morning";
import { loadIntradayDays } from "./intraday";

type Env = Record<string, string | undefined>;

export function clearOldRecords(before: string, user: string = OWNER_ID, e: Env = process.env, acct: string = KIS_ID): { log: number; days: number; intraday: number } {
  const log = loadLog(user, e, acct);
  const keepLog = log.filter((r) => r.ranAt >= before);
  writeUserFile(acctFile("auto-log.json", acct), JSON.stringify(keepLog), user, e);

  const days = loadDays(user, e, acct);
  const keepDays = Object.fromEntries(Object.entries(days).filter(([, d]) => d.phase === "placed" || d.phase === "buying"));
  writeUserFile(acctFile("auto-orders.json", acct), JSON.stringify(keepDays), user, e);

  const intra = loadIntradayDays(user, e, acct);
  const keepIntra = Object.fromEntries(Object.entries(intra).filter(([, d]) => !d.done));
  writeUserFile(acctFile("auto-intraday.json", acct), JSON.stringify(keepIntra), user, e);

  return { log: log.length - keepLog.length, days: Object.keys(days).length - Object.keys(keepDays).length, intraday: Object.keys(intra).length - Object.keys(keepIntra).length };
}
