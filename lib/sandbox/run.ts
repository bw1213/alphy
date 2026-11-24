import type { BacktestResult, StopOrder, Trade } from "../engine/types";
import type { SandboxJob } from "./inside";
import BUNDLE from "./bundle.gen";

export type { SandboxJob } from "./inside";

export interface SandboxLimits { timeoutMs: number; memoryMb: number }
export const DEFAULT_LIMITS: SandboxLimits = { timeoutMs: 60_000, memoryMb: 512 };

export class SandboxError extends Error {}

/** 사용자 전략 코드를 V8 격리 공간에서 실행. 그 안에는 process·require·fetch·파일이 없음 */
export async function runIsolated(job: SandboxJob, limits: SandboxLimits = DEFAULT_LIMITS): Promise<BacktestResult> {
  const ivm = (await import("isolated-vm")).default;
  const iso = new ivm.Isolate({ memoryLimit: limits.memoryMb });
  const started = Date.now();
  const left = () => Math.max(1, limits.timeoutMs - (Date.now() - started));
  try {
    const ctx = await iso.createContext();
    await ctx.eval(BUNDLE, { timeout: left() });
    const run = await ctx.global.get("__alphyRun", { reference: true });
    const out = await run.apply(undefined, [new ivm.ExternalCopy(job).copyInto()], { timeout: left(), result: { copy: true } });
    return cleanResult(out, job);
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    const msg = (e as Error)?.message ?? String(e);
    if (/timed out/i.test(msg)) throw new SandboxError(`전략 계산이 ${Math.round(limits.timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
    if (iso.isDisposed || /memory/i.test(msg)) throw new SandboxError(`전략 계산이 메모리 한도(${limits.memoryMb}MB)를 넘었습니다.`);
    throw new SandboxError(`전략 코드 오류: ${msg.slice(0, 300)}`);
  } finally {
    if (!iso.isDisposed) iso.dispose();
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
const fail = (what: string): never => { throw new SandboxError(`전략 결과가 올바르지 않습니다 (${what}).`); };
const MAX_STATE = 200_000;

/** 격리 공간에서 돌려받은 값은 믿지 않고, 쓰는 필드만 검사해 새로 만듦 */
export function cleanResult(raw: any, job: Pick<SandboxJob, "opts">): BacktestResult {
  if (!raw || typeof raw !== "object") fail("형식");
  const known = new Set(Object.keys(job.opts.data));
  const tk = (v: unknown) => (typeof v === "string" && known.has(v) ? v : fail("모르는 종목"));
  const arr = (v: unknown, what: string) => (Array.isArray(v) ? v : fail(what));

  const equity = arr(raw.equity, "평가액").map((p: any) => {
    const e = num(p?.equity), c = num(p?.cash), inv = num(p?.invested);
    if (typeof p?.date !== "string" || !Number.isFinite(e) || !Number.isFinite(c) || !Number.isFinite(inv)) fail("평가액");
    return { date: p.date.slice(0, 10), equity: e, cash: c, invested: inv, benchmark: Number.isFinite(num(p.benchmark)) ? num(p.benchmark) : null,
      ...(Number.isFinite(num(p.nav)) ? { nav: num(p.nav) } : {}), ...(Number.isFinite(num(p.contributed)) ? { contributed: num(p.contributed) } : {}) };
  });
  const last = equity.at(-1);

  const finalPositions = arr(raw.finalPositions, "보유").map((p: any) => {
    const qty = num(p?.qty), avg = num(p?.avgPrice), value = num(p?.value);
    if (!Number.isInteger(qty) || qty < 0 || !(avg >= 0) || !(value >= 0)) fail("보유 수량");
    return { ticker: tk(p.ticker), qty, avgPrice: avg, value };
  });
  if (last) {
    const held = finalPositions.reduce((a, p) => a + p.value, 0);
    if (held > Math.max(last.equity, 0) * 1.02 + 1) fail("보유 금액이 평가액보다 큼");
  }

  const trades: Trade[] = arr(raw.trades, "거래").slice(-20_000).map((t: any) => ({
    date: String(t?.date ?? "").slice(0, 10), ticker: tk(t?.ticker), side: t?.side === "SELL" ? "SELL" : "BUY",
    qty: num(t?.qty), price: num(t?.price), fee: num(t?.fee),
    pnl: Number.isFinite(num(t?.pnl)) ? num(t.pnl) : null, ret: Number.isFinite(num(t?.ret)) ? num(t.ret) : null,
    reason: ["rebalance", "stop_loss", "take_profit", "delisted"].includes(t?.reason) ? t.reason : "rebalance",
    ...(str(t?.note) ? { note: str(t.note) } : {}),
    ...(Number.isFinite(num(t?.cash)) ? { cash: num(t.cash) } : {}), ...(Number.isFinite(num(t?.held)) ? { held: num(t.held) } : {}),
  }));

  let signal: BacktestResult["signal"] = null;
  if (raw.signal) {
    const s = raw.signal;
    const picks = arr(s.picks, "신호").map((p: any) => {
      const w = num(p?.weight);
      if (!(w >= 0 && w <= 1)) fail("비중");
      return { ticker: tk(p?.ticker), weight: w, close: num(p?.close) };
    });
    if (picks.reduce((a, p) => a + p.weight, 0) > 2.0001) fail("비중 합");
    const stops: Record<string, StopOrder[]> = {};
    for (const [t, list] of Object.entries(s.stops && typeof s.stops === "object" ? s.stops : {})) {
      if (!known.has(t)) continue;
      stops[t] = arr(list, "매도 가격").slice(0, 10).map((o: any) => {
        const below = num(o?.below), qty = num(o?.qty);
        if (!(below > 0) || !Number.isInteger(qty) || qty < 0) fail("매도 가격");
        return { below, qty, note: str(o?.note) ?? "" };
      });
    }
    const notes: Record<string, string> = {};
    for (const [t, v] of Object.entries(s.notes && typeof s.notes === "object" ? s.notes : {})) if (known.has(t) && str(v)) notes[t] = str(v)!;
    signal = { date: String(s.date ?? "").slice(0, 10), picks, kept: s.kept === true, ...(typeof s.due === "boolean" ? { due: s.due } : {}), notes, stops };
  }

  let state: Record<string, any> | undefined;
  if (raw.state && typeof raw.state === "object" && JSON.stringify(raw.state).length <= MAX_STATE) state = raw.state;
  const dividends = Array.isArray(raw.dividends) ? raw.dividends.slice(-20_000).map((d: any) => ({
    date: String(d?.date ?? "").slice(0, 10), ticker: tk(d?.ticker), qty: num(d?.qty), perShare: num(d?.perShare), gross: num(d?.gross), tax: num(d?.tax), net: num(d?.net),
  })) : undefined;
  return { equity, trades, finalPositions, signal, ...(state ? { state } : {}), ...(dividends ? { dividends } : {}) };
}
