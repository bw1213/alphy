/**
 * 수동 계좌 (서버 전용, 사람마다 따로).
 *
 * 토스·미래에셋처럼 공개 API 가 없어 자동 주문을 못 하는 계좌. 예수금·보유 종목은 사람이 직접 넣고,
 * 계좌마다 전략 하나를 붙여 두면 저녁 계산이 "내일 무엇을 몇 주 사고팔지" 안내한다. 주문은 사람이 직접 하고
 * 체결을 기록하면 이 파일의 보유·예수금이 바뀐다.
 *
 *   users/<사용자>/manual.json         계좌 목록 (예수금·보유·전략)
 *   users/<사용자>/manual-log.json     계좌별 저녁 계산 기록 (계좌마다 최근 30개)
 *   users/<사용자>/manual-trades.json  체결 기록 (최근 1000개)
 *
 * 금액은 모두 원화. 미국 종목도 원화로 바꾼 가격으로 넣는다 (백테스트·저녁 계산이 원화로 계산하므로).
 */
import { randomBytes } from "crypto";
import fs from "fs";
import { normalizeTicker, isUsTicker } from "../data/market";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import { cleanPlan, type AutoPlan } from "../auto/store";
import type { SavedStrategy } from "../strategies/library";
import type { EveningReport } from "../auto/evening";

type Env = Record<string, string | undefined>;

export interface ManualPosition {
  ticker: string;
  name?: string;
  qty: number;
  /** 평균 매수 단가(원) */
  avgPrice: number;
}

export interface ManualAccount {
  id: string;
  /** 화면에 보이는 이름 (예: 토스 미국 주식) */
  name: string;
  /** 증권사 이름 (사람이 알아보기 위한 글자) */
  broker: string;
  /** 예수금(원) */
  cash: number;
  positions: ManualPosition[];
  /** 이 계좌에 적용할 전략. 장중 실시간 매도는 늘 끔 (사람이 장중에 지켜보지 않으므로 종가 확인 → 다음 날 매도) */
  plan: AutoPlan | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManualTrade {
  id: string;
  accountId: string;
  /** 체결일 */
  date: string;
  ticker: string;
  name?: string;
  side: "buy" | "sell";
  qty: number;
  /** 체결 가격(원) */
  price: number;
  /** 수수료·세금(원) */
  fee: number;
  /** 되돌리기용: 기록 전 그 종목의 평균단가 */
  prevAvg: number;
  at: string;
}

export const MAX_ACCOUNTS = 20;
export const MAX_LOG = 30;
export const MAX_TRADES = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const BROKERS = ["토스증권", "미래에셋증권", "한화투자증권", "키움증권", "삼성증권", "NH투자증권", "KB증권", "한국투자증권", "기타"];
/** 직접 입력한 증권사는 이 개수까지 목록에 기억 */
export const MAX_CUSTOM_BROKERS = 20;

const num = (v: unknown) => (typeof v === "string" ? Number(v.replace(/[,\s원]/g, "")) : Number(v));

interface ManualFile { accounts: ManualAccount[]; /** 직접 입력한 증권사 이름 (목록에 이어서 보여 줌) */ brokers: string[] }

function loadFile(user: string, e: Env): ManualFile {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("manual.json", user, e), "utf8"));
    return { accounts: Array.isArray(j?.accounts) ? j.accounts : [], brokers: Array.isArray(j?.brokers) ? j.brokers.map(String) : [] };
  } catch { return { accounts: [], brokers: [] }; }
}
const saveFile = (f: ManualFile, user: string, e: Env) => writeUserFile("manual.json", JSON.stringify(f, null, 1), user, e);

export function loadAccounts(user: string = OWNER_ID, e: Env = process.env): ManualAccount[] {
  return loadFile(user, e).accounts;
}

/** 계좌 목록 저장. 기본 목록에 없는 증권사 이름은 "직접 입력한 증권사"로 기억 */
export function saveAccounts(list: ManualAccount[], user: string = OWNER_ID, e: Env = process.env): void {
  const f = loadFile(user, e);
  const custom = [...f.brokers];
  for (const a of list) if (a.broker && !BROKERS.includes(a.broker) && !custom.includes(a.broker)) custom.push(a.broker);
  saveFile({ accounts: list, brokers: custom.slice(-MAX_CUSTOM_BROKERS) }, user, e);
}

/** 고를 수 있는 증권사: 기본 목록("기타" 앞에) + 직접 입력했던 이름 */
export function brokerList(user: string = OWNER_ID, e: Env = process.env): string[] {
  const custom = loadFile(user, e).brokers.filter((b) => !BROKERS.includes(b));
  return [...BROKERS.filter((b) => b !== "기타"), ...custom, "기타"];
}

/** 직접 입력한 증권사를 목록에서 지움 (그 이름을 쓰는 계좌는 그대로) */
export function forgetBroker(name: string, user: string = OWNER_ID, e: Env = process.env): void {
  const f = loadFile(user, e);
  saveFile({ ...f, brokers: f.brokers.filter((b) => b !== name) }, user, e);
}

/**
 * 전략 기준 다시 잡기: 운용 시작일을 오늘로, 운용 금액을 지금 계좌 평가액으로.
 * 예전 시작일부터 운용 금액으로 계산한 가상 평가액이 실제 계좌와 크게 벌어졌을 때, 오늘부터 지금 잔고로 새로 출발하게 한다.
 * price: 종목별 원화 종가 (모르면 평균단가)
 */
export function resetBasis(user: string, accountId: string, today: string, price: (t: string) => number | undefined, e: Env = process.env): ManualAccount {
  const list = loadAccounts(user, e);
  const i = list.findIndex((a) => a.id === accountId);
  if (i < 0) throw new Error("그 계좌를 찾지 못했습니다.");
  const a = list[i];
  if (!a.plan) throw new Error("이 계좌에는 전략이 없습니다. 먼저 전략을 정하세요.");
  const value = Math.round(accountValue(a, price));
  if (value < 100_000) throw new Error(`지금 계좌 평가액이 ${value.toLocaleString("ko-KR")}원이라 운용 금액(10만 원 이상)으로 쓸 수 없습니다. 예수금·보유를 먼저 맞춰 주세요.`);
  const now = new Date().toISOString();
  list[i] = { ...a, plan: { ...a.plan, startDate: today, budget: value, updatedAt: now }, updatedAt: now };
  saveAccounts(list, user, e);
  return list[i];
}

export function getAccount(id: string, user: string = OWNER_ID, e: Env = process.env): ManualAccount {
  const a = loadAccounts(user, e).find((x) => x.id === id);
  if (!a) throw new Error("그 계좌를 찾지 못했습니다. 화면을 새로고침해 보세요.");
  return a;
}

/** 보유 목록 검사: 같은 종목은 합치고(평균단가 가중), 0주는 뺌 */
export function cleanPositions(x: unknown): ManualPosition[] {
  const rows = Array.isArray(x) ? x : [];
  const map = new Map<string, ManualPosition>();
  for (const r of rows.slice(0, 100)) {
    const ticker = normalizeTicker(String((r as any)?.ticker ?? ""));
    if (!ticker) continue;
    const qty = num((r as any)?.qty);
    const avg = num((r as any)?.avgPrice);
    if (!Number.isFinite(qty) || qty < 0 || !Number.isInteger(qty)) throw new Error(`${ticker} 수량은 0 이상의 정수로 넣으세요.`);
    if (!Number.isFinite(avg) || avg < 0) throw new Error(`${ticker} 평균단가를 확인하세요.`);
    if (!qty) continue;
    const name = String((r as any)?.name ?? "").trim().slice(0, 60) || undefined;
    const prev = map.get(ticker);
    if (prev) {
      const q = prev.qty + qty;
      map.set(ticker, { ...prev, qty: q, avgPrice: (prev.avgPrice * prev.qty + avg * qty) / q });
    } else map.set(ticker, { ticker, ...(name ? { name } : {}), qty, avgPrice: avg });
  }
  return [...map.values()];
}

/**
 * 계좌 저장 (새로 만들기 또는 고치기). 전략은 { strategy: "saved:이름" | "builtin:id" | "" , tickers, budget, startDate, enabled }.
 * 전략을 비우면 계좌만 기록 (안내 없음).
 */
export function cleanAccount(x: any, prev: ManualAccount | null, user: string, today: string, lib: SavedStrategy[]): ManualAccount {
  const name = String(x?.name ?? "").trim().slice(0, 40);
  if (!name) throw new Error("계좌 이름을 넣으세요 (예: 토스 미국 주식).");
  const broker = String(x?.broker ?? "").trim().slice(0, 30) || "기타";
  const cash = Math.round(num(x?.cash ?? 0));
  if (!Number.isFinite(cash) || cash < 0 || cash > 100_000_000_000) throw new Error("예수금은 0 이상의 금액으로 넣으세요.");
  const positions = cleanPositions(x?.positions);
  let plan: AutoPlan | null = null;
  const p = x?.plan;
  if (p && String(p.strategy ?? "").trim()) {
    // 지금 쓰는 전략이 보관함에서 지워졌거나 이름이 바뀌었어도 그대로 이어 쓸 수 있게 (예전에 복사해 둔 것)
    const kept = prev?.plan?.strategy;
    const libAll = kept && !lib.some((v) => v.name === kept.name) ? [...lib, kept] : lib;
    plan = { ...cleanPlan(p, user, today, libAll, undefined, { allowMix: true }), intraday: false };
    // 전략·종목·금액이 그대로면 저장 시각을 유지 (저녁 기록이 "예전 설정 기준"으로 보이지 않게)
    if (prev?.plan && samePlan(prev.plan, plan)) plan.updatedAt = prev.plan.updatedAt;
  }
  const now = new Date().toISOString();
  return {
    id: prev?.id ?? randomBytes(4).toString("hex"),
    name, broker, cash, positions, plan,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

const samePlan = (a: AutoPlan, b: AutoPlan) =>
  a.label === b.label && a.tickers.join(",") === b.tickers.join(",") && a.budget === b.budget && a.startDate === b.startDate && a.enabled === b.enabled
  && JSON.stringify(a.strategy ?? a.builtin) === JSON.stringify(b.strategy ?? b.builtin);

/** 계좌 평가액 어림 (가격을 모르면 평균단가) */
export function accountValue(a: ManualAccount, price: (t: string) => number | undefined = () => undefined): number {
  return a.cash + a.positions.reduce((s, p) => s + p.qty * (price(p.ticker) ?? p.avgPrice), 0);
}

// ---------- 체결 기록 ----------

export function loadTrades(user: string = OWNER_ID, e: Env = process.env): ManualTrade[] {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("manual-trades.json", user, e), "utf8"));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function saveTrades(list: ManualTrade[], user: string, e: Env) {
  writeUserFile("manual-trades.json", JSON.stringify(list.slice(0, MAX_TRADES)), user, e);
}

export interface FeeRates { commission: number; sellTax: number; usCommission: number; usFx: number }

/** 수수료·세금 어림 (사람이 비워 두면). rates 는 % 단위 (설정 화면 값) */
export function estimateFee(ticker: string, side: "buy" | "sell", amount: number, r: FeeRates): number {
  const pct = isUsTicker(ticker) ? r.usCommission + r.usFx : r.commission + (side === "sell" ? r.sellTax : 0);
  return Math.round((amount * pct) / 100);
}

/** 체결 하나를 계좌에 반영 (계좌를 새로 만들어 돌려줌) */
export function applyTrade(a: ManualAccount, t: Pick<ManualTrade, "ticker" | "name" | "side" | "qty" | "price" | "fee">): ManualAccount {
  const positions = a.positions.map((p) => ({ ...p }));
  let pos = positions.find((p) => p.ticker === t.ticker);
  const amount = t.qty * t.price;
  let cash = a.cash;
  if (t.side === "buy") {
    if (!pos) { pos = { ticker: t.ticker, ...(t.name ? { name: t.name } : {}), qty: 0, avgPrice: 0 }; positions.push(pos); }
    const q = pos.qty + t.qty;
    pos.avgPrice = (pos.avgPrice * pos.qty + amount + t.fee) / q; // 매수 수수료는 단가에 포함
    pos.qty = q;
    cash -= amount + t.fee;
  } else {
    if (!pos || pos.qty < t.qty) throw new Error(`${t.name ?? t.ticker} 보유가 ${pos?.qty ?? 0}주라 ${t.qty}주를 팔 수 없습니다. 먼저 계좌의 보유 수량을 맞춰 주세요.`);
    pos.qty -= t.qty;
    cash += amount - t.fee;
  }
  return { ...a, cash: Math.round(cash), positions: positions.filter((p) => p.qty > 0), updatedAt: new Date().toISOString() };
}

/** 체결 기록 추가 → 계좌 반영. 돌려줌: 바뀐 계좌와 기록 */
export function recordTrade(user: string, accountId: string, x: any, rates: FeeRates, today: string, e: Env = process.env): { account: ManualAccount; trade: ManualTrade } {
  const list = loadAccounts(user, e);
  const i = list.findIndex((a) => a.id === accountId);
  if (i < 0) throw new Error("그 계좌를 찾지 못했습니다.");
  const ticker = normalizeTicker(String(x?.ticker ?? ""));
  if (!ticker) throw new Error("종목 코드를 넣으세요.");
  const side = x?.side === "sell" ? "sell" : x?.side === "buy" ? "buy" : null;
  if (!side) throw new Error("매수인지 매도인지 고르세요.");
  const qty = num(x?.qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("체결 수량은 1 이상의 정수로 넣으세요.");
  const price = num(x?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("체결 가격(원)을 넣으세요.");
  const feeRaw = x?.fee;
  const fee = feeRaw === undefined || feeRaw === null || String(feeRaw).trim() === "" ? estimateFee(ticker, side, qty * price, rates) : Math.round(num(feeRaw));
  if (!Number.isFinite(fee) || fee < 0) throw new Error("수수료·세금은 0 이상으로 넣으세요.");
  let date = String(x?.date ?? "").trim();
  if (!ISO.test(date) || date > today) date = today;
  const a = list[i];
  const held = a.positions.find((p) => p.ticker === ticker);
  const name = String(x?.name ?? "").trim().slice(0, 60) || held?.name || undefined;
  const trade: ManualTrade = { id: randomBytes(4).toString("hex"), accountId, date, ticker, ...(name ? { name } : {}), side, qty, price, fee, prevAvg: held?.avgPrice ?? 0, at: new Date().toISOString() };
  const next = applyTrade(a, trade);
  list[i] = next;
  saveAccounts(list, user, e);
  saveTrades([trade, ...loadTrades(user, e)], user, e);
  return { account: next, trade };
}

/** 그 계좌의 가장 최근 체결 기록 하나를 되돌림 (예수금·수량·평균단가 원래대로) */
export function undoLastTrade(user: string, accountId: string, e: Env = process.env): ManualTrade {
  const trades = loadTrades(user, e);
  const k = trades.findIndex((t) => t.accountId === accountId);
  if (k < 0) throw new Error("되돌릴 체결 기록이 없습니다.");
  const t = trades[k];
  const list = loadAccounts(user, e);
  const i = list.findIndex((a) => a.id === accountId);
  if (i < 0) throw new Error("그 계좌를 찾지 못했습니다.");
  const a = list[i];
  const positions = a.positions.map((p) => ({ ...p }));
  let pos = positions.find((p) => p.ticker === t.ticker);
  const amount = t.qty * t.price;
  let cash = a.cash;
  if (t.side === "buy") {
    if (!pos || pos.qty < t.qty) throw new Error(`그 뒤로 ${t.name ?? t.ticker} 수량을 바꿔서 되돌릴 수 없습니다. 계좌 고치기에서 직접 맞춰 주세요.`);
    pos.qty -= t.qty;
    pos.avgPrice = pos.qty > 0 ? t.prevAvg : 0;
    cash += amount + t.fee;
  } else {
    if (!pos) { pos = { ticker: t.ticker, ...(t.name ? { name: t.name } : {}), qty: 0, avgPrice: t.prevAvg }; positions.push(pos); }
    pos.qty += t.qty;
    pos.avgPrice = t.prevAvg;
    cash -= amount - t.fee;
  }
  list[i] = { ...a, cash: Math.round(cash), positions: positions.filter((p) => p.qty > 0), updatedAt: new Date().toISOString() };
  saveAccounts(list, user, e);
  trades.splice(k, 1);
  saveTrades(trades, user, e);
  return t;
}

// ---------- 저녁 계산 기록 ----------

export function loadManualLog(user: string = OWNER_ID, e: Env = process.env): Record<string, EveningReport[]> {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("manual-log.json", user, e), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** 새 기록을 맨 앞에. 같은 날 같은 종류(자동/직접)는 새 것으로 바꿈. 없어진 계좌의 기록은 지움 */
export function appendManualLog(accountId: string, r: EveningReport, user: string = OWNER_ID, e: Env = process.env): void {
  const all = loadManualLog(user, e);
  const ids = new Set(loadAccounts(user, e).map((a) => a.id));
  const next: Record<string, EveningReport[]> = {};
  for (const [k, v] of Object.entries(all)) if (ids.has(k)) next[k] = v;
  next[accountId] = [r, ...(next[accountId] ?? []).filter((x) => !(x.runDate === r.runDate && x.trigger === r.trigger))].slice(0, MAX_LOG);
  writeUserFile("manual-log.json", JSON.stringify(next), user, e);
}
