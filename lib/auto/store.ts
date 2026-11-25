import fs from "fs";
import { normalizeTicker } from "../data/market";
import { STRATEGIES } from "../strategies";
import { cleanStrategy, loadStrategies, type SavedStrategy } from "../strategies/library";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import type { EveningReport } from "./evening";

type Env = Record<string, string | undefined>;

export interface AutoPlan {
  strategy?: SavedStrategy;
  builtin?: string;
  label: string;
  tickers: string[];
  budget: number;
  startDate: string;
  enabled: boolean;
  intraday?: boolean;
  realConfirmedAt?: string;
  updatedAt: string;
}

export function keepRealConfirm(prev: AutoPlan | null, next: AutoPlan): AutoPlan {
  if (!prev?.realConfirmedAt) return next;
  const same = prev.label === next.label && prev.tickers.join(",") === next.tickers.join(",") && next.budget <= prev.budget
    && JSON.stringify(prev.strategy ?? prev.builtin) === JSON.stringify(next.strategy ?? next.builtin);
  return same ? { ...next, realConfirmedAt: prev.realConfirmedAt } : next;
}

export const REAL_NOT_CONFIRMED = "주문 계좌가 실전인데 실전 전환을 아직 확인하지 않아 주문하지 않습니다. 계좌 화면(한국투자증권)의 \"실전 전환\"에서 확인하세요.";

export const intradayOn = (p: Pick<AutoPlan, "intraday">) => p.intraday !== false;

export const MAX_LOG = 60;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type StrategyKind = "builtin" | "cycle" | "builder" | "custom";
export const planKind = (p: Pick<AutoPlan, "strategy" | "builtin">): StrategyKind =>
  !p.strategy ? "builtin" : p.strategy.cycle ? "cycle" : p.strategy.builder ? "builder" : "custom";

export function cleanPlan(x: any, user: string, today: string, lib: SavedStrategy[], real?: { cap: number }): AutoPlan {
  const key = String(x?.strategy ?? "").trim();
  if (!key) throw new Error("운용할 전략을 고르세요.");
  let strategy: SavedStrategy | undefined, builtin: string | undefined, label: string;
  if (key.startsWith("builtin:")) {
    const id = key.slice(8);
    const def = STRATEGIES.find((s) => s.id === id);
    if (!def) throw new Error(`'${id}' 기본 전략이 없습니다.`);
    builtin = def.id; label = def.name;
  } else {
    const name = key.replace(/^saved:/, "");
    const s = lib.find((v) => v.name === name);
    if (!s) throw new Error(`'${name}' 전략이 보관함에 없습니다. 백테스트 화면에서 먼저 저장하세요.`);
    strategy = cleanStrategy(s); label = s.name;
  }
  const own = strategy ? strategyTickers(strategy) : null;
  const raw = own ?? (Array.isArray(x?.tickers) ? x.tickers.map(String) : String(x?.tickers ?? "").split(/[\s,]+/));
  const tickers = [...new Set(raw.map(normalizeTicker).filter(Boolean))].slice(0, 20) as string[];
  if (strategy?.cycle && !tickers.length) throw new Error("적립·분할 매도 전략은 대상 종목을 넣어야 합니다 (예: 069500).");
  const budget = Math.round(Number(x?.budget));
  if (!(budget >= 100_000) || budget > 10_000_000_000) throw new Error("운용 금액은 10만 원 이상으로 넣으세요.");
  if (real && real.cap > 0 && budget > real.cap) {
    throw new Error(`주문 계좌가 실전이라 운용 금액은 ${real.cap.toLocaleString("ko-KR")}원(설정의 실전 운용 금액 상한)까지입니다. 설정 화면에서 상한을 바꾸거나 금액을 줄이세요.`);
  }
  let startDate = String(x?.startDate ?? "").trim();
  if (!ISO.test(startDate)) startDate = today;
  if (startDate > today) startDate = today;
  const intraday = typeof strategy?.intraday === "boolean" ? strategy.intraday : x?.intraday !== false;
  return { strategy, builtin, label, tickers, budget, startDate, enabled: x?.enabled !== false, intraday, updatedAt: new Date().toISOString() };
}

export function strategyTickers(s: SavedStrategy): string[] | null {
  const u = s.universe;
  if (!u) return null;
  if (u.mode === "top") return [];
  return [...new Set(u.tickers.split(/[\s,]+/).map(normalizeTicker).filter(Boolean))].slice(0, 20) as string[];
}

const stratKey = (s?: SavedStrategy) => (s ? JSON.stringify({ ...s, updatedAt: undefined }) : "");

export function syncPlan(plan: AutoPlan, lib: SavedStrategy[]): AutoPlan {
  if (!plan.strategy) return plan;
  const found = lib.find((v) => v.name === plan.strategy!.name);
  if (!found) return plan;
  let fresh: SavedStrategy;
  try { fresh = cleanStrategy(found); } catch { return plan; }
  const own = strategyTickers(fresh);
  const tickers = own ?? plan.tickers;
  const intraday = typeof fresh.intraday === "boolean" ? fresh.intraday : plan.intraday;
  const changed = stratKey(fresh) !== stratKey(plan.strategy) || tickers.join(",") !== plan.tickers.join(",");
  if (!changed && intraday === plan.intraday) return plan;
  return { ...plan, strategy: fresh, tickers, intraday, ...(changed ? { realConfirmedAt: undefined } : {}) };
}

export function loadPlan(user: string = OWNER_ID, e: Env = process.env): AutoPlan | null {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("auto.json", user, e), "utf8"));
    if (!(j && typeof j === "object" && j.plan && typeof j.plan === "object")) return null;
    return syncPlan(j.plan as AutoPlan, loadStrategies(e, user));
  } catch { return null; }
}

export function savePlan(plan: AutoPlan | null, user: string = OWNER_ID, e: Env = process.env): void {
  writeUserFile("auto.json", JSON.stringify({ plan }, null, 1), user, e);
}

export function loadLog(user: string = OWNER_ID, e: Env = process.env): EveningReport[] {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("auto-log.json", user, e), "utf8"));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

export function appendLog(r: EveningReport, user: string = OWNER_ID, e: Env = process.env): EveningReport[] {
  const list = [r, ...loadLog(user, e).filter((x) => !(x.runDate === r.runDate && x.trigger === r.trigger))].slice(0, MAX_LOG);
  writeUserFile("auto-log.json", JSON.stringify(list), user, e);
  return list;
}
