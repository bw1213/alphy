/**
 * 계좌 과거 기록: 입금·출금·매수·매도·배당·이자·비용·입고·출고.
 * 과거 기록으로 그날그날 보유·예수금을 다시 만들고 실제 시세로 평가해, 앱이 기록하기 전 기간의 평가액·입출금을 채운다.
 * 앱 기록이 시작된 날(첫 평가액 기록)부터는 앱 기록을 쓰고, 그 사이 차이는 수익으로 치지 않고 이어 붙인다.
 */
import { isUsTicker, normalizeTicker } from "../data/market";
import { minusDays } from "../auto/time";
import type { FeeRates } from "../manual/store";
import { flowIndex, type Flow } from "../manual/returns";
import type { Snapshot } from "../manual/value";

export type LedgerKind = "deposit" | "withdraw" | "buy" | "sell" | "dividend" | "interest" | "fee" | "in" | "out";

export const KIND_LABEL: Record<LedgerKind, string> = {
  deposit: "입금", withdraw: "출금", buy: "매수", sell: "매도", dividend: "배당", interest: "이자", fee: "비용", in: "입고", out: "출고",
};
export const STOCK_KINDS: LedgerKind[] = ["buy", "sell", "in", "out"];
export const isFundCode = (t: string) => /^KR[0-9A-Z]{10}$/.test(t);
export const CASH_KINDS: LedgerKind[] = ["deposit", "withdraw", "dividend", "interest", "fee"];
/** 앱 기록이 시작된 뒤에도 넣을 수 있는 것 (수동 계좌 예수금에 바로 반영) */
export const LIVE_KINDS: LedgerKind[] = ["dividend", "interest", "fee"];

export interface LedgerEntry {
  id: string;
  date: string;
  kind: LedgerKind;
  ticker?: string;
  name?: string;
  qty?: number;
  /** 1주 가격 (currency 단위). 입고·출고는 비우면 그날 종가 */
  price?: number;
  /** 입금·출금·배당·이자·비용 금액 (currency 단위, 양수) */
  amount?: number;
  /** 매매 수수료·세금 (currency 단위) */
  fee?: number;
  currency?: "USD";
  note?: string;
  /** 앱 기록 시작 뒤 넣어 계좌 예수금에 바로 더한 기록 */
  live?: boolean;
  at: string;
}

export type EntryInput = Omit<LedgerEntry, "id" | "at">;

const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[,\s원$₩]/g, "").replace(/^\((.*)\)$/, "-$1")));
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

export function parseDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) m = s.match(/^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? d : null;
}

export function parseKind(v: unknown): LedgerKind | null {
  const s = String(v ?? "").replace(/\s/g, "").toLowerCase();
  if (!s) return null;
  if (/^(deposit|withdraw|buy|sell|dividend|interest|fee|in|out)$/.test(s)) return s as LedgerKind;
  if (s.includes("입고")) return "in";
  if (s.includes("출고")) return "out";
  if (/매수|매입|사기|^buy/.test(s)) return "buy";
  if (/매도|팔기|^sell/.test(s)) return "sell";
  if (/배당|분배|dividend/.test(s)) return "dividend";
  if (/이자|interest/.test(s)) return "interest";
  if (/입금|deposit/.test(s)) return "deposit";
  if (/출금|withdraw/.test(s)) return "withdraw";
  if (/수수료|세금|비용|fee|tax/.test(s)) return "fee";
  return null;
}

/** "삼성전자 (005930)", "005930", "AAPL" → 코드. 이름만 있으면 find 로 찾음 */
export function resolveTicker(raw: unknown, find?: (name: string) => { code: string; name: string } | null): { ticker: string; name?: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(.*?)\s*\(([0-9A-Za-z.\-/]+)\)\s*$/);
  const code = (x: string) => (isFundCode(x.toUpperCase()) ? x.toUpperCase() : normalizeTicker(x));
  if (m) { const t = code(m[2]); if (t) return { ticker: t, ...(m[1].trim() ? { name: m[1].trim() } : {}) }; }
  const byName = /[가-힣]/.test(s) || /\s/.test(s) ? find?.(s) : null;
  if (byName) return { ticker: byName.code, name: byName.name };
  const t = code(s);
  if (t) return { ticker: t };
  const again = find?.(s);
  return again ? { ticker: again.code, name: again.name } : null;
}

export interface CleanCtx {
  today: string;
  rates: FeeRates;
  find?: (name: string) => { code: string; name: string } | null;
}

/** 화면·붙여넣기에서 받은 한 줄 → 기록. 틀리면 알아볼 수 있는 말로 오류 */
export function cleanEntry(x: any, ctx: CleanCtx): EntryInput {
  const date = parseDate(x?.date);
  if (!date) throw new Error("날짜를 알아보지 못했습니다 (예: 2021-03-05).");
  if (date > ctx.today) throw new Error("앞으로의 날짜는 넣을 수 없습니다.");
  if (date < "1980-01-01") throw new Error("날짜가 너무 이릅니다.");
  const kind = parseKind(x?.kind);
  if (!kind) throw new Error("구분을 알아보지 못했습니다 (입금·출금·매수·매도·배당·이자·비용·입고·출고).");
  const cur = String(x?.currency ?? "").trim().toUpperCase();
  const usd = cur === "USD" || cur === "$" || cur === "달러" || /\$/.test(String(x?.price ?? "")) || /\$/.test(String(x?.amount ?? ""));
  const note = String(x?.note ?? "").trim().slice(0, 60);
  const out: EntryInput = { date, kind, ...(usd ? { currency: "USD" as const } : {}), ...(note ? { note } : {}) };
  const tk = blank(x?.ticker) ? null : resolveTicker(x.ticker, ctx.find);
  const givenName = String(x?.name ?? "").trim().slice(0, 60);
  if (STOCK_KINDS.includes(kind)) {
    if (!tk) throw new Error(blank(x?.ticker) ? "종목을 넣으세요." : `종목 "${String(x.ticker).slice(0, 20)}"을(를) 찾지 못했습니다. 코드로 넣어 보세요.`);
    const qty = num(x?.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) throw new Error("수량을 넣으세요.");
    let price = blank(x?.price) ? NaN : Math.abs(num(x.price));
    const amount = blank(x?.amount) ? NaN : Math.abs(num(x.amount));
    if (!(price > 0) && amount > 0) price = amount / qty;
    if ((kind === "buy" || kind === "sell") && !(price > 0)) throw new Error("체결 가격(또는 금액)을 넣으세요.");
    out.ticker = tk.ticker;
    const name = givenName || tk.name;
    if (name) out.name = name;
    out.qty = +qty.toFixed(8);
    if (price > 0) out.price = +price.toFixed(usd ? 4 : 2);
    if (kind === "buy" || kind === "sell") {
      const fee = blank(x?.fee) ? (qty * price * (isUsTicker(tk.ticker) ? ctx.rates.usCommission + ctx.rates.usFx : ctx.rates.commission + (kind === "sell" ? ctx.rates.sellTax : 0))) / 100 : Math.abs(num(x.fee));
      if (!Number.isFinite(fee)) throw new Error("수수료·세금을 확인하세요.");
      out.fee = +fee.toFixed(usd ? 2 : 0);
    }
  } else {
    const amount = blank(x?.amount) ? (num(x?.qty) > 0 && num(x?.price) > 0 ? num(x.qty) * num(x.price) : NaN) : Math.abs(num(x.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw new Error("금액을 넣으세요.");
    out.amount = +amount.toFixed(usd ? 2 : 0);
    if (tk) { out.ticker = tk.ticker; const name = givenName || tk.name; if (name) out.name = name; }
  }
  return out;
}

const HEAD: [keyof Row, RegExp][] = [
  ["date", /날짜|일자|거래일|체결일|date/i],
  ["amount", /금액|amount|total/i],
  ["fee", /수수료|세금|fee|tax|commission/i],
  ["price", /단가|가격|체결가|price/i],
  ["qty", /수량|qty|shares|quantity/i],
  ["ticker", /종목|코드|티커|ticker|symbol|code/i],
  ["currency", /통화|currency/i],
  ["note", /메모|비고|적요|note|memo/i],
  ["kind", /구분|종류|거래|유형|type|kind/i],
];
const ORDER: (keyof Row)[] = ["date", "kind", "ticker", "qty", "price", "amount", "fee", "currency", "note"];

interface Row { date?: string; kind?: string; ticker?: string; qty?: string; price?: string; amount?: string; fee?: string; currency?: string; note?: string }

function splitLine(line: string, sep: string): string[] {
  if (sep === "\t") return line.split("\t").map((c) => c.trim());
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export interface ParsedLine { line: number; entry?: EntryInput; error?: string; text: string }

/**
 * 엑셀에서 복사한 표(탭) 또는 CSV. 첫 줄이 제목 줄이면 열 이름으로 맞추고,
 * 아니면 날짜, 구분, 종목, 수량, 가격, 금액, 수수료, 통화, 메모 순서.
 */
export function parseLedgerText(text: string, ctx: CleanCtx, max = 5000): ParsedLine[] {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l, i) => ({ l, i: i + 1 })).filter((x) => x.l.trim());
  if (!lines.length) return [];
  const sep = lines.some((x) => x.l.includes("\t")) ? "\t" : lines.some((x) => x.l.includes(";")) && !lines.some((x) => x.l.includes(",")) ? ";" : ",";
  let cols: (keyof Row | null)[] = ORDER;
  const first = splitLine(lines[0].l, sep);
  const fees: number[] = [];
  if (!parseDate(first[0]) && first.some((c) => HEAD.some(([, re]) => re.test(c)))) {
    cols = first.map((c, k) => {
      const hit = HEAD.find(([, re]) => re.test(c));
      if (hit?.[0] === "fee") fees.push(k);
      return hit?.[0] ?? null;
    });
    lines.shift();
  }
  return lines.slice(0, max).map(({ l, i }) => {
    const cells = splitLine(l, sep);
    const row: Row = {};
    cols.forEach((key, k) => { if (key && key !== "fee" && cells[k] !== undefined && row[key] === undefined) row[key] = cells[k]; });
    const feeCells = (fees.length ? fees : cols.map((c, k) => (c === "fee" ? k : -1)).filter((k) => k >= 0)).map((k) => cells[k]).filter((c) => !blank(c));
    if (feeCells.length) row.fee = String(feeCells.reduce((s, c) => s + Math.abs(num(c)), 0));
    try { return { line: i, entry: cleanEntry(row, ctx), text: l }; }
    catch (e) { return { line: i, error: (e as Error).message, text: l }; }
  });
}

export function toCsv(list: LedgerEntry[]): string {
  const esc = (v: unknown) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at)).map((x) => [
    x.date, KIND_LABEL[x.kind], x.ticker ? (x.name ? `${x.name} (${x.ticker})` : x.ticker) : "", x.qty ?? "", x.price ?? "", x.amount ?? "", x.fee ?? "", x.currency ?? "", x.note ?? "",
  ].map(esc).join(","));
  return ["날짜,구분,종목,수량,가격,금액,수수료,통화,메모", ...rows].join("\n");
}

// ── 다시 만들기 ──

export interface Bars { date: string; close: number }
export interface PriceSet {
  /** 원화 종가 (미국 종목도 원화) */
  data: Record<string, Bars[]>;
  fx?: Bars[];
  names?: Record<string, string>;
  warnings?: string[];
}

export interface LedgerSums { deposit: number; withdraw: number; dividend: number; interest: number; fee: number; tradeFee: number; transferIn: number; transferOut: number }

export interface Built {
  key: string;
  at: string;
  from: string;
  upTo: string;
  count: number;
  points: Snapshot[];
  flows: Flow[];
  end: { cash: number; positions: { ticker: string; name?: string; qty: number; value: number }[] };
  sums: LedgerSums;
  warnings: string[];
}

function lastOn(bars: Bars[] | undefined, date: string): number | undefined {
  if (!bars?.length || bars[0].date > date) return undefined;
  let lo = 0, hi = bars.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].date <= date) { k = m; lo = m + 1; } else hi = m - 1; }
  return bars[k].close;
}

/** 체결 가격이 그날 종가의 정수배면 액면분할 전 수량으로 봄 (수정주가 시세와 맞추기) */
export function splitFactor(price: number, close: number | undefined): number {
  if (!close || !(price > 0)) return 1;
  const r = price / close;
  if (r >= 1.8) { const k = Math.round(r); if (k <= 100 && Math.abs(r - k) / k < 0.15) return k; }
  if (r <= 0.55) { const k = Math.round(1 / r); if (k >= 2 && k <= 100 && Math.abs(1 / r - k) / k < 0.15) return 1 / k; }
  return 1;
}

export const startOfDay = (date: string) => `${minusDays(date, 1)}T15:00:00.000Z`;

/** 기록 순서를 바꾸지 않는 열쇠 (기록·기준일이 바뀌면 다시 계산) */
export function ledgerKey(list: LedgerEntry[], upTo: string): string {
  const past = list.filter((x) => !x.live);
  const s = upTo + JSON.stringify(past.map((x) => [x.id, x.date, x.kind, x.ticker, x.qty, x.price, x.amount, x.fee, x.currency]));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${past.length}-${h.toString(36)}`;
}

export function buildLedger(all: LedgerEntry[], upTo: string, px: PriceSet, now = Date.now()): Built | null {
  const list = all.filter((x) => !x.live && x.date <= upTo).sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  if (!list.length) return null;
  const warnings: string[] = [...(px.warnings ?? [])];
  const warned = new Set<string>();
  const warn = (k: string, msg: string) => { if (!warned.has(k)) { warned.add(k); warnings.push(msg); } };
  const fx = px.fx ?? [];
  const fxOn = (d: string) => lastOn(fx, d) ?? (fx.length ? fx[0].close : undefined);
  const from = list[0].date;
  const dates = new Set<string>([upTo, ...list.map((x) => x.date)]);
  const tickers = [...new Set(list.filter((x) => STOCK_KINDS.includes(x.kind)).map((x) => x.ticker!))];
  for (const t of tickers) {
    const bars = px.data[t];
    if (!bars?.length) warn(`nodata:${t}`, isFundCode(t) ? `${nameOf(t)}: 펀드는 기준가를 받지 못해 마지막 거래 기준가로 평가했습니다.` : `${nameOf(t)} 시세를 받지 못해 마지막 거래 가격으로 평가했습니다.`);
    for (const b of bars ?? []) if (b.date >= from && b.date <= upTo) dates.add(b.date);
  }
  function nameOf(t: string) { const n = list.find((x) => x.ticker === t && x.name)?.name ?? px.names?.[t]; return n ? `${n} (${t})` : t; }
  const byDate = new Map<string, LedgerEntry[]>();
  for (const x of list) byDate.set(x.date, [...(byDate.get(x.date) ?? []), x]);

  let cash = 0;
  const pos = new Map<string, { q: number; cost: number; last: number }>();
  const sums: LedgerSums = { deposit: 0, withdraw: 0, dividend: 0, interest: 0, fee: 0, tradeFee: 0, transferIn: 0, transferOut: 0 };
  const points: Snapshot[] = [];
  const flows: Flow[] = [];
  const P = (t: string) => { let p = pos.get(t); if (!p) { p = { q: 0, cost: 0, last: 0 }; pos.set(t, p); } return p; };
  const flow = (x: LedgerEntry, amount: number, note: string) => {
    if (Math.round(amount)) flows.push({ id: `L${x.id}`, date: x.date, amount: Math.round(amount), at: startOfDay(x.date), note, auto: true });
  };

  for (const d of [...dates].filter((x) => x >= from && x <= upTo).sort()) {
    for (const x of byDate.get(d) ?? []) {
      let k = 1;
      if (x.currency === "USD") {
        const r = fxOn(d);
        if (!r) { warn(`fx:${x.id}`, `${d} 원/달러 환율을 몰라 ${KIND_LABEL[x.kind]} 기록 하나를 뺐습니다.`); continue; }
        k = r;
      }
      if (STOCK_KINDS.includes(x.kind)) {
        const t = x.ticker!;
        const close = lastOn(px.data[t], d);
        const p = P(t);
        let price = x.price != null ? x.price * k : undefined;
        if (price != null && x.currency !== "USD" && isUsTicker(t) && close) {
          const r = fxOn(d);
          if (r && Math.abs((price * r) / close - 1) < 0.3) { price *= r; k = r; warn(`usd:${t}`, `${nameOf(t)} 가격이 달러로 보여 그날 환율로 원화로 바꿨습니다. 원화로 넣은 것이면 고쳐 주세요.`); }
        }
        const f = price != null ? splitFactor(price, close) : 1;
        if (f !== 1) warn(`split:${t}:${f}`, `${nameOf(t)}: 거래 가격이 그날 시세의 ${f > 1 ? `${f}배` : `1/${Math.round(1 / f)}`}라 액면분할 전 수량으로 보고 맞춰 계산했습니다.`);
        const per = price != null ? price / f : close ?? p.last;
        if (!(per > 0)) { warn(`noprice:${x.id}`, `${d} ${nameOf(t)} ${KIND_LABEL[x.kind]}: 가격을 몰라 뺐습니다. 가격을 넣어 주세요.`); continue; }
        const aq = x.qty! * f;
        const fee = (x.fee ?? 0) * k;
        if (x.kind === "buy" || x.kind === "in") {
          p.q += aq;
          p.cost += aq * per + fee;
          p.last = per;
          if (x.kind === "buy") { cash -= aq * per + fee; sums.tradeFee += fee; }
          else { sums.transferIn += aq * per; flow(x, aq * per, "과거 기록: 입고"); }
        } else {
          if (p.q < aq - 1e-9) {
            const short = aq - p.q;
            warn(`short:${t}`, `${nameOf(t)}: 가진 것보다 많이 팔거나 출고한 기록이 있어 모자란 수량은 그날 입고된 것으로 봤습니다. 그 전 매수·입고 기록을 넣으면 더 정확해집니다.`);
            p.q += short; p.cost += short * per;
            sums.transferIn += short * per;
            flow({ ...x, id: `${x.id}s` }, short * per, "과거 기록: 모자란 보유");
          }
          p.cost *= p.q > 0 ? (p.q - aq) / p.q : 0;
          p.q -= aq;
          p.last = per;
          if (x.kind === "sell") { cash += aq * per - fee; sums.tradeFee += fee; }
          else { sums.transferOut += aq * per; flow(x, -aq * per, "과거 기록: 출고"); }
          if (p.q < 1e-9) pos.delete(t);
        }
      } else {
        const a = (x.amount ?? 0) * k;
        if (x.kind === "deposit") { cash += a; sums.deposit += a; flow(x, a, "과거 기록: 입금"); }
        else if (x.kind === "withdraw") { cash -= a; sums.withdraw += a; flow(x, -a, "과거 기록: 출금"); }
        else if (x.kind === "dividend") { cash += a; sums.dividend += a; }
        else if (x.kind === "interest") { cash += a; sums.interest += a; }
        else { cash -= a; sums.fee += a; }
      }
    }
    if (cash < -1) warn("negcash", `${d}에 예수금이 마이너스가 됩니다. 그 전 입금 기록이 빠졌을 수 있습니다.`);
    let stock = 0, cost = 0;
    for (const [t, p] of pos) { stock += p.q * (lastOn(px.data[t], d) ?? p.last); cost += p.cost; }
    points.push({ date: d, total: Math.round(cash + stock), cash: Math.round(cash), stock: Math.round(stock), cost: Math.round(cost) });
  }
  const r = (n: number) => Math.round(n);
  return {
    key: ledgerKey(all, upTo), at: new Date(now).toISOString(), from, upTo, count: list.length, points, flows,
    end: { cash: r(cash), positions: [...pos].map(([t, p]) => ({ ticker: t, ...(list.find((x) => x.ticker === t && x.name)?.name ?? px.names?.[t] ? { name: list.find((x) => x.ticker === t && x.name)?.name ?? px.names?.[t] } : {}), qty: +p.q.toFixed(6), value: r(p.q * (lastOn(px.data[t], upTo) ?? p.last)) })) },
    sums: Object.fromEntries(Object.entries(sums).map(([k2, v]) => [k2, r(v)])) as unknown as LedgerSums,
    warnings,
  };
}

export interface Join { date: string; past: number; live: number }

/**
 * 과거 기록으로 만든 평가액 + 앱 기록을 하나로. 앱 첫 기록 전 날까지는 과거 기록,
 * 앱 첫 기록과 과거 기록의 그날 평가액 차이는 입출금으로 넣어 수익률에 섞이지 않게 함.
 */
export function mergeSeries(live: Snapshot[], liveFlows: Flow[], built?: Built | null): { points: Snapshot[]; flows: Flow[]; join?: Join } {
  if (!built?.points.length) return { points: live, flows: liveFlows };
  const ps = [...live].sort((a, b) => a.date.localeCompare(b.date));
  if (!ps.length) return { points: built.points, flows: built.flows };
  const cut = ps[0].date;
  const past = built.points.filter((p) => p.date < cut);
  if (!past.length) return { points: ps, flows: liveFlows };
  const ref = [...built.points].reverse().find((p) => p.date <= cut)!;
  const adj = ps[0].total - ref.total;
  const kept = liveFlows.filter((f) => flowIndex(ps, f) > 0);
  const joinFlow: Flow[] = adj ? [{ id: "ledger-join", date: cut, amount: adj, at: startOfDay(cut), note: "과거 기록과 이어 붙임", auto: true }] : [];
  return { points: [...past, ...ps], flows: [...built.flows.filter((f) => f.date < cut), ...joinFlow, ...kept], join: { date: cut, past: ref.total, live: ps[0].total } };
}
