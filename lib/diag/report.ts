/**
 * 점검 API(/api/diag/*)가 돌려주는 내용 (서버 전용, 읽기 전용).
 *
 * 원칙
 * - 비밀값(앱키·시크릿·계좌번호·비밀번호 해시·인증 앱 키·쿠키 서명 키·점검 키)은 절대 내보내지 않음. "있다/없다"만.
 * - 주문·잔고·설정 변경·전략 저장은 하지 않음.
 * - 저장된 코드(직접 작성 전략)를 서버에서 실행하지 않음. 서버에서 돌리는 건 기본 전략, 조건 고르기·적립 분할 매도 화면 전략처럼
 *   앱이 직접 만든 코드뿐 (브라우저 밖에서 남의 코드가 실행되면 서버의 비밀값에 닿을 수 있으므로).
 * - 시세는 네이버·CSV·가상 데이터만 (한국투자증권 시세는 내 앱키 호출 한도를 쓰므로 제외).
 */
import fs from "fs";
import path from "path";
import { loadData, type DataRequest, type DataResponse } from "../data/server";
import { staleWarnings } from "../data/stale";
import { holdTickers, runBuyAndHold } from "../engine/buyhold";
import { runBacktest } from "../engine/engine";
import { summarize } from "../engine/metrics";
import type { Bar, Rebalance } from "../engine/types";
import { generate, normalizeSpec } from "../strategies/builder";
import { cycle, cycleParams, cycleStatus, cycleWarmup, normalizeCycleSpec } from "../strategies/cycle";
import { compileStrategy, STRATEGIES, type Params } from "../strategies";
import { loadStrategies, type SavedStrategy } from "../strategies/library";
import { passwordConfigured, totpEnabled } from "../settings/auth";
import { configDir, envPassword, loadSettings, runtimeEnv } from "../settings/store";

type Env = Record<string, string | undefined>;

const STARTED = Date.now();
const has = (v: string | undefined) => !!(v && v.trim());

export function buildInfo(e: Env = process.env) {
  return {
    commit: e.ALPHY_GIT_SHA || null,
    builtAt: e.ALPHY_BUILD_TIME || null,
    startedAt: new Date(STARTED).toISOString(),
    uptimeSec: Math.round((Date.now() - STARTED) / 1000),
  };
}

type StrategyKind = "cycle" | "builder" | "custom";
const kindOf = (s: SavedStrategy): StrategyKind => (s.cycle ? "cycle" : s.builder ? "builder" : "custom");

/** 캐시 폴더 요약 (파일 이름은 내보내지 않고 개수·크기·최근 수정 시각만). 설정 폴더는 제외 */
function cacheSummary(root = path.join(process.cwd(), ".cache"), conf = configDir()) {
  const out: Record<string, { files: number; bytes: number; newest: string | null }> = {};
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const full = path.join(root, d.name);
    if (path.resolve(full) === path.resolve(conf)) continue;
    let files = 0, bytes = 0, newest = 0;
    const walk = (p: string, depth: number) => {
      if (depth > 3) return;
      for (const x of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, x.name);
        if (x.isDirectory()) walk(q, depth + 1);
        else if (x.isFile()) { const st = fs.statSync(q); files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs); }
      }
    };
    try { walk(full, 0); } catch { /* 읽기 실패한 폴더는 건너뜀 */ }
    out[d.name] = { files, bytes, newest: newest ? new Date(newest).toISOString() : null };
  }
  return out;
}

/** GET /api/diag : 버전·실행 상태·설정 요약·저장된 전략·캐시 */
export function overview(e: Env = process.env) {
  const s = loadSettings(e);
  const rt = runtimeEnv(e);
  const keys = (env: "REAL" | "MOCK") => ({
    appKey: has(rt[`KIS_${env}_APP_KEY`]), appSecret: has(rt[`KIS_${env}_APP_SECRET`]), account: has(rt[`KIS_${env}_ACCOUNT`]),
  });
  return {
    app: "alphy",
    build: buildInfo(e),
    runtime: {
      node: process.version, tz: e.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date().toISOString(),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    },
    settings: {
      passwordSet: passwordConfigured(e), passwordFromEnv: !!envPassword(e), totpEnabled: totpEnabled(e),
      kis: { real: keys("REAL"), mock: keys("MOCK"), tradeEnv: rt.KIS_TRADE_ENV, realOrdersUnlocked: /^(1|true|yes)$/i.test(rt.KIS_ALLOW_REAL_ORDERS?.trim() ?? "") },
      orderLimit: s.kis.orderLimit,
      backtest: s.backtest,
      diagTokens: (s.auth.diagTokens ?? []).filter((t) => t.expiresAt > Date.now()).length,
    },
    strategies: loadStrategies(e).map((x) => ({
      name: x.name, kind: kindOf(x), rebalance: x.rebalance, stopLoss: x.stopLoss || null, takeProfit: x.takeProfit || null,
      warmup: x.warmup, params: safeJson(x.params), updatedAt: x.updatedAt ?? null,
      ...(x.cycle ? { cycle: x.cycle } : {}), ...(x.builder ? { builder: x.builder } : {}),
      runnableOnServer: kindOf(x) !== "custom",
    })),
    builtinStrategies: STRATEGIES.map((x) => x.id),
    cache: cacheSummary(),
  };
}

function safeJson(t: string): unknown { try { return JSON.parse(t); } catch { return t; } }

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const minusDays = (iso: string, n: number) => new Date(Date.parse(iso) - n * 864e5).toISOString().slice(0, 10);

export type DiagSource = "naver" | "csv" | "synthetic";
export const cleanSource = (v: unknown): DiagSource => (v === "csv" || v === "synthetic" ? v : "naver");

export function cleanTickers(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[\s,]+/);
  return [...new Set(raw.map((t) => t.trim().toUpperCase()).filter((t) => /^[0-9A-Z]{6}$/.test(t)))].slice(0, 20);
}

/** 영업일 사이가 이만큼(달력일) 넘게 벌어진 곳 = 시세 빈 구간 의심 */
const GAP_DAYS = 7;

export function barsReport(bars: Bar[]) {
  const gaps: { from: string; to: string; days: number }[] = [];
  let zeroVolume = 0, badPrice = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!(b.volume > 0)) zeroVolume++;
    if (!(b.close > 0) || !(b.open > 0)) badPrice++;
    if (i > 0) {
      const d = (Date.parse(b.date) - Date.parse(bars[i - 1].date)) / 864e5;
      if (d > GAP_DAYS) gaps.push({ from: bars[i - 1].date, to: b.date, days: d });
    }
  }
  return {
    count: bars.length, first: bars[0]?.date ?? null, last: bars.at(-1)?.date ?? null,
    gaps, zeroVolume, badPrice, head: bars.slice(0, 3), tail: bars.slice(-5),
  };
}

/** 캐시 파일 정보 (받은 날, 받기 시작한 날, 저장된 범위) */
function cacheFileInfo(src: string, code: string) {
  const p = path.join(process.cwd(), ".cache", src, `${code}.json`);
  try {
    const st = fs.statSync(p);
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { fetched?: string; from?: string; bars?: Bar[] };
    return { exists: true, fetched: j.fetched ?? null, from: j.from ?? null, bars: j.bars?.length ?? 0,
      first: j.bars?.[0]?.date ?? null, last: j.bars?.at(-1)?.date ?? null, modified: new Date(st.mtimeMs).toISOString() };
  } catch { return { exists: false }; }
}

/** GET /api/diag/data : 종목별 시세 범위·빈 구간·캐시 상태 */
export async function dataReport(q: { tickers: unknown; start?: string; end?: string; source?: unknown }, load: (r: DataRequest) => Promise<DataResponse> = loadData) {
  const tickers = cleanTickers(q.tickers);
  if (!tickers.length) throw new Error("tickers 에 6자리 종목코드를 넣으세요 (예: tickers=069500).");
  const end = q.end && ISO.test(q.end) ? q.end : today();
  const start = q.start && ISO.test(q.start) ? q.start : minusDays(end, 3 * 365);
  const source = cleanSource(q.source);
  const before = source === "naver" ? Object.fromEntries(tickers.map((t) => [t, cacheFileInfo("naver", t)])) : null;
  const d = await load({ source, tickers, start, end });
  return {
    request: { source, tickers, start, end },
    tickers: Object.fromEntries(tickers.map((t) => [t, {
      name: d.names[t] ?? null,
      ...(d.data[t] ? barsReport(d.data[t]) : { missing: true }),
      ...(before ? { cacheBefore: before[t], cacheAfter: cacheFileInfo("naver", t) } : {}),
    }])),
    benchmark: d.benchmark ? { count: d.benchmark.length, first: d.benchmark[0]?.date ?? null, last: d.benchmark.at(-1)?.date ?? null } : null,
    warnings: [...d.warnings, ...staleWarnings(d, end)],
  };
}

export interface DiagBacktestRequest {
  /** 저장된 전략 이름 또는 기본 전략 id */
  strategy?: string;
  /** 저장하지 않은 적립·분할 매도 설정을 바로 돌려 볼 때 */
  cycle?: unknown;
  tickers?: unknown;
  universeSize?: number;
  source?: unknown;
  start?: string;
  end?: string;
  cash?: number;
  monthly?: number;
  /** 기본 전략의 파라미터 덮어쓰기 */
  params?: Record<string, number>;
  /** 거래 내역 몇 건까지 돌려줄지 (최근부터, 기본 50, 최대 500) */
  trades?: number;
}

interface Prepared { label: string; kind: string; fn: (ctx: any, p: Params) => any; p: Params; warmup: number; rebalance: Rebalance; stopLoss: number | null; takeProfit: number | null; needsTickers: boolean }

const pctFrac = (t: string) => (t.trim() === "" ? null : Number(t) / 100);
const numParams = (x: unknown): Params => {
  const out: Params = {};
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
};

export function prepareStrategy(r: DiagBacktestRequest, e: Env = process.env): Prepared {
  if (r.cycle && typeof r.cycle === "object") {
    const spec = normalizeCycleSpec(r.cycle);
    return { label: "(저장 안 한 적립·분할 매도)", kind: "cycle", fn: cycle, p: cycleParams(spec), warmup: cycleWarmup(spec), rebalance: "D", stopLoss: null, takeProfit: null, needsTickers: true };
  }
  const name = String(r.strategy ?? "").trim();
  if (!name) throw new Error("strategy 에 저장된 전략 이름이나 기본 전략 id 를 넣으세요. 목록은 GET /api/diag 의 strategies, builtinStrategies.");
  const b = STRATEGIES.find((x) => x.id === name);
  if (b) {
    const p = { ...Object.fromEntries(b.params.map((x) => [x.key, x.default])), ...numParams(r.params) };
    return { label: b.name, kind: "builtin", fn: b.targetWeights, p, warmup: b.warmup(p), rebalance: b.rebalance, stopLoss: b.stopLoss, takeProfit: b.takeProfit, needsTickers: false };
  }
  const s = loadStrategies(e).find((x) => x.name === name);
  if (!s) throw new Error(`'${name}' 전략이 없습니다. 목록은 GET /api/diag 의 strategies.`);
  const common = { label: s.name, stopLoss: pctFrac(s.stopLoss), takeProfit: pctFrac(s.takeProfit) };
  if (s.cycle) {
    const spec = normalizeCycleSpec(s.cycle);
    return { ...common, kind: "cycle", fn: cycle, p: cycleParams(spec), warmup: cycleWarmup(spec), rebalance: "D", needsTickers: true };
  }
  if (s.builder) {
    const g = generate(normalizeSpec(s.builder));
    return { ...common, kind: "builder", fn: compileStrategy(g.code), p: g.params, warmup: g.warmup, rebalance: s.rebalance, needsTickers: false };
  }
  throw new Error(`'${name}' 은(는) 직접 작성한 코드 전략이라 서버에서 실행하지 않습니다(보안). 화면에서 돌려 주세요.`);
}

/** POST /api/diag/backtest : 화면과 같은 방식으로 서버에서 백테스트를 다시 돌려 결과·거래·마지막 상태를 돌려줌 */
export async function backtestReport(r: DiagBacktestRequest, e: Env = process.env, load: (q: DataRequest) => Promise<DataResponse> = loadData) {
  const st = prepareStrategy(r, e);
  const def = loadSettings(e).backtest;
  const end = r.end && ISO.test(r.end) ? r.end : today();
  const start = r.start && ISO.test(r.start) ? r.start : minusDays(end, 3 * 365);
  const tickers = cleanTickers(r.tickers);
  if (st.needsTickers && !tickers.length) throw new Error("적립·분할 매도 전략은 tickers 에 종목코드를 넣어야 합니다 (예: [\"069500\"]).");
  const source = cleanSource(r.source ?? def.source);
  const universeSize = Math.min(Math.max(Math.round(Number(r.universeSize) || def.universeSize), 1), 100);
  const cash = Number(r.cash) > 0 ? Number(r.cash) : def.cash;
  const monthly = Number(r.monthly) > 0 ? Number(r.monthly) : 0;
  const loadStart = minusDays(start, Math.max(400, Math.ceil(st.warmup * 1.5) + 30));
  const d = await load({ source, start: loadStart, end, tickers: tickers.length ? tickers : undefined, universeSize });
  const res = runBacktest({
    data: d.data, benchmark: d.benchmark, names: d.names, universe: d.universe, startDate: start, initialCash: cash, monthlyDeposit: monthly,
    settings: { rebalance: st.rebalance, stopLoss: st.stopLoss, takeProfit: st.takeProfit, rebalanceBand: 0.02, warmup: st.warmup },
    costs: { commission: def.commission / 100, slippage: def.slippage / 100, sellTax: def.sellTax == null ? null : def.sellTax / 100 },
    strategy: (ctx) => st.fn(ctx, st.p),
  });
  if (res.equity.length < 2) throw new Error("평가 구간 데이터가 부족합니다. 기간을 확인하세요.");
  const s = summarize(res, def.targetCagr / 100, def.maxDrawdown / 100);
  const pick = holdTickers(res, tickers.length ? tickers : null);
  const holdRes = pick ? runBuyAndHold({
    data: d.data, benchmark: d.benchmark, startDate: start, initialCash: cash, monthlyDeposit: monthly, tickers: pick.tickers,
    costs: { commission: def.commission / 100, slippage: def.slippage / 100, sellTax: def.sellTax == null ? null : def.sellTax / 100 },
  }) : null;
  const hs = holdRes && holdRes.equity.length >= 2 ? summarize(holdRes) : null;
  const dates = res.equity.map((x) => x.date);
  const nTrades = Math.min(Math.max(Math.round(Number(r.trades) || 50), 0), 500);
  // 월말 자산만 (전체 곡선은 너무 큼)
  const monthlyEquity = res.equity.filter((x, i) => i === res.equity.length - 1 || x.date.slice(0, 7) !== res.equity[i + 1].date.slice(0, 7))
    .map((x) => ({ date: x.date, equity: Math.round(x.equity), cash: Math.round(x.cash), invested: Math.round(x.invested) }));
  return {
    request: { strategy: st.label, kind: st.kind, params: st.p, source, tickers, universeSize: tickers.length ? undefined : universeSize, start, end, cash, monthly, rebalance: st.rebalance },
    data: Object.fromEntries(Object.entries(d.data).slice(0, 20).map(([t, b]) => [t, { first: b[0]?.date ?? null, last: b.at(-1)?.date ?? null, count: b.length }])),
    summary: {
      start: s.start, end: s.end, initial: s.initial, final: s.final, deposits: s.deposits, contributed: s.contributed,
      cagr: s.cagr, mdd: s.mdd, sharpe: s.sharpe, nTrades: s.nTrades, nSells: s.nSells, winRate: s.winRate,
    },
    buyAndHold: hs && pick ? { basis: pick.basis, tickers: pick.tickers, final: hs.final, totalReturn: hs.totalReturn, cagr: hs.cagr, mdd: hs.mdd, sharpe: hs.sharpe, nTrades: hs.nTrades } : null,
    lastTrade: res.trades.at(-1)?.date ?? null,
    trades: nTrades ? res.trades.slice(-nTrades) : [],
    finalPositions: res.finalPositions,
    signal: res.signal,
    cycleStatus: cycleStatus(res.state, dates),
    monthlyEquity,
    warnings: [...d.warnings, ...staleWarnings(d, end)],
  };
}
