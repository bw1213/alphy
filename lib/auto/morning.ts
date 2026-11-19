import fs from "fs";
import type { Balance, OrderRequest, OrderResult } from "../kis/trading";
import type { DayOrder } from "../kis/orders";
import type { OrderLimit } from "../settings/store";
import { checkOrderLimit } from "../kis/limits";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import type { EveningReport, Unfinished } from "./evening";
import { REAL_NOT_CONFIRMED, type AutoPlan } from "./store";
import { minusDays } from "./time";
import { clockOf, isMixed, marketOf, reportMarkets, US_SESSION, type Market } from "./session";
import { withCode } from "../strategies/universe";

type Env = Record<string, string | undefined>;

export type ItemStatus = "waiting" | "placed" | "partial" | "filled" | "cancelled" | "failed" | "skipped";

export interface MorningItem {
  ticker: string;
  name: string;
  side: "buy" | "sell";
  planned: number;
  qty: number;
  status: ItemStatus;
  orderNo?: string;
  orgNo?: string;
  filledQty: number;
  avgPrice: number;
  price: number;
  note?: string;
  error?: string;
  placedAt?: string;
  retry?: number;
}

export interface MorningDay {
  date: string;
  reportDate?: string;
  reportData?: string;
  label: string;
  env?: "real" | "mock";
  market?: Market;
  phase: "placed" | "buying" | "done" | "skipped" | "stopped";
  items: MorningItem[];
  log: string[];
  lastCheck?: number;
  notified?: boolean;
  reason?: string;
}

export interface Broker {
  env: "real" | "mock";
  balance(): Promise<Balance>;
  buyable(code: string, price: number): Promise<number>;
  place(o: OrderRequest): Promise<OrderResult>;
  orders(date: string): Promise<DayOrder[]>;
  cancel(o: { orderNo: string; orgNo: string }): Promise<string>;
  openDay(date: string): Promise<boolean | null>;
  quote?(code: string): Promise<number>;
}

export interface MorningLimits {
  realCap?: number;
  orderLimit?: OrderLimit;
  usedToday?: () => number;
  addUsage?: (amount: number) => void;
}

// 시장가 매수 금액 어림: 시가가 어제 종가보다 이만큼 높을 수 있음
export const BUY_GAP = 0.03;
const MAX_DAYS = 30;
const FINAL: ItemStatus[] = ["filled", "cancelled", "failed", "skipped"];
const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const hhmm = (now: number, m: Market = "KR") => clockOf(m, now).hm;

type OrdersFile = Record<string, MorningDay>;

export function loadDays(user: string = OWNER_ID, e: Env = process.env): OrdersFile {
  try { const j = JSON.parse(fs.readFileSync(userFile("auto-orders.json", user, e), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
export const dayKey = (date: string, market: Market = "KR") => (market === "US" ? `${date}:US` : date);
export function loadDay(date: string, user: string = OWNER_ID, e: Env = process.env, market: Market = "KR"): MorningDay | null {
  const all = loadDays(user, e);
  const d = all[dayKey(date, market)] ?? (market === "US" && all[date]?.market === "US" ? all[date] : null);
  return d && (d.market ?? "KR") === market ? d : null;
}
export function saveDay(d: MorningDay, user: string = OWNER_ID, e: Env = process.env) {
  const all = { ...loadDays(user, e), [dayKey(d.date, d.market)]: d };
  const keep = Object.keys(all).sort().slice(-MAX_DAYS);
  writeUserFile("auto-orders.json", JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))), user, e);
}

export function pickReport(log: EveningReport[], plan: AutoPlan, today: string, sameDay = false): { report: EveningReport | null; reason?: string } {
  const ok = log.filter((r) => r.status === "ok" && (sameDay ? r.runDate <= today : r.runDate < today) && r.runDate >= minusDays(today, 4))
    .sort((a, b) => (a.runDate === b.runDate ? b.ranAt.localeCompare(a.ranAt) : b.runDate.localeCompare(a.runDate)));
  const r = ok[0];
  if (!r) return { report: null, reason: "따를 저녁 계산이 없습니다 (최근 4일 안의 정상 계산 없음)." };
  if (r.label !== plan.label || (plan.updatedAt && plan.updatedAt > r.ranAt)) return { report: null, reason: "저녁 계산 뒤에 운용 전략이 바뀌어 오늘은 주문하지 않습니다. 오늘 저녁 계산부터 새 전략으로 합니다." };
  if (r.lossStop) return { report: null, reason: "손실 한도에 닿아 자동 매매가 멈춰 있습니다." };
  return { report: r };
}

async function placeOne(it: MorningItem, b: Broker, d: MorningDay, now: number, lim: MorningLimits) {
  try {
    const amount = it.qty * it.price * (it.side === "buy" ? 1 + BUY_GAP : 1);
    if (b.env === "real" && lim.orderLimit) checkOrderLimit(amount, lim.orderLimit, lim.usedToday?.() ?? 0);
    const res = await b.place({ code: it.ticker, side: it.side, qty: it.qty, type: "market" });
    if (b.env === "real") { try { lim.addUsage?.(amount); } catch { } }
    Object.assign(it, { status: "placed", orderNo: res.orderNo, orgNo: res.orgNo, placedAt: new Date(now).toISOString() });
    d.log.push(`${hhmm(now, d.market)} ${it.side === "buy" ? "매수" : "매도"} ${withCode(it.name, it.ticker)} ${it.qty}주 ${d.market === "US" ? "지정가(현재가 ±1%)" : "시장가"} 주문 (주문번호 ${res.orderNo})`);
  } catch (err) {
    Object.assign(it, { status: "failed", error: (err as Error).message });
    d.log.push(`${hhmm(now, d.market)} ${withCode(it.name, it.ticker)} 주문 실패: ${(err as Error).message}`);
  }
}

const usedReport = (x: MorningDay, r: EveningReport, label: string) =>
  x.label === label && (x.reportData ? x.reportData === r.dataDate : x.reportDate === r.runDate) && x.items.some((it) => it.orderNo);

export async function morningStart(plan: AutoPlan, log: EveningReport[], b: Broker, now: number, lim: MorningLimits = {}, market: Market = "KR", days: MorningDay[] = []): Promise<MorningDay> {
  const today = clockOf(market, now).date;
  const d: MorningDay = { date: today, label: plan.label, env: b.env, ...(market === "US" ? { market } : {}), phase: "placed", items: [], log: [] };
  const skip = (reason: string): MorningDay => ({ ...d, phase: "skipped", reason, log: [`${hhmm(now, d.market)} ${reason}`] });
  if (!plan.enabled) return skip("운용이 꺼져 있습니다.");
  if (b.env === "real" && !plan.realConfirmedAt) return skip(REAL_NOT_CONFIRMED);
  if (b.env === "real" && lim.realCap && plan.budget > lim.realCap) return skip(`운용 금액 ${won(plan.budget)}이 실전 운용 금액 상한 ${won(lim.realCap)}을 넘습니다. 설정에서 상한을 올리거나 운용 금액을 줄이세요.`);
  const { report, reason } = pickReport(log, plan, today, market === "US" || isMixed(plan));
  if (!report) return skip(reason!);
  if (!reportMarkets(report).includes(market)) return skip("계산 결과와 운용 종목의 시장이 달라 오늘은 주문하지 않습니다.");
  // 계산이 실패한 다음 날 예전 계산을 다시 집어 같은 주문을 두 번 내지 않게
  if (days.some((x) => x.date < today && (x.market ?? "KR") === market && usedReport(x, report, plan.label))) {
    return skip(`${report.dataDate ?? report.runDate} 시세 계산으로는 이미 주문했습니다. 새 계산이 없어 오늘은 주문하지 않습니다.`);
  }
  d.reportDate = report.runDate;
  d.reportData = report.dataDate;
  const orders = report.orders.filter((o) => reportMarkets(report).length < 2 || marketOf(o.ticker) === market);
  let open: boolean | null = null;
  try { open = await b.openDay(today); } catch { }
  if (open === false) return skip("오늘은 휴장일입니다.");
  if (!orders.length) return { ...d, phase: "done", reason: "주문 없음", log: [`${hhmm(now, d.market)} 오늘은 주문할 것이 없습니다 (${report.runDate} 계산).`] };

  const bal = await b.balance();
  const held = new Map(bal.holdings.map((h) => [h.code, h.qty]));
  for (const o of orders) {
    const it: MorningItem = { ticker: o.ticker, name: o.name, side: o.side, planned: o.qty, qty: o.qty, status: "waiting", filledQty: 0, avgPrice: 0, price: o.price, note: o.note, ...(o.retry ? { retry: o.retry } : {}) };
    if (o.side === "sell") {
      const have = held.get(o.ticker) ?? 0;
      it.qty = Math.min(o.qty, have);
      if (it.qty <= 0) { it.status = "skipped"; it.error = "계좌에 팔 주식이 없습니다."; }
      else if (it.qty < o.qty) it.note = `${it.note ? it.note + " · " : ""}보유 ${have}주만 매도`;
    }
    d.items.push(it);
  }
  for (const it of d.items) if (it.side === "sell" && it.status === "waiting") await placeOne(it, b, d, now, lim);
  const buys = d.items.filter((x) => x.side === "buy" && x.status === "waiting");
  if (buys.length) {
    const need = buys.reduce((a, x) => a + x.qty * x.price * (1 + BUY_GAP), 0);
    let cash = 0;
    try { cash = await b.buyable(buys[0].ticker, buys[0].price); } catch (err) { d.log.push(`${hhmm(now, d.market)} 주문 가능 금액 조회 실패: ${(err as Error).message}`); }
    if (cash >= need) for (const it of buys) await placeOne(it, b, d, now, lim);
    else {
      d.phase = "buying";
      d.log.push(`${hhmm(now, d.market)} 매수에 필요한 약 ${won(need)} 중 지금 ${won(cash)}만 있어 매도 체결 뒤 매수합니다.`);
    }
  }
  if (d.items.every((x) => FINAL.includes(x.status))) d.phase = "done";
  return d;
}

export function applyFills(d: { items: Pick<MorningItem, "orderNo" | "orgNo" | "status" | "qty" | "filledQty" | "avgPrice">[] }, orders: DayOrder[]) {
  const by = new Map(orders.map((o) => [o.orderNo.replace(/^0+/, ""), o]));
  for (const it of d.items) {
    if (!it.orderNo || !["placed", "partial"].includes(it.status)) continue;
    const o = by.get(it.orderNo.replace(/^0+/, ""));
    if (!o) continue;
    it.filledQty = o.filledQty;
    it.avgPrice = o.avgPrice;
    if (!it.orgNo && o.orgNo) it.orgNo = o.orgNo;
    if (o.filledQty >= it.qty) it.status = "filled";
    else if (o.cancelled || (o.openQty === 0 && o.filledQty < it.qty)) it.status = o.filledQty > 0 ? "partial" : "cancelled";
    else if (o.filledQty > 0) it.status = "partial";
  }
}

export async function morningFollow(d: MorningDay, b: Broker, now: number, cutoff: string, lim: MorningLimits = {}): Promise<MorningDay> {
  if (!["placed", "buying"].includes(d.phase)) return d;
  const hm = hhmm(now, d.market);
  d.lastCheck = now;
  if (d.items.some((x) => x.orderNo)) {
    try { applyFills(d, await b.orders(d.date)); } catch (err) { d.log.push(`${hm} 체결 조회 실패: ${(err as Error).message}`); }
  }
  const buyFrom = d.market === "US" ? US_SESSION.buyFrom : "09:01", buyBy = d.market === "US" ? US_SESSION.buyBy : "09:10";
  if (d.phase === "buying" && hm >= buyFrom) {
    const sellsOpen = d.items.some((x) => x.side === "sell" && (x.status === "placed" || x.status === "partial"));
    if (!sellsOpen || hm >= buyBy) {
      const waiting = d.items.filter((x) => x.side === "buy" && x.status === "waiting");
      let cash = 0;
      try { cash = waiting.length ? await b.buyable(waiting[0].ticker, waiting[0].price) : 0; } catch (err) { d.log.push(`${hm} 주문 가능 금액 조회 실패: ${(err as Error).message}`); }
      for (const it of waiting) {
        const unit = it.price * (1 + BUY_GAP);
        const q = Math.min(it.qty, Math.floor(cash / unit));
        if (q <= 0) { it.status = "skipped"; it.error = `현금이 모자랍니다 (주문 가능 ${won(cash)}).`; d.log.push(`${hm} ${withCode(it.name, it.ticker)} 매수 건너뜀: 현금 부족`); continue; }
        if (q < it.qty) it.note = `${it.note ? it.note + " · " : ""}현금 부족으로 ${it.qty}주 중 ${q}주`;
        it.qty = q;
        cash -= q * unit;
        await placeOne(it, b, d, now, lim);
      }
      d.phase = "placed";
    }
  }
  if (hm >= cutoff) {
    for (const it of d.items) {
      if (it.status === "waiting") { it.status = "skipped"; it.error = "마감 시각까지 주문하지 못했습니다."; continue; }
      if ((it.status === "placed" || it.status === "partial") && it.orderNo) {
        try {
          await b.cancel({ orderNo: it.orderNo, orgNo: it.orgNo ?? "" });
          it.status = it.filledQty > 0 ? "partial" : "cancelled";
          d.log.push(`${hm} ${withCode(it.name, it.ticker)} 미체결 ${it.qty - it.filledQty}주 취소`);
        } catch (err) { d.log.push(`${hm} ${withCode(it.name, it.ticker)} 취소 실패: ${(err as Error).message}`); }
      }
    }
    d.phase = "done";
  }
  if (d.items.every((x) => FINAL.includes(x.status) || (x.status === "partial" && d.phase === "done"))) d.phase = "done";
  return d;
}

export async function stopDay(d: MorningDay, b: Broker, now: number): Promise<MorningDay> {
  const hm = hhmm(now, d.market);
  for (const it of d.items) {
    if (it.status === "waiting") { it.status = "skipped"; it.error = "긴급 정지"; continue; }
    if ((it.status === "placed" || it.status === "partial") && it.orderNo) {
      try { await b.cancel({ orderNo: it.orderNo, orgNo: it.orgNo ?? "" }); it.status = it.filledQty > 0 ? "partial" : "cancelled"; d.log.push(`${hm} 긴급 정지: ${withCode(it.name, it.ticker)} 취소`); }
      catch (err) { d.log.push(`${hm} 긴급 정지: ${withCode(it.name, it.ticker)} 취소 실패 ${(err as Error).message}`); }
    }
  }
  d.phase = "stopped";
  return d;
}

export function unfinishedItems(days: MorningDay[], label: string, market: Market, today: string): Unfinished[] {
  const last = days.filter((x) => (x.market ?? "KR") === market && x.label === label && x.items.length)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!last || last.phase === "stopped" || last.phase === "placed" || last.phase === "buying") return [];
  if (last.date < minusDays(today, 7)) return [];
  return last.items.filter((it) => it.status !== "filled" && it.filledQty < it.planned && !/팔 주식이 없습니다/.test(it.error ?? ""))
    .map((it) => ({ ticker: it.ticker, side: it.side, qty: it.planned - it.filledQty, retry: it.retry ?? 0 }));
}

const ST: Record<ItemStatus, string> = { waiting: "대기", placed: "주문됨", partial: "일부 체결", filled: "체결", cancelled: "취소", failed: "실패", skipped: "건너뜀" };
export const statusLabel = (s: ItemStatus) => ST[s];

export function formatDay(d: MorningDay, final: boolean): string {
  const env = d.env === "real" ? "실전" : "모의투자";
  const head = `[알피] ${d.date} ${d.market === "US" ? "미국 장 시작" : "아침"} ${final ? "매매 결과" : "주문"} · ${d.label} (${env})`;
  if (d.phase === "skipped") return `${head}\n주문하지 않았습니다: ${d.reason}`;
  if (!d.items.length) return `${head}\n${d.reason ?? "주문 없음"}`;
  const lines = [head];
  for (const it of d.items) {
    const fill = it.filledQty > 0 ? ` · ${it.filledQty}주 체결 평균 ${d.market === "US" ? `$${it.avgPrice.toFixed(2)}` : won(it.avgPrice)}` : "";
    lines.push(`- ${it.side === "buy" ? "매수" : "매도"} ${withCode(it.name, it.ticker)} ${it.qty}주: ${ST[it.status]}${fill}${it.error ? ` (${it.error})` : ""}`);
  }
  if (!final && d.phase === "buying") lines.push("매수는 매도 체결 뒤 남은 현금으로 합니다.");
  if (d.phase === "stopped") lines.push("긴급 정지로 남은 주문을 취소했습니다.");
  return lines.join("\n");
}
