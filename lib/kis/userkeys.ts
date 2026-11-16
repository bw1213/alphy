/**
 * 사람별 한국투자증권 설정 (서버 전용). 여러 사람이 쓰도록 바꾸는 3단계.
 *
 * - owner: 지금까지처럼 settings.json(+환경변수). 바뀐 것 없음
 * - 그 밖의 사람: {설정 폴더}/users/<아이디>/kis.json 에 암호화해서 저장 (lib/settings/secretbox.ts)
 *   각자 본인 앱키·계좌만 넣고, 다른 사람(관리자 포함)은 볼 수 없습니다.
 *
 * 실전 주문이 나가려면 (owner 가 아닌 사람):
 *   1) 서버 전체 잠금 해제  KIS_ALLOW_REAL_ORDERS=yes (환경변수, 지금과 같음)
 *   2) owner 가 그 사람에게 "실전 허용" (설정 → 사용자)
 *   3) 본인이 2단계 인증을 켜 둠
 *   4) 본인 설정에서 주문 대상을 실전으로
 */
import fs from "fs";
import path from "path";
import { DEFAULT_AUTO_LIMIT, DEFAULT_ORDER_LIMIT, loadSettings, type AutoLimit, runtimeEnv, type KisEnvName, type KisKeySet, type OrderLimit, type Settings } from "../settings/store";
import { open, seal } from "../settings/secretbox";
import { ensureUserDir, OWNER_ID, userDir } from "../settings/userdir";
import type { User } from "../settings/users";

type Env = Record<string, string | undefined>;

export interface UserKis { real: KisKeySet; mock: KisKeySet; tradeEnv: KisEnvName; orderLimit: OrderLimit; autoLimit: AutoLimit }

export const emptyUserKis = (): UserKis => ({ real: {}, mock: {}, tradeEnv: "mock", orderLimit: { ...DEFAULT_ORDER_LIMIT }, autoLimit: { ...DEFAULT_AUTO_LIMIT } });

const file = (user: string, e: Env) => path.join(userDir(user, e), "kis.json");

/** 없으면 빈 설정. 풀지 못하면 에러(키가 바뀐 경우) */
export function loadUserKis(user: string, e: Env = process.env): UserKis {
  let raw: string;
  try { raw = fs.readFileSync(file(user, e), "utf8"); } catch { return emptyUserKis(); }
  const j = JSON.parse(open(JSON.parse(raw).sealed, e)) as Partial<UserKis>;
  const d = emptyUserKis();
  return {
    real: { ...(j.real ?? {}) }, mock: { ...(j.mock ?? {}) },
    tradeEnv: j.tradeEnv === "real" ? "real" : "mock",
    orderLimit: { ...d.orderLimit, ...(j.orderLimit ?? {}) },
    autoLimit: { ...d.autoLimit, ...(j.autoLimit ?? {}) },
  };
}

export function saveUserKis(user: string, k: UserKis, e: Env = process.env): void {
  if (user === OWNER_ID) throw new Error("owner 의 한국투자증권 설정은 서버 설정에 저장됩니다.");
  ensureUserDir(user, e);
  const f = file(user, e);
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, sealed: seal(JSON.stringify(k), e) }), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** 계정을 지울 때 그 사람의 앱키·계좌도 지움 */
export function deleteUserKis(user: string, e: Env = process.env): void {
  if (user === OWNER_ID) return;
  try { fs.unlinkSync(file(user, e)); } catch { /* 없음 */ }
}

/** 그 사람의 실전 주문 잠금 상태 */
export interface RealLock { server: boolean; granted: boolean; totp: boolean; open: boolean }

export function realLock(u: Pick<User, "id" | "realOrders" | "totpSecret">, e: Env = process.env): RealLock {
  const server = /^(yes|true|1)$/i.test(e.KIS_ALLOW_REAL_ORDERS?.trim() ?? "");
  if (u.id === OWNER_ID) return { server, granted: true, totp: true, open: server };
  const granted = u.realOrders === true, totp = !!u.totpSecret;
  return { server, granted, totp, open: server && granted && totp };
}

/** lib/kis/config.ts 함수들에 넘길 값 묶음 (그 사람의 키·주문 대상·실전 잠금) */
export function kisEnvFor(u: Pick<User, "id" | "realOrders" | "totpSecret">, e: Env = process.env): Env {
  if (u.id === OWNER_ID) return runtimeEnv(e);
  const k = loadUserKis(u.id, e);
  const v = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  return {
    KIS_REAL_APP_KEY: v(k.real.appKey), KIS_REAL_APP_SECRET: v(k.real.appSecret), KIS_REAL_ACCOUNT: v(k.real.account),
    KIS_MOCK_APP_KEY: v(k.mock.appKey), KIS_MOCK_APP_SECRET: v(k.mock.appSecret), KIS_MOCK_ACCOUNT: v(k.mock.account),
    KIS_TRADE_ENV: k.tradeEnv,
    KIS_ALLOW_REAL_ORDERS: realLock(u, e).open ? "yes" : undefined,
  };
}

export function orderLimitFor(user: string, e: Env = process.env): OrderLimit {
  return user === OWNER_ID ? loadSettings(e).kis.orderLimit : loadUserKis(user, e).orderLimit;
}

/** 자동 매매 한도 (실전 운용 금액 상한, 손실 한도) */
export function autoLimitFor(user: string, e: Env = process.env): AutoLimit {
  return user === OWNER_ID ? loadSettings(e).kis.autoLimit : loadUserKis(user, e).autoLimit;
}

/** 설정 화면 코드(view.ts)를 그대로 쓰기 위한 모양: 그 사람의 KIS + 서버의 백테스트 기본값 */
export function memberSettings(user: string, e: Env = process.env): Settings {
  const s = loadSettings(e);
  return { version: 1, kis: loadUserKis(user, e), backtest: s.backtest, auth: {}, auto: { eveningTime: s.auto.eveningTime, morningTime: s.auto.morningTime, cutoffTime: s.auto.cutoffTime } };
}
