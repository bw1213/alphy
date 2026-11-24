import { randomBytes } from "crypto";
import fs from "fs";
import { normalizeTicker, isUsTicker } from "../data/market";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import { cleanPlan, syncPlan, type AutoPlan } from "../auto/store";
import { loadStrategies, type SavedStrategy } from "../strategies/library";
import type { EveningReport } from "../auto/evening";

type Env = Record<string, string | undefined>;

// 금액은 모두 원화 (미국 종목도 원화로 바꾼 가격)
export interface ManualPosition {
  ticker: string;
  name?: string;
  qty: number;
  avgPrice: number;
}

export interface ManualAccount {
  id: string;
  name: string;
  broker: string;
  cash: number;
  positions: ManualPosition[];
  plan: AutoPlan | null;
  others?: "sell" | "keep";
  createdAt: string;
  updatedAt: string;
}

export interface ManualTrade {
  id: string;
  accountId: string;
  date: string;
  ticker: string;
  name?: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fee: number;
  prevAvg: number;
  at: string;
}

export const MAX_ACCOUNTS = 20;
export const MAX_LOG = 30;
export const MAX_TRADES = 50_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const BROKERS = ["토스증권", "미래에셋증권", "한화투자증권", "키움증권", "삼성증권", "NH투자증권", "KB증권", "한국투자증권", "기타"];
export const MAX_CUSTOM_BROKERS = 20;

const num = (v: unknown) => (typeof v === "string" ? Number(v.replace(/[,\s원]/g, "")) : Number(v));

interface ManualFile { accounts: ManualAccount[];  brokers: string[] }

function loadFile(user: string, e: Env): ManualFile {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("manual.json", user, e), "utf8"));
    return { accounts: Array.isArray(j?.accounts) ? j.accounts : [], brokers: Array.isArray(j?.brokers) ? j.brokers.map(String) : [] };
  } catch { return { accounts: [], brokers: [] }; }
}
const saveFile = (f: ManualFile, user: string, e: Env) => writeUserFile("manual.json", JSON.stringify(f, null, 1), user, e);

export function loadAccounts(user: string = OWNER_ID, e: Env = process.env): ManualAccount[] {
  const accounts = loadFile(user, e).accounts;
  if (!accounts.some((a) => a.plan?.strategy)) return accounts;
  const lib = loadStrategies(e, user);
  return accounts.map((a) => (a.plan?.strategy ? { ...a, plan: { ...syncPlan(a.plan, lib, user), intraday: false } } : a));
}

export function saveAccounts(list: ManualAccount[], user: string = OWNER_ID, e: Env = process.env): void {
  const f = loadFile(user, e);
  const custom = [...f.brokers];
  for (const a of list) if (a.broker && !BROKERS.includes(a.broker) && !custom.includes(a.broker)) custom.push(a.broker);
  saveFile({ accounts: list, brokers: custom.slice(-MAX_CUSTOM_BROKERS) }, user, e);
}

export function brokerList(user: string = OWNER_ID, e: Env = process.env): string[] {
  const custom = loadFile(user, e).brokers.filter((b) => !BROKERS.includes(b));
  return [...BROKERS.filter((b) => b !== "기타"), ...custom, "기타"];
}

export function forgetBroker(name: string, user: string = OWNER_ID, e: Env = process.env): void {
  const f = loadFile(user, e);
  saveFile({ ...f, brokers: f.brokers.filter((b) => b !== name) }, user, e);
}

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
    const kept = prev?.plan?.strategy;
    const libAll = kept && !lib.some((v) => v.name === kept.name) ? [...lib, kept] : lib;
    plan = { ...cleanPlan(p, user, today, libAll), intraday: false };
    if (prev?.plan && samePlan(prev.plan, plan)) plan.updatedAt = prev.plan.updatedAt;
  }
  const now = new Date().toISOString();
  return {
    id: prev?.id ?? randomBytes(4).toString("hex"),
    name, broker, cash, positions, plan, others: x?.others === "keep" ? "keep" : "sell",
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

const samePlan = (a: AutoPlan, b: AutoPlan) =>
  a.label === b.label && a.tickers.join(",") === b.tickers.join(",") && a.budget === b.budget && a.startDate === b.startDate && a.enabled === b.enabled
  && JSON.stringify(a.strategy ?? a.builtin) === JSON.stringify(b.strategy ?? b.builtin);

export function accountValue(a: ManualAccount, price: (t: string) => number | undefined = () => undefined): number {
  return a.cash + a.positions.reduce((s, p) => s + p.qty * (price(p.ticker) ?? p.avgPrice), 0);
}

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

export function estimateFee(ticker: string, side: "buy" | "sell", amount: number, r: FeeRates): number {
  const pct = isUsTicker(ticker) ? r.usCommission + r.usFx : r.commission + (side === "sell" ? r.sellTax : 0);
  return Math.round((amount * pct) / 100);
}

export function applyTrade(a: ManualAccount, t: Pick<ManualTrade, "ticker" | "name" | "side" | "qty" | "price" | "fee">): ManualAccount {
  const positions = a.positions.map((p) => ({ ...p }));
  let pos = positions.find((p) => p.ticker === t.ticker);
  const amount = t.qty * t.price;
  let cash = a.cash;
  if (t.side === "buy") {
    if (!pos) { pos = { ticker: t.ticker, ...(t.name ? { name: t.name } : {}), qty: 0, avgPrice: 0 }; positions.push(pos); }
    const q = pos.qty + t.qty;
    pos.avgPrice = (pos.avgPrice * pos.qty + amount + t.fee) / q;
    pos.qty = q;
    cash -= amount + t.fee;
  } else {
    if (!pos || pos.qty < t.qty) throw new Error(`${t.name ?? t.ticker} 보유가 ${pos?.qty ?? 0}주라 ${t.qty}주를 팔 수 없습니다. 먼저 계좌의 보유 수량을 맞춰 주세요.`);
    pos.qty -= t.qty;
    cash += amount - t.fee;
  }
  return { ...a, cash: Math.round(cash), positions: positions.filter((p) => p.qty > 0), updatedAt: new Date().toISOString() };
}

function parseTrade(x: any, rates: FeeRates, today: string, held?: ManualPosition) {
  const ticker = normalizeTicker(String(x?.ticker ?? ""));
  if (!ticker) throw new Error("종목 코드를 넣으세요.");
  const side: "buy" | "sell" | null = x?.side === "sell" ? "sell" : x?.side === "buy" ? "buy" : null;
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
  const name = String(x?.name ?? "").trim().slice(0, 60) || (held?.ticker === ticker ? held.name : undefined) || undefined;
  return { ticker, ...(name ? { name } : {}), side, qty, price, fee, date };
}

export function recordTrade(user: string, accountId: string, x: any, rates: FeeRates, today: string, e: Env = process.env): { account: ManualAccount; trade: ManualTrade } {
  const list = loadAccounts(user, e);
  const i = list.findIndex((a) => a.id === accountId);
  if (i < 0) throw new Error("그 계좌를 찾지 못했습니다.");
  const a = list[i];
  const ticker = normalizeTicker(String(x?.ticker ?? ""));
  const held = a.positions.find((p) => p.ticker === ticker);
  const v = parseTrade(x, rates, today, held);
  const trade: ManualTrade = { id: randomBytes(4).toString("hex"), accountId, ...v, prevAvg: held?.avgPrice ?? 0, at: new Date().toISOString() };
  const next = applyTrade(a, trade);
  list[i] = next;
  saveAccounts(list, user, e);
  saveTrades([trade, ...loadTrades(user, e)], user, e);
  return { account: next, trade };
}

export function unapplyTrade(a: ManualAccount, t: ManualTrade): ManualAccount {
  const positions = a.positions.map((p) => ({ ...p }));
  let pos = positions.find((p) => p.ticker === t.ticker);
  const amount = t.qty * t.price;
  let cash = a.cash;
  if (t.side === "buy") {
    if (!pos || pos.qty < t.qty) throw new Error(`계좌의 ${t.name ?? t.ticker} 수량이 체결 기록과 맞지 않아 바꿀 수 없습니다. 계좌 고치기에서 직접 맞춰 주세요.`);
    pos.qty -= t.qty;
    pos.avgPrice = pos.qty > 0 ? t.prevAvg : 0;
    cash += amount + t.fee;
  } else {
    if (!pos) { pos = { ticker: t.ticker, ...(t.name ? { name: t.name } : {}), qty: 0, avgPrice: t.prevAvg }; positions.push(pos); }
    pos.qty += t.qty;
    pos.avgPrice = t.prevAvg;
    cash -= amount - t.fee;
  }
  return { ...a, cash: Math.round(cash), positions: positions.filter((p) => p.qty > 0), updatedAt: new Date().toISOString() };
}

export function rewriteTrade(user: string, accountId: string, tradeId: string, x: any | null, rates: FeeRates, today: string, e: Env = process.env): { account: ManualAccount; trade: ManualTrade | null } {
  const all = loadTrades(user, e);
  const mine = all.filter((t) => t.accountId === accountId);
  const j = mine.findIndex((t) => t.id === tradeId);
  if (j < 0) throw new Error("그 체결 기록을 찾지 못했습니다. 화면을 새로고침해 보세요.");
  const list = loadAccounts(user, e);
  const i = list.findIndex((a) => a.id === accountId);
  if (i < 0) throw new Error("그 계좌를 찾지 못했습니다.");
  const target = mine[j];
  const later = mine.slice(0, j);
  let a = list[i];
  for (const t of later) a = unapplyTrade(a, t);
  a = unapplyTrade(a, target);
  let edited: ManualTrade | null = null;
  if (x) {
    const ticker = normalizeTicker(String(x?.ticker ?? ""));
    const input = { ...x, name: String(x?.name ?? "").trim() || (ticker === target.ticker ? target.name : undefined) };
    const v = parseTrade(input, rates, today, a.positions.find((p) => p.ticker === ticker));
    edited = { id: target.id, accountId, ...v, prevAvg: a.positions.find((p) => p.ticker === v.ticker)?.avgPrice ?? 0, at: target.at };
    try { a = applyTrade(a, edited); }
    catch (err) { throw new Error(`이렇게 고치면 ${(err as Error).message.replace(/ 먼저 계좌의 보유 수량을 맞춰 주세요\.$/, "")}`); }
  }
  const replayed = new Map<string, ManualTrade>();
  for (const t of [...later].reverse()) {
    const r = { ...t, prevAvg: a.positions.find((p) => p.ticker === t.ticker)?.avgPrice ?? 0 };
    try { a = applyTrade(a, r); }
    catch { throw new Error(`이렇게 ${x ? "고치면" : "지우면"} 그 뒤 ${t.date} ${t.name ?? t.ticker} ${t.qty}주 매도를 할 보유가 모자랍니다. 그 매도 기록부터 고치거나 지우세요.`); }
    replayed.set(r.id, r);
  }
  list[i] = a;
  const next = all.flatMap((t) => (t.id === tradeId ? (edited ? [edited] : []) : [replayed.get(t.id) ?? t]));
  saveAccounts(list, user, e);
  saveTrades(next, user, e);
  return { account: a, trade: edited };
}

export function undoLastTrade(user: string, accountId: string, e: Env = process.env): ManualTrade {
  const t = loadTrades(user, e).find((x) => x.accountId === accountId);
  if (!t) throw new Error("되돌릴 체결 기록이 없습니다.");
  rewriteTrade(user, accountId, t.id, null, { commission: 0, sellTax: 0, usCommission: 0, usFx: 0 }, "9999-12-31", e);
  return t;
}

export function loadManualLog(user: string = OWNER_ID, e: Env = process.env): Record<string, EveningReport[]> {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("manual-log.json", user, e), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

export function appendManualLog(accountId: string, r: EveningReport, user: string = OWNER_ID, e: Env = process.env): void {
  const all = loadManualLog(user, e);
  const ids = new Set(loadAccounts(user, e).map((a) => a.id));
  const next: Record<string, EveningReport[]> = {};
  for (const [k, v] of Object.entries(all)) if (ids.has(k)) next[k] = v;
  next[accountId] = [r, ...(next[accountId] ?? []).filter((x) => !(x.runDate === r.runDate && x.trigger === r.trigger))].slice(0, MAX_LOG);
  writeUserFile("manual-log.json", JSON.stringify(next), user, e);
}
