/**
 * 수동 계좌 대시보드용 시세·평가액 기록 (서버 전용).
 *
 *   users/<사용자>/manual-history.json
 *     prices  마지막으로 받은 종가 (보유 종목 모두, 원화)
 *     points  계좌별 하루 한 점: 평가액·예수금·주식·매입 원가·전략 평가액. 한국투자증권 계좌는 "kis"
 *     kis     마지막으로 읽은 한국투자증권 잔고 (대시보드에서 수동 계좌와 함께 보여 줌)
 *     flows   계좌별 입금·출금 (누적 수익률에서 뺌)
 *
 * 매일 저녁 계산 뒤와 화면의 "시세 새로 받기"에서 갱신. 같은 날은 한 점으로 덮어씀.
 */
import fs from "fs";
import { loadData, type DataRequest, type DataResponse } from "../data/server";
import { loadSettings } from "../settings/store";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import { kst, minusDays } from "../auto/time";
import { accountValue, loadAccounts, saveAccounts, type ManualAccount } from "./store";
import { flowIndex, type Flow } from "./returns";

type Env = Record<string, string | undefined>;

export interface Snapshot {
  date: string;
  total: number;
  cash: number;
  stock: number;
  /** 보유 종목 매입 원가 합 (평균단가 × 수량) */
  cost: number;
  /** 그날 저녁 계산의 전략 평가액 (전략이 있을 때) */
  strategy?: number;
  /** 기록한 시각 */
  at?: string;
}

export interface PriceBook {
  /** 받은 시각 */
  at: string;
  map: Record<string, { close: number; date: string; name?: string }>;
  /** 마지막 원/달러 환율 (미국 종목이 있을 때) */
  fx?: number;
}

/** 한국투자증권 계좌 보유 (원화로 맞춘 값) */
export interface KisPosition { ticker: string; name: string; qty: number; avgPrice: number; price: number; value: number }
export interface KisView {
  env: "real" | "mock";
  cash: number;
  total: number;
  positions: KisPosition[];
  at: string;
  /** 미국 잔고를 못 읽었을 때 등 */
  note?: string;
  /** 달러 예수금이 빠진 어림값 (총자산을 못 읽음) */
  partial?: boolean;
}
/** 증권사에서 읽은 그대로. US 는 달러 */
export interface KisRaw {
  env: "real" | "mock";
  kr: { cash: number; total: number; holdings: { code: string; name: string; qty: number; avgPrice: number; price: number; value: number }[] };
  us?: { holdings: { code: string; name: string; qty: number; avgPrice: number; price: number; value: number }[]; totalAsset?: number; cashUsd?: number; fx?: number };
  note?: string;
  /** 달러 예수금을 못 읽었을 때 */
  cashNote?: string;
}

export const KIS_ID = "kis";

export interface History {
  prices: PriceBook | null;
  points: Record<string, Snapshot[]>;
  kis?: KisView | null;
  flows?: Record<string, Flow[]>;
  starts?: Record<string, string>;
}

export const MAX_POINTS = 20_000;

export function loadHistory(user: string = OWNER_ID, e: Env = process.env): History {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("manual-history.json", user, e), "utf8"));
    return { prices: j?.prices ?? null, points: j?.points && typeof j.points === "object" ? j.points : {}, kis: j?.kis ?? null, flows: j?.flows && typeof j.flows === "object" ? j.flows : {}, starts: j?.starts && typeof j.starts === "object" ? j.starts : {} };
  } catch { return { prices: null, points: {}, kis: null, flows: {}, starts: {} }; }
}

export function saveHistory(h: History, user: string = OWNER_ID, e: Env = process.env) {
  writeUserFile("manual-history.json", JSON.stringify(h), user, e);
}

/** 계좌 하나의 지금 모습 (가격을 모르는 종목은 평균단가) */
export function snapshotOf(a: ManualAccount, date: string, prices: PriceBook | null, strategy?: number, at?: string): Snapshot {
  const px = (t: string) => prices?.map[t]?.close;
  const total = accountValue(a, px);
  const cost = a.positions.reduce((s, p) => s + p.qty * p.avgPrice, 0);
  return { date, total: Math.round(total), cash: Math.round(a.cash), stock: Math.round(total - a.cash), cost: Math.round(cost), ...(strategy != null ? { strategy: Math.round(strategy) } : {}), ...(at ? { at } : {}) };
}

/** 점 하나 넣기 (같은 날은 바꿈, 날짜순) */
export function addSnapshot(list: Snapshot[], s: Snapshot): Snapshot[] {
  const prev = list.find((x) => x.date === s.date);
  const merged = prev?.strategy != null && s.strategy == null ? { ...s, strategy: prev.strategy } : s;
  return [...list.filter((x) => x.date !== s.date), merged].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_POINTS);
}

/** 보유 종목 종가 받기 (최근 3주 중 마지막 종가) */
export async function fetchPrices(tickers: string[], e: Env = process.env, load: (q: DataRequest) => Promise<DataResponse> = loadData, now = Date.now()): Promise<PriceBook> {
  const map: PriceBook["map"] = {};
  if (tickers.length) {
    const def = loadSettings(e).backtest;
    const source = def.source === "kis" ? "naver" : def.source;
    const today = kst(now).date;
    const d = await load({ source, start: minusDays(today, 21), end: today, tickers, dividends: false, indices: false });
    for (const t of tickers) {
      const b = d.data[t]?.at(-1);
      if (b && b.close > 0) map[t] = { close: b.close, date: b.date, ...(d.names[t] ? { name: d.names[t] } : {}) };
    }
    const fx = d.fx?.at(-1)?.close;
    if (fx && fx > 0) return { at: new Date(now).toISOString(), map, fx };
  }
  return { at: new Date(now).toISOString(), map };
}

/** 한국투자증권 잔고를 원화로 (미국 보유는 받은 원화 종가, 없으면 달러 × 환율) */
export function kisViewOf(raw: KisRaw, prices: PriceBook | null, now: number): KisView {
  const positions: KisPosition[] = raw.kr.holdings.map((h) => ({ ticker: h.code, name: h.name, qty: h.qty, avgPrice: h.avgPrice, price: h.price, value: h.value || h.qty * h.price }));
  let note = [raw.note, raw.cashNote].filter(Boolean).join(" ") || undefined;
  const fx = raw.us?.fx && raw.us.fx > 0 ? raw.us.fx : prices?.fx;
  let usValue = 0;
  for (const h of raw.us?.holdings ?? []) {
    const krw = prices?.map[h.code]?.close ?? (fx ? h.price * fx : NaN);
    if (!(krw > 0) || !fx) { note = [note, `${h.name || h.code} 은(는) 환율을 몰라 평가에서 뺐습니다.`].filter(Boolean).join(" "); continue; }
    const value = h.qty * krw;
    usValue += value;
    positions.push({ ticker: h.code, name: h.name, qty: h.qty, avgPrice: h.avgPrice * fx, price: krw, value });
  }
  // 평가액 = 국내 총평가(원화 예수금 포함) + 미국 주식 + 달러 예수금 (모두 원화).
  // 실서버(모의) 확인: 매수가능금액의 주문 가능 외화는 실제 달러 예수금과 맞았고,
  // 증권사 "총자산" 조회값(CTRP6504R)은 실제보다 크게 나와 쓰지 않음.
  // 달러 예수금을 못 읽은 날은 달러가 빠진 어림값 → partial (자동 매매 손익에 안 씀)
  const usCashKrw = raw.us?.cashUsd != null && fx ? raw.us.cashUsd * fx : 0;
  const partial = raw.cashNote != null || (raw.us?.cashUsd != null && raw.us.cashUsd > 0 && !fx);
  if (partial && !raw.cashNote) note = [note, "환율을 몰라 달러 예수금을 뺐습니다."].filter(Boolean).join(" ");
  const total = raw.kr.total + usValue + usCashKrw;
  const stock = positions.reduce((a, p) => a + p.value, 0);
  return { env: raw.env, cash: Math.max(0, Math.round(total - stock)), total: Math.round(total), positions, at: new Date(now).toISOString(), ...(note ? { note } : {}), ...(partial ? { partial } : {}) };
}

/**
 * 시세를 새로 받아 모든 계좌의 오늘 점을 기록. strategy 는 계좌별 그날 전략 평가액 (저녁 계산에서).
 * kis 를 주면 한국투자증권 잔고도 읽어 함께 기록 (못 읽으면 경고만).
 * 시세를 못 받으면 예전 시세(없으면 평균단가)로 기록하고 오류를 그대로 던지지 않음 → 돌려주는 warnings 에
 */
export async function refreshHistory(user: string, opts: { e?: Env; load?: (q: DataRequest) => Promise<DataResponse>; now?: number; strategy?: Record<string, number | undefined>; kis?: () => Promise<KisRaw | null> } = {}): Promise<{ history: History; warnings: string[] }> {
  const e = opts.e ?? process.env;
  const now = opts.now ?? Date.now();
  const accounts = loadAccounts(user, e);
  const h = loadHistory(user, e);
  const warnings: string[] = [];
  let raw: KisRaw | null = null;
  if (opts.kis) {
    try { raw = await opts.kis(); } catch (err) { warnings.push(`한국투자증권 잔고를 읽지 못했습니다: ${(err as Error).message}`); }
  }
  const tickers = [...new Set([...accounts.flatMap((a) => a.positions.map((p) => p.ticker)), ...(raw?.us?.holdings ?? []).map((x) => x.code)])];
  try {
    const fresh = await fetchPrices(tickers, e, opts.load, now);
    h.prices = { at: fresh.at, map: { ...(h.prices?.map ?? {}), ...fresh.map }, ...(fresh.fx ?? h.prices?.fx ? { fx: fresh.fx ?? h.prices?.fx } : {}) };
    const miss = tickers.filter((t) => !fresh.map[t]);
    if (miss.length) warnings.push(`시세를 못 받은 종목은 평균단가로 계산했습니다: ${miss.slice(0, 5).join(", ")}${miss.length > 5 ? " 외" : ""}`);
  } catch (err) {
    warnings.push(`시세를 받지 못해 ${h.prices ? "지난번 시세" : "평균단가"}로 계산했습니다: ${(err as Error).message}`);
  }
  const date = kst(now).date;
  const at = new Date(now).toISOString();
  const ids = new Set([...accounts.map((a) => a.id), KIS_ID]);
  const points: History["points"] = {};
  for (const [k, v] of Object.entries(h.points)) if (ids.has(k)) points[k] = v;
  const flows: NonNullable<History["flows"]> = {};
  for (const [k, v] of Object.entries(h.flows ?? {})) if (ids.has(k)) flows[k] = v;
  h.flows = flows;
  for (const a of accounts) points[a.id] = addSnapshot(points[a.id] ?? [], snapshotOf(a, date, h.prices, opts.strategy?.[a.id], at));
  if (raw) {
    h.kis = kisViewOf(raw, h.prices, now);
    const k = h.kis;
    const stock = k.positions.reduce((a, p) => a + p.value, 0);
    points[KIS_ID] = addSnapshot(points[KIS_ID] ?? [], { date, total: k.total, cash: k.cash, stock: Math.round(stock), cost: Math.round(k.positions.reduce((a, p) => a + p.qty * p.avgPrice, 0)), ...(opts.strategy?.[KIS_ID] != null ? { strategy: Math.round(opts.strategy[KIS_ID]!) } : {}), at });
  }
  h.points = points;
  saveHistory(h, user, e);
  return { history: h, warnings };
}

export const MAX_FLOWS = 20_000;

const flowId = () => Math.random().toString(36).slice(2, 10);

function makeFlow(x: { date: string; amount: number; note?: string; auto?: boolean; cash?: boolean }, now: number, id = flowId()): Flow {
  const amount = Math.round(Number(x.amount));
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100_000_000_000) throw new Error("금액을 넣으세요 (입금은 +, 출금은 −).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date)) throw new Error("날짜 형식이 맞지 않습니다.");
  const today = kst(now).date;
  if (x.date > today) throw new Error("앞으로의 날짜는 넣을 수 없습니다.");
  const at = x.date < today ? `${minusDays(x.date, 1)}T15:00:00.000Z` : new Date(now).toISOString();
  const note = String(x.note ?? "").trim().slice(0, 40);
  return { id, date: x.date, amount, at, ...(note ? { note } : {}), ...(x.auto ? { auto: true } : {}), ...(x.cash ? { cash: true } : {}) };
}

const withFlow = (list: Flow[], f: Flow) => [...list, f].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_FLOWS);

/** 지난 날짜로 넣은 입출금: 그 뒤 기록에도 그 돈이 있었던 것으로 고침 */
function shiftPoints(list: Snapshot[], f: Pick<Flow, "date" | "at">, amount: number): Snapshot[] {
  const ps = [...list].sort((a, b) => a.date.localeCompare(b.date));
  const i = flowIndex(ps, f);
  return i < 0 ? ps : ps.map((p, k) => (k >= i ? { ...p, total: p.total + amount, cash: p.cash + amount } : p));
}

/** 입금·출금 넣기 (예수금은 건드리지 않음). 지난 날짜는 그날 기록 전에 한 것으로 본다 */
export function addFlow(user: string, accountId: string, x: { date: string; amount: number; note?: string; auto?: boolean }, e: Env = process.env, now = Date.now()): Flow {
  const f = makeFlow(x, now);
  const h = loadHistory(user, e);
  saveHistory({ ...h, flows: { ...(h.flows ?? {}), [accountId]: withFlow(h.flows?.[accountId] ?? [], f) } }, user, e);
  return f;
}

/**
 * 화면에서 넣는 입금·출금 (id 를 주면 고치기). 수동 계좌는 예수금에도 더하고,
 * 그 뒤 기록과 오늘 기록을 고쳐 누적 수익률이 흔들리지 않게 한다.
 */
export function putFlow(user: string, accountId: string, x: { date: string; amount: number; note?: string }, id?: string, e: Env = process.env, now = Date.now()): { flow: Flow; account: ManualAccount | null } {
  const h = loadHistory(user, e);
  const old = id ? (h.flows?.[accountId] ?? []).find((f) => f.id === id) : undefined;
  if (id && !old) throw new Error("그 입출금 기록을 찾지 못했습니다.");
  const accounts = loadAccounts(user, e);
  const ai = accounts.findIndex((a) => a.id === accountId);
  const useCash = old ? !!old.cash && ai >= 0 : ai >= 0;
  const f = makeFlow({ ...x, cash: useCash }, now, old?.id);
  const left = (h.flows?.[accountId] ?? []).filter((g) => g.id !== id);
  let account: ManualAccount | null = null;
  if (useCash) {
    let points = h.points[accountId] ?? [];
    let cash = accounts[ai].cash;
    if (old) { cash -= old.amount; points = shiftPoints(points, old, -old.amount); }
    cash += f.amount;
    if (cash < 0) throw new Error(`예수금(${Math.round(cash - f.amount).toLocaleString("ko-KR")}원)보다 많이 출금할 수 없습니다.`);
    points = shiftPoints(points, f, f.amount);
    account = { ...accounts[ai], cash, updatedAt: new Date(now).toISOString() };
    accounts[ai] = account;
    saveAccounts(accounts, user, e);
    h.points = { ...h.points, [accountId]: todayPoint(points, account, h.prices, now) };
  }
  saveHistory({ ...h, flows: { ...(h.flows ?? {}), [accountId]: withFlow(left, f) } }, user, e);
  return { flow: f, account };
}

/** 기록이 있는 계좌의 오늘 점을 지금 계좌로 바꿈 */
function todayPoint(list: Snapshot[], a: ManualAccount, prices: PriceBook | null, now: number): Snapshot[] {
  if (!list.length) return list;
  const date = kst(now).date;
  return addSnapshot(list, snapshotOf(a, date, prices, list.find((p) => p.date === date)?.strategy, new Date(now).toISOString()));
}

export function deleteFlow(user: string, id: string, e: Env = process.env, now = Date.now()): ManualAccount | null {
  const h = loadHistory(user, e);
  const owner = Object.keys(h.flows ?? {}).find((k) => h.flows![k].some((f) => f.id === id));
  if (!owner) throw new Error("그 입출금 기록을 찾지 못했습니다.");
  const f = h.flows![owner].find((g) => g.id === id)!;
  let account: ManualAccount | null = null;
  const accounts = f.cash ? loadAccounts(user, e) : [];
  const ai = accounts.findIndex((a) => a.id === owner);
  if (ai >= 0) {
    const cash = accounts[ai].cash - f.amount;
    if (cash < 0) throw new Error("이 입금을 지우면 예수금이 0보다 작아집니다. 그 돈으로 산 체결을 먼저 고치세요.");
    account = { ...accounts[ai], cash, updatedAt: new Date(now).toISOString() };
    accounts[ai] = account;
    saveAccounts(accounts, user, e);
    h.points = { ...h.points, [owner]: todayPoint(shiftPoints(h.points[owner] ?? [], f, -f.amount), account, h.prices, now) };
  }
  saveHistory({ ...h, flows: { ...h.flows, [owner]: h.flows![owner].filter((g) => g.id !== id) } }, user, e);
  return account;
}

/**
 * 수동 계좌를 고쳐 평가액이 달라지면 그 차이를 입출금으로 남기고 오늘 기록도 고친 값으로 바꾼다.
 * 기록이 아직 없는 계좌는 첫 기록이 출발점이라 남기지 않음.
 */
export function recordEdit(user: string, prev: ManualAccount, next: ManualAccount, e: Env = process.env, now = Date.now()): Flow | null {
  const h = loadHistory(user, e);
  const list = h.points[next.id] ?? [];
  if (!list.length) return null;
  const px = (t: string) => h.prices?.map[t]?.close;
  const diff = Math.round(accountValue(next, px) - accountValue(prev, px));
  const date = kst(now).date;
  const at = new Date(now).toISOString();
  const strategy = list.find((p) => p.date === date)?.strategy;
  const points = { ...h.points, [next.id]: addSnapshot(list, snapshotOf(next, date, h.prices, strategy, at)) };
  saveHistory({ ...h, points }, user, e);
  if (diff === 0) return null;
  return addFlow(user, next.id, { date, amount: diff, note: "계좌 고침", auto: true }, e, now - 1);
}

/** 입출금이 아닌 돈(배당·이자·비용)을 수동 계좌 예수금에 더하고, 그날부터의 기록도 같은 돈만큼 옮김 */
export function moveCash(user: string, accountId: string, date: string, amount: number, e: Env = process.env, now = Date.now()): ManualAccount {
  const accounts = loadAccounts(user, e);
  const ai = accounts.findIndex((a) => a.id === accountId);
  if (ai < 0) throw new Error("그 계좌를 찾지 못했습니다.");
  const cash = Math.round(accounts[ai].cash + amount);
  if (cash < 0) throw new Error(`예수금(${Math.round(accounts[ai].cash).toLocaleString("ko-KR")}원)이 모자랍니다.`);
  const account = { ...accounts[ai], cash, updatedAt: new Date(now).toISOString() };
  accounts[ai] = account;
  saveAccounts(accounts, user, e);
  const h = loadHistory(user, e);
  const at = date < kst(now).date ? `${minusDays(date, 1)}T15:00:00.000Z` : new Date(now).toISOString();
  h.points = { ...h.points, [accountId]: todayPoint(shiftPoints(h.points[accountId] ?? [], { date, at }, Math.round(amount)), account, h.prices, now) };
  saveHistory(h, user, e);
  return account;
}

export function setReturnStart(user: string, accountId: string, date: string | null, e: Env = process.env): Record<string, string> {
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("날짜 형식이 아닙니다 (예: 2026-11-20).");
  const h = loadHistory(user, e);
  const starts = { ...(h.starts ?? {}) };
  if (date) starts[accountId] = date; else delete starts[accountId];
  saveHistory({ ...h, starts }, user, e);
  return starts;
}
