/**
 * 계좌 과거 기록 저장 (서버 전용).
 *
 *   users/<사용자>/account-ledger.json
 *     entries  계좌별 과거 기록 (lib/accounts/ledger.ts LedgerEntry)
 *     built    계좌별 다시 계산한 과거 평가액·입출금 (기록이나 앱 첫 기록일이 바뀌면 다시 계산)
 */
import fs from "fs";
import { randomBytes } from "crypto";
import { loadData, cachedDaily } from "../data/server";
import { fetchYahooDaily, USDKRW } from "../data/yahoo";
import { loadSettings } from "../settings/store";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import { kst, minusDays } from "../auto/time";
import { loadHistory, moveCash, type History } from "../manual/value";
import { buildLedger, isFundCode, ledgerKey, mergeSeries, LIVE_KINDS, KIND_LABEL, type Built, type EntryInput, type Join, type LedgerEntry, type PriceSet } from "./ledger";
import type { Flow } from "../manual/returns";
import type { Snapshot } from "../manual/value";

type Env = Record<string, string | undefined>;

export const MAX_ENTRIES = 20_000;

interface LedgerFile { entries: Record<string, LedgerEntry[]>; built: Record<string, Built> }

export function loadLedger(user: string = OWNER_ID, e: Env = process.env): LedgerFile {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("account-ledger.json", user, e), "utf8"));
    return { entries: j?.entries && typeof j.entries === "object" ? j.entries : {}, built: j?.built && typeof j.built === "object" ? j.built : {} };
  } catch { return { entries: {}, built: {} }; }
}

function saveLedger(f: LedgerFile, user: string, e: Env) {
  writeUserFile("account-ledger.json", JSON.stringify(f), user, e);
}

/** 과거 기록이 다루는 마지막 날 = 앱이 처음 평가액을 기록한 날 (없으면 오늘) */
export function upToOf(h: History, accountId: string, today: string): { upTo: string; started: boolean } {
  const first = [...(h.points[accountId] ?? [])].sort((a, b) => a.date.localeCompare(b.date))[0]?.date;
  return first ? { upTo: first, started: true } : { upTo: today, started: false };
}

const sameEntry = (a: EntryInput, b: EntryInput) =>
  a.date === b.date && a.kind === b.kind && (a.ticker ?? "") === (b.ticker ?? "") && (a.qty ?? 0) === (b.qty ?? 0) && (a.price ?? 0) === (b.price ?? 0) && (a.amount ?? 0) === (b.amount ?? 0) && (a.currency ?? "") === (b.currency ?? "");

export interface AddResult { added: LedgerEntry[]; skipped: { index: number; error: string }[] }

/**
 * 기록 넣기. 앱 기록이 시작된 날부터는 배당·이자·비용만 받고(수동 계좌 예수금에 바로 반영),
 * 매매·입출금은 계좌 화면의 체결 기록·입금·출금으로 넣도록 건너뜀. 이미 있는 것과 똑같은 기록도 건너뜀.
 */
export function addEntries(user: string, accountId: string, inputs: EntryInput[], opts: { manual: boolean; bulk?: boolean; e?: Env; now?: number }): AddResult {
  const e = opts.e ?? process.env;
  const now = opts.now ?? Date.now();
  const f = loadLedger(user, e);
  const before = f.entries[accountId] ?? [];
  const list = [...before];
  const { upTo, started } = upToOf(loadHistory(user, e), accountId, kst(now).date);
  const added: LedgerEntry[] = [];
  const skipped: AddResult["skipped"] = [];
  inputs.forEach((x, index) => {
    try {
      if (list.length >= MAX_ENTRIES) throw new Error(`계좌마다 ${MAX_ENTRIES.toLocaleString("ko-KR")}건까지 넣을 수 있습니다.`);
      if (before.some((y) => sameEntry(x, y))) throw new Error("이미 있는 기록이라 건너뛰었습니다.");
      const at = new Date(now + index).toISOString();
      const entry: LedgerEntry = { ...x, id: randomBytes(5).toString("hex"), at };
      if (started && x.date >= upTo) {
        if (opts.bulk) throw new Error(`${upTo}부터는 앱이 이 계좌를 기록하고 있어 예수금·보유에 이미 들어 있으므로 넣지 않았습니다.`);
        if (!LIVE_KINDS.includes(x.kind)) throw new Error(`${upTo}부터는 앱이 기록 중이라 ${KIND_LABEL[x.kind]}은(는) 계좌 화면의 ${x.kind === "deposit" || x.kind === "withdraw" ? "입금·출금" : x.kind === "buy" || x.kind === "sell" ? "체결 기록" : "계좌 고치기"}으로 넣으세요.`);
        if (!opts.manual) throw new Error(`${upTo}부터의 ${KIND_LABEL[x.kind]}은(는) 증권사 잔고에 이미 들어 있습니다.`);
        if (x.currency === "USD") throw new Error("앱 기록이 시작된 뒤의 배당·이자·비용은 원화로 넣으세요.");
        moveCash(user, accountId, x.date, x.kind === "fee" ? -x.amount! : x.amount!, e, now);
        entry.live = true;
      }
      list.push(entry);
      added.push(entry);
    } catch (err) { skipped.push({ index, error: (err as Error).message }); }
  });
  const g = loadLedger(user, e);
  saveLedger({ ...g, entries: { ...g.entries, [accountId]: list } }, user, e);
  return { added, skipped };
}

export function editEntry(user: string, accountId: string, id: string, x: EntryInput, opts: { e?: Env; now?: number } = {}): LedgerEntry {
  const e = opts.e ?? process.env;
  const f = loadLedger(user, e);
  const list = f.entries[accountId] ?? [];
  const old = list.find((y) => y.id === id);
  if (!old) throw new Error("그 기록을 찾지 못했습니다. 화면을 새로고침해 보세요.");
  if (old.live) throw new Error("예수금에 바로 더한 기록은 지우고 다시 넣으세요.");
  const { upTo, started } = upToOf(loadHistory(user, e), accountId, kst(opts.now).date);
  if (started && x.date >= upTo) throw new Error(`과거 기록은 앱 기록이 시작된 ${upTo} 전 날짜만 넣을 수 있습니다.`);
  const next: LedgerEntry = { ...x, id, at: old.at };
  saveLedger({ ...f, entries: { ...f.entries, [accountId]: list.map((y) => (y.id === id ? next : y)) } }, user, e);
  return next;
}

export function deleteEntry(user: string, accountId: string, id: string, opts: { e?: Env; now?: number } = {}): void {
  const e = opts.e ?? process.env;
  const f = loadLedger(user, e);
  const list = f.entries[accountId] ?? [];
  const old = list.find((y) => y.id === id);
  if (!old) throw new Error("그 기록을 찾지 못했습니다. 화면을 새로고침해 보세요.");
  if (old.live) moveCash(user, accountId, old.date, old.kind === "fee" ? old.amount! : -old.amount!, e, opts.now);
  const g = loadLedger(user, e);
  saveLedger({ ...g, entries: { ...g.entries, [accountId]: list.filter((y) => y.id !== id) } }, user, e);
}

/** 과거 기록 모두 지우기 (예수금에 바로 더한 기록은 남김) */
export function clearEntries(user: string, accountId: string, e: Env = process.env): number {
  const f = loadLedger(user, e);
  const list = f.entries[accountId] ?? [];
  const keep = list.filter((y) => y.live);
  const built = { ...f.built };
  delete built[accountId];
  saveLedger({ entries: { ...f.entries, [accountId]: keep }, built }, user, e);
  return list.length - keep.length;
}

export function dropAccount(user: string, accountId: string, e: Env = process.env): void {
  const f = loadLedger(user, e);
  if (!f.entries[accountId] && !f.built[accountId]) return;
  const entries = { ...f.entries }; delete entries[accountId];
  const built = { ...f.built }; delete built[accountId];
  saveLedger({ entries, built }, user, e);
}

export type PriceLoader = (tickers: string[], start: string, end: string, usd: boolean, onProgress?: (done: number, total: number) => void) => Promise<PriceSet>;

export const loadPriceSet: PriceLoader = async (tickers, start, end, usd, onProgress) => {
  const out: PriceSet = { data: {}, names: {}, warnings: [] };
  if (tickers.length) {
    const def = loadSettings().backtest;
    const source = def.source === "kis" ? "naver" : def.source;
    try {
      const d = await loadData({ source, start: minusDays(start, 14), end, tickers, dividends: false, indices: false }, { onProgress });
      for (const [t, bars] of Object.entries(d.data)) out.data[t] = bars.map((b) => ({ date: b.date, close: b.close }));
      out.names = d.names;
      out.warnings = d.warnings.filter((w) => !/KOSPI 지수|비교 지수|S&P 500 비교/.test(w));
      if (d.fx?.length) out.fx = d.fx;
    } catch (err) { out.warnings!.push(`시세를 받지 못해 거래 가격으로 평가했습니다: ${(err as Error).message}`); }
  }
  if (usd && !out.fx?.length) {
    try { out.fx = (await cachedDaily(USDKRW, minusDays(start, 14), "yahoo", fetchYahooDaily)).map((b) => ({ date: b.date, close: b.close })); }
    catch (err) { out.warnings!.push(`원/달러 환율을 받지 못했습니다: ${(err as Error).message}`); }
  }
  return out;
};

/** 과거 기록으로 그날그날 평가액 다시 만들기 (시세를 받느라 오래 걸릴 수 있음 → 작업으로) */
export async function rebuildAccount(user: string, accountId: string, opts: { e?: Env; load?: PriceLoader; now?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<Built | null> {
  const e = opts.e ?? process.env;
  const now = opts.now ?? Date.now();
  const entries = (loadLedger(user, e).entries[accountId] ?? []).filter((x) => !x.live);
  const { upTo } = upToOf(loadHistory(user, e), accountId, kst(now).date);
  let built: Built | null = null;
  if (entries.length) {
    const from = entries.reduce((m, x) => (x.date < m ? x.date : m), upTo);
    const tickers = [...new Set(entries.filter((x) => x.ticker && ["buy", "sell", "in", "out"].includes(x.kind)).map((x) => x.ticker!))].filter((t) => !isFundCode(t));
    const usd = entries.some((x) => x.currency === "USD") || tickers.some((t) => /^[A-Z]/.test(t));
    const px = await (opts.load ?? loadPriceSet)(tickers, from, upTo, usd, opts.onProgress);
    built = buildLedger(entries, upTo, px, now);
  }
  const f = loadLedger(user, e);
  const all = { ...f.built };
  if (built) all[accountId] = built; else delete all[accountId];
  saveLedger({ ...f, built: all }, user, e);
  return built;
}

export interface LedgerStatus {
  count: number;
  upTo: string;
  started: boolean;
  stale: boolean;
  built: Omit<Built, "points" | "flows"> | null;
  join: Join | null;
}

export function ledgerStatus(user: string, accountId: string, e: Env = process.env, now = Date.now()): { entries: LedgerEntry[]; status: LedgerStatus } {
  const f = loadLedger(user, e);
  const h = loadHistory(user, e);
  const entries = f.entries[accountId] ?? [];
  const { upTo, started } = upToOf(h, accountId, kst(now).date);
  const b = f.built[accountId];
  const past = entries.filter((x) => !x.live);
  const stale = past.length ? !b || b.key !== ledgerKey(entries, upTo) : !!b;
  const merged = mergeSeries(h.points[accountId] ?? [], h.flows?.[accountId] ?? [], b);
  const { points: _p, flows: _f, ...rest } = b ?? ({} as Built);
  return { entries, status: { count: past.length, upTo, started, stale, built: b ? rest : null, join: merged.join ?? null } };
}

/** 모든 계좌: 앱 기록 + 과거 기록을 합친 평가액과 수익률 계산용 입출금 */
export function mergedHistory(user: string, h: History = loadHistory(user), e: Env = process.env): { points: Record<string, Snapshot[]>; flows: Record<string, Flow[]> } {
  const built = loadLedger(user, e).built;
  const points: Record<string, Snapshot[]> = {};
  const flows: Record<string, Flow[]> = {};
  for (const id of new Set([...Object.keys(h.points), ...Object.keys(h.flows ?? {}), ...Object.keys(built)])) {
    const m = mergeSeries(h.points[id] ?? [], h.flows?.[id] ?? [], built[id]);
    const start = h.starts?.[id];
    points[id] = start ? m.points.filter((p) => p.date >= start) : m.points;
    flows[id] = start ? m.flows.filter((f) => f.date > start) : m.flows;
  }
  return { points, flows };
}
