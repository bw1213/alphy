/**
 * 종목 코드로 시장 구분.
 * - 한국: 6자리, 첫 글자가 숫자 (005930, 0126Z0)
 * - 미국: 영문 대문자로 시작하는 티커 (AAPL, SPY). 클래스주는 점 표기로 통일 (BRK.B)
 *   한국투자증권 마스터의 BRK/B, 야후의 BRK-B 도 normalizeTicker 가 BRK.B 로 바꾼다
 */
export type Market = "KR" | "US";

const KR = /^\d[0-9A-Z]{5}$/;
const US = /^[A-Z][A-Z0-9]{0,7}(\.[A-Z]{1,2})?$/;

/** 입력값 정리: 공백 제거, 대문자, BRK/B·BRK-B → BRK.B. 형식이 아니면 "" */
export function normalizeTicker(raw: string): string {
  const t = String(raw ?? "").trim().toUpperCase().replace(/^(US|NAS|NYS|AMS)[:\s]+/, "");
  if (KR.test(t)) return t;
  const u = t.replace(/[/\-]/g, ".");
  return US.test(u) ? u : "";
}

export const isKrTicker = (t: string) => KR.test(t);
export const isUsTicker = (t: string) => US.test(t);
export const marketOf = (t: string): Market | null => (KR.test(t) ? "KR" : US.test(t) ? "US" : null);

/** 쉼표·공백으로 나눈 종목 목록 → 정리된 코드 (중복·잘못된 형식 제거) */
export function parseTickers(text: string): string[] {
  return [...new Set(String(text ?? "").split(/[\s,]+/).map(normalizeTicker).filter(Boolean))];
}

/** 야후 파이낸스 심볼 (BRK.B → BRK-B) */
export const yahooSymbol = (t: string) => t.replace(/\./g, "-");
