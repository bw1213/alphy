/** 전략 보관함에 함께 저장하는 백테스트 종목 (화면·서버 공용) */
import { cleanBackfillState, type BackfillState } from "../data/backfillPick";

/** 저장할 때 백테스트에 쓴 종목 (불러오면 그대로 복원) */
export interface SavedUniverse {
  /** top = 시가총액 상위 N, list = 직접 입력 */
  mode: "top" | "list";
  size: number;
  pit: boolean;
  /** 쉼표로 구분한 종목 코드 */
  tickers: string;
  backfill?: BackfillState;
}

export function cleanUniverse(x: any): SavedUniverse | undefined {
  if (!x || typeof x !== "object") return undefined;
  const mode = x.mode === "top" ? "top" : "list";
  const tickers = String(x.tickers ?? "").slice(0, 2000);
  if (mode === "list" && !tickers.trim()) return undefined;
  const size = Math.min(Math.max(Math.round(Number(x.size) || 100), 1), 300);
  const bf = x.backfill ? cleanBackfillState(x.backfill) : undefined;
  return { mode, size, pit: x.pit === true, tickers, ...(bf && (bf.on || Object.keys(bf.picks).length) ? { backfill: bf } : {}) };
}

/** 짧은 설명: "069500, QQQ" 또는 "시가총액 상위 100" */
export function universeLabel(u: SavedUniverse): string {
  if (u.mode === "top") return `시가총액 상위 ${u.size}${u.pit ? " (그때 기준)" : ""}`;
  const list = u.tickers.split(/[\s,]+/).filter(Boolean);
  return list.length > 5 ? `${list.slice(0, 5).join(", ")} 외 ${list.length - 5}개` : list.join(", ");
}

/** 저장된 전략의 종목 코드 목록 (직접 입력일 때만) */
export function universeTickers(u: SavedUniverse | undefined): string {
  return u?.mode === "list" ? u.tickers.split(/[\s,]+/).filter(Boolean).join(", ") : "";
}
