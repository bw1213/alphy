/** 로그인한 사람의 주문·잔고용 자격 증명 (서버 전용) */
import type { User } from "../settings/users";
import { OWNER_ID } from "../settings/userdir";
import { tradeCredentials, type KisCredentials } from "./config";
import { kisEnvFor, realLock } from "./userkeys";

type Env = Record<string, string | undefined>;

/** 실전이 잠겨 있을 때 그 사람에게 보여 줄 이유 */
export function realLockReason(u: User, e: Env = process.env): string | undefined {
  if (u.id === OWNER_ID) return undefined; // owner 는 예전 문구 그대로
  const l = realLock(u, e);
  if (l.open) return undefined;
  const need = [
    !l.server && "서버의 실전 주문 잠금 해제(관리자가 설정 화면에서)",
    !l.granted && "관리자(owner)의 실전 허용",
    !l.totp && "내 계정의 2단계 인증 켜기(설정 → 보안)",
  ].filter(Boolean).join(", ");
  return `실전 주문이 잠겨 있습니다. 필요한 것: ${need}.`;
}

export function tradeCredentialsFor(u: User, e: Env = process.env, acct?: string): KisCredentials {
  return tradeCredentials({ ...kisEnvFor(u, e, acct), ALPHY_REAL_LOCK_REASON: realLockReason(u, e) });
}
