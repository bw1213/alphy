/**
 * 자동 매매 "운용 전략" 저장 (서버 전용, 사람마다 따로).
 *   users/<사용자>/auto.json      운용 전략 (지금은 한 사람에 하나: 한 계좌에 전략 하나로 시작)
 *   users/<사용자>/auto-log.json  저녁 계산 기록 (최근 60개)
 *
 * 운용 전략에는 보관함 전략을 "복사"해 둡니다. 보관함에서 전략을 고쳐도 운용은 바뀌지 않고,
 * 화면에서 다시 저장해야 새 버전으로 바뀝니다 (모르는 사이에 매매 규칙이 바뀌지 않게).
 */
import fs from "fs";
import { isUsTicker, normalizeTicker } from "../data/market";
import { STRATEGIES } from "../strategies";
import { cleanStrategy, type SavedStrategy } from "../strategies/library";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import type { EveningReport } from "./evening";

type Env = Record<string, string | undefined>;

export interface AutoPlan {
  /** 보관함 전략을 복사한 것. 기본 전략이면 없음 */
  strategy?: SavedStrategy;
  /** 기본 전략 id (strategy 가 없을 때) */
  builtin?: string;
  /** 화면에 보이는 전략 이름 */
  label: string;
  /** 대상 종목. 비우면 전략의 기본(시총 상위 종목) */
  tickers: string[];
  /** 운용 금액(원). 이 돈으로 시작한 것처럼 계산 */
  budget: number;
  /** 운용 시작일. 이날부터 전략을 돌린 것으로 계산 (적립·분할 매도의 최고가 등도 이날부터) */
  startDate: string;
  /** 꺼 두면 저녁 계산·알림을 하지 않음 */
  enabled: boolean;
  /**
   * 장중 실시간 매도: 손절·익절·하락 매도 가격에 장중에 닿으면 바로 시장가로 판다 (백테스트도 같은 규칙).
   * 끄면 종가로 확인해 다음 날 아침에 판다. 없으면 켬
   */
  intraday?: boolean;
  /**
   * 실전 전환 확인 시각. 주문 계좌가 실전이어도 이 확인이 없으면 자동 주문을 내지 않는다 (계산·알림만).
   * 전략·종목을 바꾸거나 운용 금액을 올리면 지워져 다시 확인해야 함
   */
  realConfirmedAt?: string;
  updatedAt: string;
}

/** 운용을 다시 저장할 때 실전 전환 확인을 이어 갈지: 전략·종목이 같고 운용 금액이 늘지 않았을 때만 */
export function keepRealConfirm(prev: AutoPlan | null, next: AutoPlan): AutoPlan {
  if (!prev?.realConfirmedAt) return next;
  const same = prev.label === next.label && prev.tickers.join(",") === next.tickers.join(",") && next.budget <= prev.budget
    && JSON.stringify(prev.strategy ?? prev.builtin) === JSON.stringify(next.strategy ?? next.builtin);
  return same ? { ...next, realConfirmedAt: prev.realConfirmedAt } : next;
}

export const REAL_NOT_CONFIRMED = "주문 계좌가 실전인데 실전 전환을 아직 확인하지 않아 주문하지 않습니다. 자동 매매 화면의 \"실전 전환\"에서 확인하세요.";

/** 장중 실시간 매도를 쓰는지 (예전 저장본엔 값이 없음 → 켬) */
export const intradayOn = (p: Pick<AutoPlan, "intraday">) => p.intraday !== false;

export const MAX_LOG = 60;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type StrategyKind = "builtin" | "cycle" | "builder" | "custom";
export const planKind = (p: Pick<AutoPlan, "strategy" | "builtin">): StrategyKind =>
  !p.strategy ? "builtin" : p.strategy.cycle ? "cycle" : p.strategy.builder ? "builder" : "custom";

/**
 * 화면에서 온 값을 검사. 직접 작성한 코드 전략은 서버에서 매일 실행되므로 owner 만 허용
 * (다른 사람이 쓴 코드가 NAS 에서 돌면 서버의 비밀값·파일에 닿을 수 있음).
 */
export function cleanPlan(x: any, user: string, today: string, lib: SavedStrategy[], real?: { cap: number }): AutoPlan {
  // "builtin:<id>" = 기본 전략, "saved:<이름>" = 보관함 전략
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
    if (!s.cycle && !s.builder && user !== OWNER_ID) {
      throw new Error("직접 작성한 코드 전략은 서버에서 매일 실행되므로 관리자만 운용할 수 있습니다. 조건 고르기·적립 전략으로 만들어 주세요.");
    }
  }
  const raw = Array.isArray(x?.tickers) ? x.tickers.map(String) : String(x?.tickers ?? "").split(/[\s,]+/);
  const tickers = [...new Set(raw.map(normalizeTicker).filter(Boolean))].slice(0, 20) as string[];
  if (tickers.some(isUsTicker) && !tickers.every(isUsTicker)) throw new Error("한국 종목과 미국 종목을 한 운용에 섞을 수 없습니다 (주문 시간과 계좌 통화가 달라서). 한쪽만 넣어 주세요.");
  if (strategy?.cycle && !tickers.length) throw new Error("적립·분할 매도 전략은 대상 종목을 넣어야 합니다 (예: 069500).");
  const budget = Math.round(Number(x?.budget));
  if (!(budget >= 100_000) || budget > 10_000_000_000) throw new Error("운용 금액은 10만 원 이상으로 넣으세요.");
  if (real && real.cap > 0 && budget > real.cap) {
    throw new Error(`주문 계좌가 실전이라 운용 금액은 ${real.cap.toLocaleString("ko-KR")}원(설정의 실전 운용 금액 상한)까지입니다. 설정 화면에서 상한을 바꾸거나 금액을 줄이세요.`);
  }
  let startDate = String(x?.startDate ?? "").trim();
  if (!ISO.test(startDate)) startDate = today;
  if (startDate > today) startDate = today;
  return { strategy, builtin, label, tickers, budget, startDate, enabled: x?.enabled !== false, intraday: x?.intraday !== false, updatedAt: new Date().toISOString() };
}

export function loadPlan(user: string = OWNER_ID, e: Env = process.env): AutoPlan | null {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("auto.json", user, e), "utf8"));
    return j && typeof j === "object" && j.plan && typeof j.plan === "object" ? (j.plan as AutoPlan) : null;
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

/** 새 기록을 맨 앞에. 같은 날 같은 종류(자동/직접)의 기록은 새 것으로 바꿈 */
export function appendLog(r: EveningReport, user: string = OWNER_ID, e: Env = process.env): EveningReport[] {
  const list = [r, ...loadLog(user, e).filter((x) => !(x.runDate === r.runDate && x.trigger === r.trigger))].slice(0, MAX_LOG);
  writeUserFile("auto-log.json", JSON.stringify(list), user, e);
  return list;
}
