/**
 * 실전 주문 금액 상한 (서버 전용). 모의투자 주문에는 적용하지 않습니다.
 * - 1회 상한: 주문 한 건의 금액(수량 × 가격)
 * - 하루 상한: 그날(한국 시간) 실전으로 낸 주문 금액 합계 (매수·매도 모두, 체결 여부와 무관하게 주문 기준)
 * 값은 설정 화면에서 바꾸고, 0 이면 제한 없음. 하루 합계는 설정 폴더의 order-usage.json 에 저장됩니다.
 */
import fs from "fs";
import path from "path";
import { configDir, type OrderLimit } from "../settings/store";

type Env = Record<string, string | undefined>;

/** 한국 시간 기준 날짜 YYYY-MM-DD */
export const kstDate = (now = Date.now()) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);

const usagePath = (e: Env) => path.join(configDir(e), "order-usage.json");

/** 오늘 실전으로 주문한 금액 합계(원) */
export function usedToday(e: Env = process.env, now = Date.now()): number {
  try {
    const j = JSON.parse(fs.readFileSync(usagePath(e), "utf8")) as { date?: string; amount?: number };
    return j.date === kstDate(now) && Number.isFinite(j.amount) ? Number(j.amount) : 0;
  } catch { return 0; }
}

export function addUsage(amount: number, e: Env = process.env, now = Date.now()): number {
  const total = usedToday(e, now) + amount;
  fs.mkdirSync(configDir(e), { recursive: true, mode: 0o700 });
  fs.writeFileSync(usagePath(e), JSON.stringify({ date: kstDate(now), amount: total }), { mode: 0o600 });
  return total;
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 상한을 넘으면 에러 */
export function checkOrderLimit(amount: number, limit: OrderLimit, used: number): void {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("주문 금액을 계산하지 못해 실전 주문을 막았습니다. 지정가로 주문하거나 잠시 뒤 다시 하세요.");
  if (limit.perOrder > 0 && amount > limit.perOrder) {
    throw new Error(`주문 금액 ${won(amount)}이 1회 상한 ${won(limit.perOrder)}을 넘습니다. 상한은 설정 화면(/settings)에서 바꿉니다.`);
  }
  if (limit.perDay > 0 && used + amount > limit.perDay) {
    throw new Error(`오늘 실전 주문 합계가 하루 상한 ${won(limit.perDay)}을 넘습니다 (오늘 ${won(used)} + 이번 ${won(amount)}). 상한은 설정 화면(/settings)에서 바꿉니다.`);
  }
}
