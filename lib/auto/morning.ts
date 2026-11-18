/**
 * 아침 자동 주문 (서버 전용).
 *
 * 순서 (한국 시간, 시각은 관리자가 운용 화면에서 바꿈)
 *   1) 주문 시각(기본 08:40, 장 시작 동시호가): 어제 저녁 계산의 주문 목록대로
 *        - 매도: 실제 보유 수량 안에서 시장가 → 09:00 시가에 체결
 *        - 매수: 지금 현금으로 다 살 수 있으면 같이 시장가, 모자라면 매도가 체결된 뒤(09:01~) 남은 현금만큼 시장가
 *   2) 09:00 이후 몇 분마다 체결 확인
 *   3) 마감 시각(기본 10:00)까지 체결 안 된 주문은 취소하고 결과를 알림
 *
 * 같은 날 두 번 주문하지 않도록 사람마다 users/<사용자>/auto-orders.json 에 그날 한 일을 적어 둡니다.
 * 앱이 중간에 다시 켜져도 이 기록을 보고 이어서 합니다.
 */
import fs from "fs";
import type { Balance, OrderRequest, OrderResult } from "../kis/trading";
import type { DayOrder } from "../kis/orders";
import type { OrderLimit } from "../settings/store";
import { checkOrderLimit } from "../kis/limits";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import type { EveningReport } from "./evening";
import { REAL_NOT_CONFIRMED, type AutoPlan } from "./store";
import { minusDays } from "./time";
import { clockOf, US_SESSION, type Market } from "./session";
import { withCode } from "../strategies/universe";

type Env = Record<string, string | undefined>;

export type ItemStatus = "waiting" | "placed" | "partial" | "filled" | "cancelled" | "failed" | "skipped";

export interface MorningItem {
  ticker: string;
  name: string;
  side: "buy" | "sell";
  /** 저녁 계산이 정한 수량 */
  planned: number;
  /** 실제로 낸 수량 */
  qty: number;
  status: ItemStatus;
  orderNo?: string;
  orgNo?: string;
  filledQty: number;
  avgPrice: number;
  /** 어제 종가 (금액 어림) */
  price: number;
  note?: string;
  error?: string;
  placedAt?: string;
}

export interface MorningDay {
  date: string;
  /** 어느 저녁 계산을 따랐는지 */
  reportDate?: string;
  label: string;
  env?: "real" | "mock";
  /** 미국이면 date 와 시각이 뉴욕 기준 (없으면 한국) */
  market?: Market;
  phase: "placed" | "buying" | "done" | "skipped" | "stopped";
  items: MorningItem[];
  /** 시각과 한 일 */
  log: string[];
  lastCheck?: number;
  /** 마지막 결과 알림을 보냈는지 */
  notified?: boolean;
  reason?: string;
}

/** 증권사와 주고받는 부분 (시험할 때 가짜로 바꿈) */
export interface Broker {
  env: "real" | "mock";
  balance(): Promise<Balance>;
  buyable(code: string, price: number): Promise<number>;
  place(o: OrderRequest): Promise<OrderResult>;
  orders(date: string): Promise<DayOrder[]>;
  cancel(o: { orderNo: string; orgNo: string }): Promise<string>;
  openDay(date: string): Promise<boolean | null>;
  /** 현재가 (장중 실시간 매도용) */
  quote?(code: string): Promise<number>;
}

export interface MorningLimits {
  /** 실전 운용 금액 상한 (설정의 자동 매매 한도). 0 = 없음 */
  realCap?: number;
  /** 실전 주문 금액 상한 (모의는 무시) */
  orderLimit?: OrderLimit;
  usedToday?: () => number;
  addUsage?: (amount: number) => void;
}

/** 시장가 매수 금액 어림: 어제 종가보다 시가가 이만큼 높을 수도 있다고 봄 */
export const BUY_GAP = 0.03;
const MAX_DAYS = 30;
const FINAL: ItemStatus[] = ["filled", "cancelled", "failed", "skipped"];
const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const hhmm = (now: number, m: Market = "KR") => clockOf(m, now).hm;

// ---------------- 저장 ----------------
type OrdersFile = Record<string, MorningDay>;

export function loadDays(user: string = OWNER_ID, e: Env = process.env): OrdersFile {
  try { const j = JSON.parse(fs.readFileSync(userFile("auto-orders.json", user, e), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
/** 저장 이름: 한국은 날짜, 미국은 "날짜:US" (같은 날짜에 한국 아침 기록과 미국 기록이 겹치지 않게) */
export const dayKey = (date: string, market: Market = "KR") => (market === "US" ? `${date}:US` : date);
export function loadDay(date: string, user: string = OWNER_ID, e: Env = process.env, market: Market = "KR"): MorningDay | null {
  const all = loadDays(user, e);
  // 예전 기록은 미국도 날짜만으로 저장했음
  const d = all[dayKey(date, market)] ?? (market === "US" && all[date]?.market === "US" ? all[date] : null);
  return d && (d.market ?? "KR") === market ? d : null;
}
export function saveDay(d: MorningDay, user: string = OWNER_ID, e: Env = process.env) {
  const all = { ...loadDays(user, e), [dayKey(d.date, d.market)]: d };
  const keep = Object.keys(all).sort().slice(-MAX_DAYS);
  writeUserFile("auto-orders.json", JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))), user, e);
}

// ---------------- 어느 저녁 계산을 따를지 ----------------
/**
 * 오늘 아침 주문에 쓸 저녁 계산: 오늘보다 앞선 날의 가장 최근 정상 계산(4일 이내).
 * 운용 전략을 그 뒤에 바꿨으면 쓰지 않음 (바뀐 전략의 주문이 아니므로).
 */
export function pickReport(log: EveningReport[], plan: AutoPlan, today: string, sameDay = false): { report: EveningReport | null; reason?: string } {
  // 미국(sameDay): 한국 저녁에 계산하고 같은 날짜(뉴욕 기준)의 장 시작에 주문하므로 오늘 계산도 씀
  const ok = log.filter((r) => r.status === "ok" && (sameDay ? r.runDate <= today : r.runDate < today) && r.runDate >= minusDays(today, 4))
    .sort((a, b) => (a.runDate === b.runDate ? b.ranAt.localeCompare(a.ranAt) : b.runDate.localeCompare(a.runDate)));
  const r = ok[0];
  if (!r) return { report: null, reason: "따를 저녁 계산이 없습니다 (최근 4일 안의 정상 계산 없음)." };
  if (r.label !== plan.label || (plan.updatedAt && plan.updatedAt > r.ranAt)) return { report: null, reason: "저녁 계산 뒤에 운용 전략이 바뀌어 오늘은 주문하지 않습니다. 오늘 저녁 계산부터 새 전략으로 합니다." };
  if (r.lossStop) return { report: null, reason: "손실 한도에 닿아 자동 매매가 멈춰 있습니다." };
  return { report: r };
}

// ---------------- 주문 ----------------
async function placeOne(it: MorningItem, b: Broker, d: MorningDay, now: number, lim: MorningLimits) {
  try {
    const amount = it.qty * it.price * (it.side === "buy" ? 1 + BUY_GAP : 1);
    if (b.env === "real" && lim.orderLimit) checkOrderLimit(amount, lim.orderLimit, lim.usedToday?.() ?? 0);
    const res = await b.place({ code: it.ticker, side: it.side, qty: it.qty, type: "market" });
    if (b.env === "real") { try { lim.addUsage?.(amount); } catch { /* 합계 저장 실패는 주문에 영향 없음 */ } }
    Object.assign(it, { status: "placed", orderNo: res.orderNo, orgNo: res.orgNo, placedAt: new Date(now).toISOString() });
    d.log.push(`${hhmm(now, d.market)} ${it.side === "buy" ? "매수" : "매도"} ${withCode(it.name, it.ticker)} ${it.qty}주 ${d.market === "US" ? "지정가(현재가 ±1%)" : "시장가"} 주문 (주문번호 ${res.orderNo})`);
  } catch (err) {
    Object.assign(it, { status: "failed", error: (err as Error).message });
    d.log.push(`${hhmm(now, d.market)} ${withCode(it.name, it.ticker)} 주문 실패: ${(err as Error).message}`);
  }
}

/** 주문 시각: 그날 첫 실행 */
export async function morningStart(plan: AutoPlan, log: EveningReport[], b: Broker, now: number, lim: MorningLimits = {}, market: Market = "KR"): Promise<MorningDay> {
  const today = clockOf(market, now).date;
  const d: MorningDay = { date: today, label: plan.label, env: b.env, ...(market === "US" ? { market } : {}), phase: "placed", items: [], log: [] };
  const skip = (reason: string): MorningDay => ({ ...d, phase: "skipped", reason, log: [`${hhmm(now, d.market)} ${reason}`] });
  if (!plan.enabled) return skip("운용이 꺼져 있습니다.");
  if (b.env === "real" && !plan.realConfirmedAt) return skip(REAL_NOT_CONFIRMED);
  if (b.env === "real" && lim.realCap && plan.budget > lim.realCap) return skip(`운용 금액 ${won(plan.budget)}이 실전 운용 금액 상한 ${won(lim.realCap)}을 넘습니다. 설정에서 상한을 올리거나 운용 금액을 줄이세요.`);
  const { report, reason } = pickReport(log, plan, today, market === "US");
  if (!report) return skip(reason!);
  if ((report.market ?? "KR") !== market) return skip("저녁 계산과 운용 종목의 시장이 달라 오늘은 주문하지 않습니다.");
  d.reportDate = report.runDate;
  let open: boolean | null = null;
  try { open = await b.openDay(today); } catch { /* 모르면 진행 */ }
  if (open === false) return skip("오늘은 휴장일입니다.");
  if (!report.orders.length) return { ...d, phase: "done", reason: "주문 없음", log: [`${hhmm(now, d.market)} 오늘은 주문할 것이 없습니다 (${report.runDate} 저녁 계산).`] };

  const bal = await b.balance();
  const held = new Map(bal.holdings.map((h) => [h.code, h.qty]));
  for (const o of report.orders) {
    const it: MorningItem = { ticker: o.ticker, name: o.name, side: o.side, planned: o.qty, qty: o.qty, status: "waiting", filledQty: 0, avgPrice: 0, price: o.price, note: o.note };
    if (o.side === "sell") {
      const have = held.get(o.ticker) ?? 0;
      it.qty = Math.min(o.qty, have);
      if (it.qty <= 0) { it.status = "skipped"; it.error = "계좌에 팔 주식이 없습니다."; }
      else if (it.qty < o.qty) it.note = `${it.note ? it.note + " · " : ""}보유 ${have}주만 매도`;
    }
    d.items.push(it);
  }
  // 1) 매도 먼저
  for (const it of d.items) if (it.side === "sell" && it.status === "waiting") await placeOne(it, b, d, now, lim);
  // 2) 매수: 지금 현금으로 다 되면 바로, 아니면 매도 체결 뒤
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

/** 체결 결과를 반영 (아침 주문·장중 매도 같이 씀) */
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

/** 09:00 이후 몇 분마다: 체결 확인, 기다리던 매수, 마감 시각이면 취소 */
export async function morningFollow(d: MorningDay, b: Broker, now: number, cutoff: string, lim: MorningLimits = {}): Promise<MorningDay> {
  if (!["placed", "buying"].includes(d.phase)) return d;
  const hm = hhmm(now, d.market);
  d.lastCheck = now;
  if (d.items.some((x) => x.orderNo)) {
    try { applyFills(d, await b.orders(d.date)); } catch (err) { d.log.push(`${hm} 체결 조회 실패: ${(err as Error).message}`); }
  }
  // 기다리던 매수: 매도가 다 끝났거나 09:10 이 지나면 남은 현금 안에서
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
  // 마감: 남은 주문 취소
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

/** 긴급 정지: 그날 남은 주문 모두 취소 */
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

const ST: Record<ItemStatus, string> = { waiting: "대기", placed: "주문됨", partial: "일부 체결", filled: "체결", cancelled: "취소", failed: "실패", skipped: "건너뜀" };
export const statusLabel = (s: ItemStatus) => ST[s];

/** 텔레그램 글 */
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
