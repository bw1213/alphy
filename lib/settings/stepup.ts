/** 실전 매매를 켜는 동작 직전에 2단계 인증 코드를 다시 확인 (로그인과 같은 시도 제한 사용) */
import { checkTotp, clientIp, loginBlockedFor, recordFail, totpEnabled } from "./auth";

type Env = Record<string, string | undefined>;

/** 통과하면 null, 아니면 화면에 보여 줄 이유 */
export function stepUpError(req: Request, user: string, code: unknown, e: Env = process.env, now = Date.now()): string | null {
  if (!totpEnabled(e, user)) return "먼저 설정 → 보안에서 2단계 인증을 켜세요.";
  const ip = clientIp(req);
  const wait = loginBlockedFor(ip, now, user);
  if (wait > 0) return `코드를 너무 많이 틀렸습니다. ${Math.ceil(wait / 60000)}분 뒤에 다시 하세요.`;
  if (checkTotp(String(code ?? ""), e, now, user)) return null;
  recordFail(ip, now, user);
  return "2단계 인증 코드가 맞지 않습니다. 인증 앱의 새 코드로 다시 하세요.";
}
