/** 점검 API 출입 확인: 로그인한 관리자 또는 유효한 점검 키 */
import { clientIp, isLoggedIn } from "../settings/auth";
import { bearerToken, findDiagToken, touchDiagToken } from "../settings/diag";

/** 통과하면 누가 들어왔는지, 아니면 null */
export function diagAccess(req: Request): { via: "session" } | { via: "token"; id: string; name: string } | null {
  if (isLoggedIn(req)) return { via: "session" };
  const t = findDiagToken(bearerToken(req));
  if (!t) return null;
  touchDiagToken(t.id, clientIp(req));
  return { via: "token", id: t.id, name: t.name };
}

export const DENIED = { error: "점검 키가 없거나 만료·폐기됐습니다. 설정 화면의 '점검 키'에서 새로 발급하세요." };
