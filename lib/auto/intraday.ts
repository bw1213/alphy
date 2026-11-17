/**
 * 장중 실시간 매도 (서버 전용).
 *
 * 평일 09:00~15:20 (한국 시간) 동안 몇 초마다 현재가를 보고, 어제 저녁 계산이 정한 매도 가격(sellLevels)에 닿으면
 * 바로 시장가로 판다. 백테스트도 같은 규칙(그날 저가·고가가 가격에 닿으면 그 가격에 판 것)으로 계산한다.
 *   - 하락 매도(적립·분할 매도 전략): 현재가 ≤ 가격 → 저녁 계산이 정한 수량 (계좌에 있는 만큼)
 *   - 손절: 현재가 ≤ 가격 → 그 종목 전부 / 익절: 현재가 ≥ 가격 → 그 종목 전부
 *   - 같은 가격으로는 하루 한 번만 판다. 손절·익절로 다 팔면 그 종목의 다른 가격은 그날 끝.
 *
 * 그날 한 일은 users/<사용자>/auto-intraday.json 에 남겨, 앱이 다시 켜져도 같은 가격으로 두 번 팔지 않는다.
 */
import fs from "fs";
import { checkOrderLimit } from "../kis/limits";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import type { EveningReport, SellLevel } from "./evening";
import { applyFills, pickReport, type Broker, type ItemStatus, type MorningLimits } from "./morning";
import { intradayOn, REAL_NOT_CONFIRMED, type AutoPlan } from "./store";
import { clockOf, krSession, US_SESSION, type Market, type Session } from "./session";

type Env = Record<string, string | undefined>;

export const WATCH_FROM = "09:00";
/** 이 시각부터는 새로 팔지 않음 (15:20~15:30 은 종가 동시호가) */
export const WATCH_UNTIL = "15:20";
/** 체결 확인 간격 */
const FOLLOW_MS = 60_000;
const MAX_DAYS = 30;

export interface IntradaySell {
  /** 이 주문으로 처리한 매도 가격들 (같은 가격으로 두 번 팔지 않으려고) */
  keys: string[];
  ticker: string;
  name: string;
  kind: SellLevel["kind"];
  /** 닿은 매도 가격 */
  level: number;
  /** 닿았을 때 현재가 */
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
  /** 체결 알림을 보냈는지 */
  told?: boolean;
}

export interface IntradayDay {
  date: string;
  reportDate?: string;
  label: string;
  env?: "real" | "mock";
  /** 미국이면 date·시각이 뉴욕 기준이고 가격은 달러 (없으면 한국) */
  market?: Market;
  /** 미국: 저녁 계산 때 환율 (주문 금액 한도를 원화로 따질 때) */
  fx?: number;
  /** 감시하는 가격 (저녁 계산에서 가져옴) */
  levels: SellLevel[];
  sells: IntradaySell[];
  /** 종목별 마지막 현재가 */
  last?: Record<string, { price: number; at: string }>;
  /** 감시 안 함 / 끝남 이유 */
  reason?: string;
  done?: boolean;
  lastFollow?: number;
  log: string[];
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
/** 그 시장의 돈 표기: 미국은 달러 */
export const money = (m: Market | undefined, n: number) => (m === "US" ? `$${n.toFixed(2)}` : won(n));
/** 현재가와 비교할 가격: 미국은 달러로 바꾼 값 */
export const levelPrice = (l: SellLevel) => l.usd ?? l.price;
const sessionOf = (d: Pick<IntradayDay, "market">): Session => (d.market === "US" ? US_SESSION : krSession({ morning: "08:40", cutoff: "10:00" }));
export const levelKey = (l: Pick<SellLevel, "ticker" | "kind" | "price">) => `${l.ticker}:${l.kind}:${l.price}`;

// ---------------- 저장 ----------------
type DaysFile = Record<string, IntradayDay>;
export function loadIntradayDays(user: string = OWNER_ID, e: Env = process.env): DaysFile {
  try { const j = JSON.parse(fs.readFileSync(userFile("auto-intraday.json", user, e), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
export function loadIntradayDay(date: string, user: string = OWNER_ID, e: Env = process.env, market: Market = "KR"): IntradayDay | null {
  const all = loadIntradayDays(user, e);
  const d = all[market === "US" ? `${date}:US` : date] ?? (market === "US" && all[date]?.market === "US" ? all[date] : null);
  return d && (d.market ?? "KR") === market ? d : null;
}
export function saveIntradayDay(d: IntradayDay, user: string = OWNER_ID, e: Env = process.env) {
  const all = { ...loadIntradayDays(user, e), [d.market === "US" ? `${d.date}:US` : d.date]: d };
  const keep = Object.keys(all).sort().slice(-MAX_DAYS);
  writeUserFile("auto-intraday.json", JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))), user, e);
}

/** 그날 처음: 어느 저녁 계산의 가격을 감시할지 정함 */
export async function intradayStart(plan: AutoPlan, log: EveningReport[], b: Broker, now: number, market: Market = "KR"): Promise<IntradayDay> {
  const k = clockOf(market, now);
  const d: IntradayDay = { date: k.date, label: plan.label, env: b.env, ...(market === "US" ? { market } : {}), levels: [], sells: [], log: [] };
  const off = (reason: string): IntradayDay => ({ ...d, done: true, reason, log: [`${k.hm} ${reason}`] });
  if (!plan.enabled) return off("운용이 꺼져 있습니다.");
  if (!intradayOn(plan)) return off("장중 실시간 매도가 꺼져 있습니다.");
  if (b.env === "real" && !plan.realConfirmedAt) return off(REAL_NOT_CONFIRMED);
  const { report, reason } = pickReport(log, plan, k.date, market === "US");
  if (!report) return off(reason!);
  if ((report.market ?? "KR") !== market) return off("저녁 계산과 운용 종목의 시장이 달라 오늘은 감시하지 않습니다.");
  if (market === "US" && report.sellLevels.some((l) => !(l.usd! > 0))) return off("환율을 몰라 매도 가격을 달러로 바꾸지 못했습니다.");
  if (report.fx) d.fx = report.fx;
  d.reportDate = report.runDate;
  if (!report.intraday) return off(`${report.runDate} 저녁 계산은 장중 매도 없이 계산됐습니다. 오늘 저녁 계산부터 적용됩니다.`);
  if (!report.sellLevels.length) return off("오늘은 감시할 매도 가격이 없습니다.");
  let open: boolean | null = null;
  try { open = await b.openDay(k.date); } catch { /* 모르면 진행 */ }
  if (open === false) return off("오늘은 휴장일입니다.");
  d.levels = report.sellLevels;
  d.log.push(`${k.hm} 감시 시작: ${report.sellLevels.map((l) => `${l.name} ${money(market, levelPrice(l))} ${l.kind === "take_profit" ? "이상" : "이하"}`).join(", ")}`);
  return d;
}

/** 아직 처리 안 한 가격 중 지금 가격에 닿은 것: 종목별로 한 주문에 묶음 */
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

/**
 * 몇 초마다: 현재가 확인 → 닿은 가격이면 시장가 매도, 1분마다 체결 확인.
 * 돌려주는 messages 는 텔레그램으로 보낼 글.
 */
export async function intradayCheck(d: IntradayDay, b: Broker, now: number, lim: MorningLimits = {}): Promise<{ day: IntradayDay; messages: string[] }> {
  const msgs: string[] = [];
  if (d.done) return { day: d, messages: msgs };
  const hm = clockOf(d.market ?? "KR", now).hm;
  const ses = sessionOf(d);
  // 주문 금액 한도는 원화로 따짐
  const krw = (usdOrWon: number) => (d.market === "US" ? usdOrWon * (d.fx ?? 0) : usdOrWon);
  const head = `[알피] ${d.date} ${d.market === "US" ? "미국 " : ""}장중 매도 · ${d.label} (${d.env === "real" ? "실전" : "모의투자"})`;

  // 1) 새 매도
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
      // 손절·익절이면 그 종목 가격들은 오늘 모두 끝
      const keys = allOut ? d.levels.filter((l) => l.ticker === t).map(levelKey) : hit.levels.map(levelKey);
      const want = allOut ? have : hit.levels.reduce((a, l) => a + (l.qty ?? 0), 0);
      const qty = Math.min(want, have);
      const s: IntradaySell = { keys, ticker: t, name: top.name, kind: hit.kind, level: hit.kind === "drop" ? hit.levels.at(-1)!.price : top.price, seen: price,
        qty, status: "waiting", filledQty: 0, avgPrice: 0, label: hit.levels.map((l) => l.label).join(", "), at: hm };
      if (d.market === "US") s.level = levelPrice(hit.kind === "drop" ? hit.levels.at(-1)! : top);
      d.sells.push(s);
      const how = d.market === "US" ? "지정가(현재가 -1%)" : "시장가";
      const what = `${top.name} 현재가 ${money(d.market, price)}가 ${money(d.market, s.level)} ${hit.kind === "take_profit" ? "이상" : "이하"}(${s.label})`;
      if (qty <= 0) {
        Object.assign(s, { status: "skipped", error: "계좌에 팔 주식이 없습니다." });
        d.log.push(`${hm} ${what}: 팔 주식이 없어 건너뜀`);
        msgs.push(`${head}\n${what}에 닿았지만 계좌에 팔 주식이 없습니다.`);
        continue;
      }
      try {
        if (b.env === "real" && lim.orderLimit) checkOrderLimit(krw(qty * price), lim.orderLimit, lim.usedToday?.() ?? 0);
        const res = await b.place({ code: t, side: "sell", qty, type: "market" });
        if (b.env === "real") { try { lim.addUsage?.(krw(qty * price)); } catch { /* 합계 저장 실패는 주문에 영향 없음 */ } }
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

  // 2) 체결 확인 (1분마다)
  const openSells = d.sells.filter((s) => s.status === "placed" || s.status === "partial");
  if (openSells.length && now - (d.lastFollow ?? 0) >= FOLLOW_MS) {
    d.lastFollow = now;
    try { applyFills({ items: d.sells }, await b.orders(d.date)); } catch (err) { d.log.push(`${hm} 체결 조회 실패: ${(err as Error).message}`); }
    for (const s of d.sells) {
      if (s.told || !s.orderNo || !(s.status === "filled" || s.status === "cancelled" || hm >= ses.close)) continue;
      s.told = true;
      msgs.push(`${head}\n${s.name} ${s.qty}주 중 ${s.filledQty}주 체결${s.filledQty ? `, 평균 ${money(d.market, s.avgPrice)}` : ""}.`);
    }
  }

  // 3) 장 끝: 체결 확인까지 끝나면 그날 끝
  if (hm >= ses.close && !d.sells.some((s) => s.orderNo && !s.told)) {
    d.done = true;
    d.reason = d.sells.length ? `오늘 장중 매도 ${d.sells.filter((s) => s.orderNo).length}건` : "오늘은 매도 가격에 닿지 않았습니다.";
    d.log.push(`${hm} 감시 끝: ${d.reason}`);
  }
  return { day: d, messages: msgs };
}
