/**
 * 한국투자증권(KIS) Open API 설정.
 * 값은 웹 설정 화면(/settings, 파일: lib/settings/store.ts)에서 넣고, 같은 이름의 환경변수가 있으면 그게 우선합니다.
 * 아래 함수들은 그 둘을 합친 값(runtimeEnv)을 읽습니다.
 *
 *  KIS_REAL_APP_KEY / KIS_REAL_APP_SECRET   실전투자 앱키 (시세 조회에 우선 사용, 실전 주문 시 필요)
 *  KIS_REAL_ACCOUNT                         실전 계좌 "12345678-01" (실전 주문·잔고에만 필요)
 *  KIS_MOCK_APP_KEY / KIS_MOCK_APP_SECRET   모의투자 앱키
 *  KIS_MOCK_ACCOUNT                         모의투자 계좌 "50012345-01"
 *  KIS_TRADE_ENV                            주문·잔고에 쓸 환경: mock(기본) | real
 *  KIS_ALLOW_REAL_ORDERS                    "yes" 일 때만 실전 주문 허용 (안전장치, 환경변수에서만)
 */
import { runtimeEnv } from "../settings/store";

export type KisEnv = "real" | "mock";

export interface KisCredentials {
  env: KisEnv;
  appKey: string;
  appSecret: string;
  /** 종합계좌번호 앞 8자리 */
  cano?: string;
  /** 계좌상품코드 뒤 2자리 (보통 01) */
  acntPrdtCd?: string;
}

export const KIS_BASE_URL: Record<KisEnv, string> = {
  real: "https://openapi.koreainvestment.com:9443",
  mock: "https://openapivts.koreainvestment.com:29443",
};

/** 초당 호출 제한 대비 최소 호출 간격(ms). 실전 20건/초, 모의 2건/초 수준 */
export const KIS_MIN_INTERVAL_MS: Record<KisEnv, number> = { real: 60, mock: 520 };

type Env = Record<string, string | undefined>;

export function parseAccount(s: string | undefined): { cano: string; acntPrdtCd: string } | null {
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length === 10) return { cano: digits.slice(0, 8), acntPrdtCd: digits.slice(8) };
  if (digits.length === 8) return { cano: digits, acntPrdtCd: "01" };
  return null;
}

export function credentialsFor(env: KisEnv, e: Env = runtimeEnv()): KisCredentials | null {
  const P = env === "real" ? "KIS_REAL_" : "KIS_MOCK_";
  const appKey = e[`${P}APP_KEY`]?.trim();
  const appSecret = e[`${P}APP_SECRET`]?.trim();
  if (!appKey || !appSecret) return null;
  const acct = parseAccount(e[`${P}ACCOUNT`]);
  return { env, appKey, appSecret, cano: acct?.cano, acntPrdtCd: acct?.acntPrdtCd };
}

/** 시세 조회용: 실전 키가 있으면 실전(호출 한도가 10배), 없으면 모의 키 */
export function quoteCredentials(e: Env = runtimeEnv()): KisCredentials | null {
  return credentialsFor("real", e) ?? credentialsFor("mock", e);
}

export function tradeEnv(e: Env = runtimeEnv()): KisEnv {
  return e.KIS_TRADE_ENV?.trim().toLowerCase() === "real" ? "real" : "mock";
}

export function realOrdersAllowed(e: Env = runtimeEnv()): boolean {
  return /^(yes|true|1)$/i.test(e.KIS_ALLOW_REAL_ORDERS?.trim() ?? "");
}

/** 주문·잔고용 자격 증명. 실전 환경인데 KIS_ALLOW_REAL_ORDERS 가 없으면 에러 */
export function tradeCredentials(e: Env = runtimeEnv()): KisCredentials {
  const env = tradeEnv(e);
  if (env === "real" && !realOrdersAllowed(e)) {
    throw new Error("실전 주문이 잠겨 있습니다. 실전으로 주문하려면 NAS 의 .env 에 KIS_ALLOW_REAL_ORDERS=yes 를 넣고 컨테이너를 다시 시작해야 합니다 (안전장치).");
  }
  const c = credentialsFor(env, e);
  const label = env === "real" ? "실전" : "모의투자";
  if (!c) throw new Error(`${label} 앱키·앱시크릿이 없습니다. 설정 화면(/settings)에서 넣으세요.`);
  if (!c.cano || !c.acntPrdtCd) throw new Error(`${label} 계좌번호가 없습니다. 설정 화면(/settings)에서 12345678-01 형식으로 넣으세요.`);
  return c;
}

/** 화면에 보여줄 설정 상태 (키 값은 절대 포함하지 않음) */
export function kisStatus(e: Env = runtimeEnv()) {
  const real = credentialsFor("real", e), mock = credentialsFor("mock", e);
  const q = quoteCredentials(e);
  return {
    quotes: q ? q.env : null,
    real: { keys: !!real, account: !!real?.cano },
    mock: { keys: !!mock, account: !!mock?.cano },
    tradeEnv: tradeEnv(e),
    realOrdersAllowed: realOrdersAllowed(e),
  };
}
