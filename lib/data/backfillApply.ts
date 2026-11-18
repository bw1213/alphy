/**
 * 서버에서 받은 시세에 '상장 전 기간 채우기'를 적용 (lib/data/backfill.ts 의 계산을 실제 데이터에 연결).
 * 시세·지수·환율을 받는 함수는 server.ts 가 넘겨 준다 (테스트에선 가짜를 넘김).
 */
import type { Bar, Dividend, DividendData, PriceData } from "../engine/types";
import { extendBars, KR_BASE_RATE, proxyCurrency, proxyName, proxyYield, rateAt, rateBars, suggestSpec, cleanSpec, type BackfillSpec, type Currency } from "./backfill";
import { isUsTicker } from "./market";

export interface BackfillRequestMap { [ticker: string]: BackfillSpec | "auto" | null }

export interface BackfillNote { ticker: string; from: string; until: string; chain: string[]; lev: number; fee: number; hedged?: boolean }

export interface BackfillDeps {
  /** 종목 시세(원화로 바뀐 것)와 배당(원화) */
  loadTickers: (codes: string[]) => Promise<{ data: PriceData; dividends?: DividendData; fx?: { date: string; close: number }[] }>;
  /** 야후 지수·환율 일봉 (현지 통화) */
  yahoo: (symbol: string) => Promise<Bar[]>;
  /** 종목 이름 (기본 대용 추측용) */
  nameOf?: (code: string) => string | undefined;
}

export interface BackfillTarget {
  data: PriceData;
  dividends?: DividendData;
  fx?: { date: string; close: number }[];
  warnings: string[];
  backfilled?: BackfillNote[];
}

const plusDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);

/** 환율표 → 날짜별 값 (그 날 없으면 직전, 표보다 앞이면 첫 값) */
function fxFn(fx: { date: string; close: number }[]) {
  return (date: string) => {
    let lo = 0, hi = fx.length - 1, k = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (fx[m].date <= date) { k = m; lo = m + 1; } else hi = m - 1; }
    return fx[k]?.close ?? NaN;
  };
}
const scaleBars = (bars: Bar[], f: (d: string) => number, inv = false) =>
  bars.map((b) => { const r = inv ? 1 / f(b.date) : f(b.date); return { ...b, open: b.open * r, high: b.high * r, low: b.low * r, close: b.close * r }; });
const scaleDivs = (divs: Dividend[], f: (d: string) => number, inv = false) => divs.map((d) => ({ date: d.date, amount: d.amount * (inv ? 1 / f(d.date) : f(d.date)) }));

export async function applyBackfill(out: BackfillTarget, req: { start: string; end: string; backfill?: BackfillRequestMap | null }, deps: BackfillDeps): Promise<void> {
  const want = req.backfill;
  if (!want) return;
  const need = 7; // 시작일보다 일주일 넘게 늦게 시작하는 종목만
  const plan: { t: string; spec: BackfillSpec }[] = [];
  const unknown: string[] = [];
  for (const t of Object.keys(out.data)) {
    const bars = out.data[t];
    if (!bars.length || bars[0].date <= plusDays(req.start, need)) continue;
    const w = t in want ? want[t] : (want["*"] ?? "auto"); // null = 채우지 않음
    if (w === null) continue;
    const spec = w === "auto" ? suggestSpec(t, deps.nameOf?.(t)) : cleanSpec(w);
    if (!spec) { unknown.push(t); continue; }
    plan.push({ t, spec });
  }
  if (unknown.length) out.warnings.push(`상장 전 기간 채우기: ${unknown.join(", ")}는 따라갈 지수를 몰라 채우지 못했습니다. '상장 전 채우기'에서 지수를 골라 주세요.`);
  if (!plan.length) return;

  // 대용 시세 모으기
  const ids = [...new Set(plan.flatMap((p) => p.spec.chain))];
  /** 야후에서 바로 받는 지수·선물 (^GSPC, GC=F) */
  const isYahooOnly = (x: string) => x.startsWith("^") || x.includes("=");
  const tickers = ids.filter((x) => !isYahooOnly(x) && !x.startsWith("RATE:"));
  const series = new Map<string, { bars: Bar[]; divs: Dividend[]; cur: Currency; krw: boolean }>(); // krw: 이미 원화로 바뀐 값
  const failed: string[] = [];
  let fx = out.fx;
  if (tickers.length) {
    try {
      const r = await deps.loadTickers(tickers);
      for (const t of tickers) {
        if (r.data[t]?.length) series.set(t, { bars: r.data[t], divs: r.dividends?.[t] ?? [], cur: proxyCurrency(t), krw: true });
        else failed.push(t);
      }
      if (!fx?.length && r.fx?.length) fx = r.fx;
    } catch { failed.push(...tickers); }
  }
  const needUsd = plan.some((p) => isUsTicker(p.t) || p.spec.hedged || p.spec.chain.some((c) => proxyCurrency(c) === "USD"));
  if (needUsd && !fx?.length) {
    try { fx = (await deps.yahoo("KRW=X")).map((b) => ({ date: b.date, close: b.close })); } catch { /* 아래에서 실패 처리 */ }
  }
  let irx: [string, number][] | null = null;
  const needIrx = ids.includes("RATE:US") || plan.some((p) => p.spec.lev !== 1);
  if (needIrx) { try { irx = (await deps.yahoo("^IRX")).map((b) => [b.date, b.close] as [string, number]); } catch { irx = null; } }
  for (const id of ids.filter(isYahooOnly)) {
    try { const b = await deps.yahoo(id); if (b.length) series.set(id, { bars: b, divs: [], cur: proxyCurrency(id), krw: false }); else failed.push(id); }
    catch { failed.push(id); }
  }
  const firstNeeded = plan.reduce((m, p) => (out.data[p.t][0].date > m ? out.data[p.t][0].date : m), req.start);
  series.set("RATE:KR", { bars: rateBars(KR_BASE_RATE, req.start, firstNeeded), divs: [], cur: "KRW", krw: true });
  if (irx?.length) series.set("RATE:US", { bars: rateBars(irx, req.start, firstNeeded), divs: [], cur: "USD", krw: false });
  const fxAt = fx?.length ? fxFn(fx) : null;
  const rfKr = (d: string) => rateAt(KR_BASE_RATE, d);
  const rfUs = irx?.length ? (d: string) => rateAt(irx!, d) : (d: string) => 0.02;

  const notes: BackfillNote[] = [];
  const miss = new Set<string>();
  for (const { t, spec } of plan) {
    const tUs = isUsTicker(t);
    if ((tUs || spec.chain.some((c) => proxyCurrency(c) === "USD")) && !fxAt) { miss.add(`${t}(환율 없음)`); continue; }
    // 숫자 공간: 미국 종목은 달러, 한국 종목은 원화
    let cur: Bar[] = tUs ? scaleBars(out.data[t], fxAt!, true) : out.data[t];
    const addDivs: Dividend[] = [];
    const until = cur[0].date;
    const used: string[] = [];
    for (const id of spec.chain) {
      if (cur[0].date <= plusDays(req.start, need)) break;
      const s = series.get(id);
      if (!s?.bars.length) { miss.add(id); continue; }
      // 대용을 '이을 공간'으로: 미국 종목 → 달러, 한국 종목 → 원화 (환헤지면 대용의 현지 통화 수익률 그대로)
      const space: Currency = tUs ? "USD" : spec.hedged ? s.cur : "KRW";
      let bars = s.bars, divs = s.divs;
      const isKrwNow = s.krw || s.cur === "KRW"; // 지금 값이 원화인지 (한국 지수는 원래 원화)
      if (space === "USD" && isKrwNow) { bars = scaleBars(bars, fxAt!, true); divs = scaleDivs(divs, fxAt!, true); }
      if (space === "KRW" && !isKrwNow) { bars = scaleBars(bars, fxAt!); divs = scaleDivs(divs, fxAt!); }
      const rf = space === "USD" ? rfUs : rfKr;
      const ext = extendBars(cur, bars, divs, spec, rf, req.start, proxyYield(id) / 100);
      if (!ext.bars.length) continue;
      cur = [...ext.bars, ...cur];
      addDivs.unshift(...ext.divs);
      used.push(id);
    }
    if (!used.length) continue;
    const merged = tUs ? scaleBars(cur, fxAt!) : cur;
    out.data[t] = merged;
    if (out.dividends && addDivs.length) {
      const extra = tUs ? scaleDivs(addDivs, fxAt!) : addDivs;
      out.dividends[t] = [...extra.filter((d) => d.date >= req.start && d.date < until), ...(out.dividends[t] ?? [])];
    }
    notes.push({ ticker: t, from: merged[0].date, until, chain: used, lev: spec.lev, fee: spec.fee, ...(spec.hedged ? { hedged: true } : {}) });
  }
  if (notes.length) {
    out.backfilled = notes;
    const desc = notes.map((n) => `${n.ticker}: ${n.until} 전은 ${n.chain.map(proxyName).join(" → ")}${n.lev !== 1 ? ` ×${n.lev}` : ""}${n.hedged ? " (환헤지)" : ""}`).join("; ");
    out.warnings.unshift(`상장 전 기간을 지수로 채웠습니다 (${desc}). 지수와 운용 방식이 다른 ETF(커버드콜 등)는 비슷하게만 따라가므로 참고용입니다.`);
  }
  if (failed.length || miss.size) out.warnings.push(`상장 전 채우기에 쓸 시세를 일부 받지 못했습니다: ${[...new Set([...failed, ...miss])].join(", ")}`);
  if (fx?.length && notes.some((n) => n.from < fx![0].date && (isUsTicker(n.ticker) || n.chain.some((c) => proxyCurrency(c) === "USD")))) {
    out.warnings.push(`원/달러 환율은 ${fx[0].date}부터 있어 그 전 기간은 첫 환율로 계산했습니다.`);
  }
}
