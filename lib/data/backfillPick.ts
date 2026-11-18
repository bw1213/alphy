/** 백테스트 화면의 "상장 전 기간 채우기" 선택값 (화면·저장·요청 공용, 서버에서도 씀) */
import { suggestSpec } from "./backfill";
import type { BackfillRequestMap } from "./backfillApply";

/** 종목별 선택: proxy = "auto" | "none" | 대용 id */
export interface BackfillPick { proxy: string; lev: string; fee: string; hedged: boolean }
export interface BackfillState { on: boolean; picks: Record<string, BackfillPick> }

export const DEFAULT_BACKFILL: BackfillState = { on: false, picks: {} };
export const AUTO_PICK: BackfillPick = { proxy: "auto", lev: "1", fee: "0", hedged: false };

/** 고른 대용 하나 → 이어 붙일 순서 (그 대용도 짧으면 그 대용의 기본 대용으로 더 앞을 채움) */
export function chainFor(id: string): string[] {
  return [...new Set([id, ...(suggestSpec(id)?.chain ?? [])])].slice(0, 4);
}

/** 화면 상태 → 서버 요청 값 (꺼져 있으면 undefined) */
export function backfillRequest(st: BackfillState, tickers: string[]): BackfillRequestMap | undefined {
  if (!st.on || !tickers.length) return undefined;
  const out: BackfillRequestMap = {};
  for (const t of tickers) {
    const p = st.picks[t] ?? AUTO_PICK;
    if (p.proxy === "auto") out[t] = "auto";
    else if (p.proxy === "none") out[t] = null;
    else out[t] = { chain: chainFor(p.proxy), lev: Number(p.lev) || 1, fee: Math.max(0, Number(p.fee) || 0), ...(p.hedged ? { hedged: true } : {}) };
  }
  return out;
}

/** 저장본 → 깨끗한 상태 (서버·화면 공용) */
export function cleanBackfillState(x: any): BackfillState {
  if (!x || typeof x !== "object") return DEFAULT_BACKFILL;
  const picks: Record<string, BackfillPick> = {};
  if (x.picks && typeof x.picks === "object") {
    for (const [k, v] of Object.entries(x.picks).slice(0, 50)) {
      const p = v as any;
      if (!p || typeof p !== "object") continue;
      const proxy = typeof p.proxy === "string" ? p.proxy.slice(0, 20) : "auto";
      picks[k.slice(0, 12)] = { proxy, lev: String(p.lev ?? "1").slice(0, 8), fee: String(p.fee ?? "0").slice(0, 8), hedged: p.hedged === true };
    }
  }
  return { on: x.on === true, picks };
}
