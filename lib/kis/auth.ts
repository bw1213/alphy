/** 주문·잔고 API 보호: 요청 헤더 x-trade-token 이 TRADE_API_TOKEN 과 같아야 함 */
import { createHash, timingSafeEqual } from "crypto";

const h = (s: string) => createHash("sha256").update(s).digest();

/** 통과하면 null, 아니면 [상태코드, 메시지] */
export function checkTradeToken(req: Request, env: Record<string, string | undefined> = process.env): [number, string] | null {
  const want = env.TRADE_API_TOKEN?.trim();
  if (!want) return [403, "주문·잔고 기능이 꺼져 있습니다. 서버 환경변수 TRADE_API_TOKEN(주문 비밀번호)을 설정하세요."];
  const got = req.headers.get("x-trade-token") ?? "";
  if (!timingSafeEqual(h(got), h(want))) return [401, "주문 비밀번호가 틀렸습니다."];
  return null;
}
