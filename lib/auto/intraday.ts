import fs from "fs";
import { checkOrderLimit } from "../kis/limits";
import { acctFile, KIS_ID, OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import type { EveningReport, SellLevel } from "./evening";
import { applyFills, pickReport, type Broker, type ItemStatus, type MorningLimits } from "./morning";
import { intradayOn, REAL_NOT_CONFIRMED, type AutoPlan } from "./store";
import { sessionOn } from "./calendar";
import { clockOf, isMixed, krSession, marketOf, reportMarkets, US_SESSION, type Market, type Session } from "./session";
import { withCode } from "../strategies/universe";

type Env = Record<string, string | undefined>;

export const WATCH_FROM = "09:00";
export const WATCH_UNTIL = "15:20";
const FOLLOW_MS = 60_000;
const MAX_DAYS = 30;

export interface IntradaySell {
  keys: string[];
  ticker: string;
  name: string;
  kind: SellLevel["kind"];
  level: number;
  seen: number;
  qty: number;
  status: ItemStatus;
  orderNo?: string;
  orgNo?: string;
  filledQty: number;
  avgPrice: number;
  label: string;
  at: string;
  error?: string;
  told?: boolean;
}

export interface IntradayDay {
  date: string;
  reportDate?: string;
  label: string;
  env?: "real" | "mock";
  market?: Market;
  fx?: number;
  levels: SellLevel[];
  sells: IntradaySell[];
  last?: Record<string, { price: number; at: string }>;
  reason?: string;
  done?: boolean;
  lastFollow?: number;
  log: string[];
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
export const money = (m: Market | undefined, n: number) => (m === "US" ? `$${n.toFixed(2)}` : won(n));
export const levelPrice = (l: SellLevel) => l.usd ?? l.price;
const sessionOf = (d: Pick<IntradayDay, "market" | "date">): Session => sessionOn(d.market === "US" ? US_SESSION : krSession({ morning: "08:40", cutoff: "10:00" }), d.date);
export const levelKey = (l: Pick<SellLevel, "ticker" | "kind" | "price">) => `${l.ticker}:${l.kind}:${l.price}`;

type DaysFile = Record<string, IntradayDay>;
export function loadIntradayDays(user: string = OWNER_ID, e: Env = process.env, acct: string = KIS_ID): DaysFile {
  try { const j = JSON.parse(fs.readFileSync(userFile(acctFile("auto-intraday.json", acct), user, e), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
export function loadIntradayDay(date: string, user: string = OWNER_ID, e: Env = process.env, market: Market = "KR", acct: string = KIS_ID): IntradayDay | null {
  const all = loadIntradayDays(user, e, acct);
  const d = all[market === "US" ? `${date}:US` : date] ?? (market === "US" && all[date]?.market === "US" ? all[date] : null);
  return d && (d.market ?? "KR") === market ? d : null;
}
export function saveIntradayDay(d: IntradayDay, user: string = OWNER_ID, e: Env = process.env, acct: string = KIS_ID) {
  const all = { ...loadIntradayDays(user, e, acct), [d.market === "US" ? `${d.date}:US` : d.date]: d };
  const keep = Object.keys(all).sort().slice(-MAX_DAYS);
  writeUserFile(acctFile("auto-intraday.json", acct), JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))), user, e);
}

export async function intradayStart(plan: AutoPlan, log: EveningReport[], b: Broker, now: number, market: Market = "KR"): Promise<IntradayDay> {
  const k = clockOf(market, now);
  const d: IntradayDay = { date: k.date, label: plan.label, env: b.env, ...(market === "US" ? { market } : {}), levels: [], sells: [], log: [] };
  const off = (reason: string): IntradayDay => ({ ...d, done: true, reason, log: [`${k.hm} ${reason}`] });
  if (!plan.enabled) return off("운용이 꺼져 있습니다.");
  if (!intradayOn(plan)) return off("장중 실시간 매도가 꺼져 있습니다.");
  let open: boolean | null = null;
  try { open = await b.openDay(k.date); } catch { }
  if (open === false) return off("오늘은 휴장일입니다.");
  if (b.env === "real" && !plan.realConfirmedAt) return off(REAL_NOT_CONFIRMED);
  const { report, reason } = pickReport(log, plan, k.date, market === "US" || isMixed(plan), market);
  if (!report) return off(reason!);
  if (!reportMarkets(report).includes(market)) return off("계산 결과와 운용 종목의 시장이 달라 오늘은 감시하지 않습니다.");
  const levels = report.sellLevels.filter((l) => reportMarkets(report).length < 2 || marketOf(l.ticker) === market);
  if (market === "US" && levels.some((l) => !(l.usd! > 0))) return off("환율을 몰라 매도 가격을 달러로 바꾸지 못했습니다.");
  if (report.fx) d.fx = report.fx;
  d.reportDate = report.runDate;
  if (!report.intraday) return off(`${report.runDate} 계산은 장중 매도 없이 계산됐습니다. 다음 계산부터 적용됩니다.`);
  if (!levels.length) return off("오늘은 감시할 매도 가격이 없습니다.");
  d.levels = levels;
  d.log.push(`${k.hm} 감시 시작: ${levels.map((l) => `${withCode(l.name, l.ticker)} ${money(market, levelPrice(l))} ${l.kind === "take_profit" ? "이상" : "이하"}`).join(", ")}`);
  return d;
}

export function triggered(d: IntradayDay, ticker: string, price: number): { kind: SellLevel["kind"]; levels: SellLevel[] } | null {
  const used = new Set(d.sells.flatMap((s) => s.keys));
  const open = d.levels.filter((l) => l.ticker === ticker && !used.has(levelKey(l)));
  const sl = open.find((l) => l.kind === "stop_loss" && price <= levelPrice(l));
  if (sl) return { kind: "stop_loss", levels: [sl] };
  const tp = open.find((l) => l.kind === "take_profit" && price >= levelPrice(l));
  if (tp) return { kind: "take_profit", levels: [tp] };
  const drops = open.filter((l) => l.kind === "drop" && price <= levelPrice(l)).sort((a, b) => b.price - a.price);
  return drops.length ? { kind: "drop", levels: drops } : null;
}

export async function intradayCheck(d: IntradayDay, b: Broker, now: number, lim: MorningLimits = {}): Promise<{ day: IntradayDay; messages: string[] }> {
  const msgs: string[] = [];
  if (d.done) return { day: d, messages: msgs };
  const hm = clockOf(d.market ?? "KR", now).hm;
  const ses = sessionOf(d);
  const krw = (usdOrWon: number) => (d.market === "US" ? usdOrWon * (d.fx ?? 0) : usdOrWon);
  const head = `[알피] ${d.date} ${d.market === "US" ? "미국 " : ""}장중 매도 · ${d.label} (${d.env === "real" ? "실전" : "모의투자"})`;

  if (hm >= ses.watchFrom && hm < ses.watchUntil && b.quote) {
    const used = new Set(d.sells.flatMap((s) => s.keys));
    const tickers = [...new Set(d.levels.filter((l) => !used.has(levelKey(l))).map((l) => l.ticker))];
    let held: Map<string, number> | null = null;
    for (const t of tickers) {
      let price = 0;
      try { price = await b.quote(t); } catch (err) { d.log.push(`${hm} ${t} 현재가 조회 실패: ${(err as Error).message}`); continue; }
      if (!(price > 0)) continue;
      (d.last ??= {})[t] = { price, at: hm };
      const hit = triggered(d, t, price);
      if (!hit) continue;
      if (!held) {
        try { held = new Map((await b.balance()).holdings.map((h) => [h.code, h.sellable ?? h.qty])); }
        catch (err) { d.log.push(`${hm} 잔고 조회 실패: ${(err as Error).message}`); break; }
      }
      const have = held.get(t) ?? 0;
      const top = hit.levels[0];
      const allOut = hit.kind !== "drop";
      const keys = allOut ? d.levels.filter((l) => l.ticker === t).map(levelKey) : hit.levels.map(levelKey);
      const want = allOut ? have : hit.levels.reduce((a, l) => a + (l.qty ?? 0), 0);
      const qty = Math.min(want, have);
      const s: IntradaySell = { keys, ticker: t, name: top.name, kind: hit.kind, level: hit.kind === "drop" ? hit.levels.at(-1)!.price : top.price, seen: price,
        qty, status: "waiting", filledQty: 0, avgPrice: 0, label: hit.levels.map((l) => l.label).join(", "), at: hm };
      if (d.market === "US") s.level = levelPrice(hit.kind === "drop" ? hit.levels.at(-1)! : top);
      d.sells.push(s);
      const how = d.market === "US" ? "지정가(현재가 -1%)" : "시장가";
      const what = `${withCode(top.name, t)} 현재가 ${money(d.market, price)}가 ${money(d.market, s.level)} ${hit.kind === "take_profit" ? "이상" : "이하"}(${s.label})`;
      if (qty <= 0) {
        Object.assign(s, { status: "skipped", error: "계좌에 팔 주식이 없습니다." });
        d.log.push(`${hm} ${what}: 팔 주식이 없어 건너뜀`);
        msgs.push(`${head}\n${what}에 닿았지만 계좌에 팔 주식이 없습니다.`);
        continue;
      }
      try {
        if (b.env === "real" && lim.orderLimit) checkOrderLimit(krw(qty * price), lim.orderLimit, lim.usedToday?.() ?? 0);
        const res = await b.place({ code: t, side: "sell", qty, type: "market" });
        if (b.env === "real") { try { lim.addUsage?.(krw(qty * price)); } catch { } }
        Object.assign(s, { status: "placed", orderNo: res.orderNo, orgNo: res.orgNo });
        held.set(t, have - qty);
        d.log.push(`${hm} ${what} → ${qty}주 ${how} 매도 (주문번호 ${res.orderNo})`);
        msgs.push(`${head}\n${what}에 닿아 ${qty}주 ${how}로 팔았습니다.${qty < want && !allOut ? ` (계좌에 ${have}주만 있음)` : ""}`);
      } catch (err) {
        Object.assign(s, { status: "failed", error: (err as Error).message });
        d.log.push(`${hm} ${what} → 매도 실패: ${(err as Error).message}`);
        msgs.push(`${head}\n${what}에 닿았지만 주문하지 못했습니다: ${(err as Error).message}`);
      }
    }
  }

  const openSells = d.sells.filter((s) => s.status === "placed" || s.status === "partial");
  if (openSells.length && now - (d.lastFollow ?? 0) >= FOLLOW_MS) {
    d.lastFollow = now;
    try { applyFills({ items: d.sells }, await b.orders(d.date)); } catch (err) { d.log.push(`${hm} 체결 조회 실패: ${(err as Error).message}`); }
    for (const s of d.sells) {
      if (s.told || !s.orderNo || !(s.status === "filled" || s.status === "cancelled" || hm >= ses.close)) continue;
      s.told = true;
      msgs.push(`${head}\n${withCode(s.name, s.ticker)} ${s.qty}주 중 ${s.filledQty}주 체결${s.filledQty ? `, 평균 ${money(d.market, s.avgPrice)}` : ""}.`);
    }
  }

  if (hm >= ses.close && !d.sells.some((s) => s.orderNo && !s.told)) {
    d.done = true;
    d.reason = d.sells.length ? `오늘 장중 매도 ${d.sells.filter((s) => s.orderNo).length}건` : "오늘은 매도 가격에 닿지 않았습니다.";
    d.log.push(`${hm} 감시 끝: ${d.reason}`);
  }
  return { day: d, messages: msgs };
}
