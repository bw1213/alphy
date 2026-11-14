/**
 * 백테스트 화면의 마지막 설정 (서버 전용 저장 + 검증).
 * 화면을 다시 열면 마지막에 고른 전략·파라미터·종목·기간·자금 설정이 그대로 복원됩니다.
 * 저장 위치: {설정 폴더}/last-state.json (NAS 에 보관 → 휴대폰·PC 어디서 열어도 같은 상태).
 */
import fs from "fs";
import path from "path";
import { configDir } from "../settings/store";
import type { Rebalance } from "../engine/types";
import { normalizeSpec, type BuilderSpec } from "./builder";
import { normalizeCycleSpec, type CycleSpec } from "./cycle";

export interface LastState {
  version: 1;
  /** 전략 선택 값: 기본 전략 id, "builder" | "cycle" | "custom", "saved:이름" */
  sid: string;
  mode: "builder" | "cycle" | "code";
  /** 기본 전략별 파라미터 { 전략id: { 키: 숫자 } } */
  params: Record<string, Record<string, number>>;
  code: string;
  customParams: string;
  customName: string;
  customWarmup: number;
  spec?: BuilderSpec;
  cycleSpec?: CycleSpec;
  rebalance: Rebalance;
  stopLoss: string;
  takeProfit: string;
  source: "naver" | "kis" | "csv" | "synthetic";
  start: string;
  /** "" = 오늘 (열 때마다 오늘 날짜로) */
  end: string;
  universeMode: "top" | "list";
  universeSize: number;
  pit: boolean;
  tickers: string;
  cash: number;
  monthly: number;
  commission: string;
  slippage: string;
  sellTax: string;
  savedAt?: string;
}

type Env = Record<string, string | undefined>;
const file = (e: Env) => path.join(configDir(e), "last-state.json");

const str = (v: unknown, max: number, dflt = "") => (typeof v === "string" ? v.slice(0, max) : dflt);
const num = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};
const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

/** 화면에서 온 값을 검증해 깨끗한 상태로. 형식이 아니면 에러 */
export function cleanLastState(x: any): LastState {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("마지막 설정 형식이 아닙니다.");
  const params: LastState["params"] = {};
  if (x.params && typeof x.params === "object") {
    for (const [id, p] of Object.entries(x.params).slice(0, 50)) {
      if (!p || typeof p !== "object") continue;
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(p as object).slice(0, 50)) if (Number.isFinite(Number(v))) clean[k.slice(0, 40)] = Number(v);
      params[id.slice(0, 40)] = clean;
    }
  }
  const r = x.rebalance;
  const rebalance: Rebalance = r === "D" || r === "W" || r === "M" || r === "Q" ? r
    : Number.isInteger(r) && r >= 1 && r <= 250 ? r : "M";
  const mode = x.mode === "cycle" || x.mode === "code" ? x.mode : "builder";
  const source = ["naver", "kis", "csv", "synthetic"].includes(x.source) ? x.source : "naver";
  return {
    version: 1,
    sid: str(x.sid, 80),
    mode,
    params,
    code: str(x.code, 50_000),
    customParams: str(x.customParams, 5000, "{}"),
    customName: str(x.customName, 60),
    customWarmup: Math.round(num(x.customWarmup, 0, 2000, 250)),
    ...(x.spec && typeof x.spec === "object" ? { spec: normalizeSpec(x.spec) } : {}),
    ...(x.cycleSpec && typeof x.cycleSpec === "object" ? { cycleSpec: normalizeCycleSpec(x.cycleSpec) } : {}),
    rebalance,
    stopLoss: str(x.stopLoss, 20),
    takeProfit: str(x.takeProfit, 20),
    source,
    start: date(x.start) || "2018-01-01",
    end: date(x.end),
    universeMode: x.universeMode === "list" ? "list" : "top",
    universeSize: Math.round(num(x.universeSize, 5, 300, 100)),
    pit: x.pit === true,
    tickers: str(x.tickers, 2000),
    cash: num(x.cash, 0, 1e13, 10_000_000),
    monthly: num(x.monthly, 0, 1e12, 0),
    commission: str(x.commission, 20, "0.015"),
    slippage: str(x.slippage, 20, "0.1"),
    sellTax: str(x.sellTax, 20),
    savedAt: typeof x.savedAt === "string" ? x.savedAt.slice(0, 30) : undefined,
  };
}

export function loadLastState(e: Env = process.env): LastState | null {
  try { return cleanLastState(JSON.parse(fs.readFileSync(file(e), "utf8"))); } catch { return null; }
}

export function saveLastState(x: unknown, e: Env = process.env, now = new Date()): LastState {
  const s = { ...cleanLastState(x), savedAt: now.toISOString() };
  fs.mkdirSync(configDir(e), { recursive: true, mode: 0o700 });
  const tmp = `${file(e)}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, file(e));
  return s;
}

export function clearLastState(e: Env = process.env) {
  try { fs.unlinkSync(file(e)); } catch { /* 없으면 그만 */ }
}
