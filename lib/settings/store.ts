/**
 * 웹 화면에서 바꾸는 설정 (서버 전용).
 *
 * 저장 위치: {ALPHY_CONFIG_DIR 또는 .cache/config}/settings.json  (권한 600)
 *   Docker 에서는 .cache 가 NAS 의 nas/cache 폴더에 연결돼 있어서 컨테이너를 업데이트해도 남습니다.
 *
 * 우선순위: 환경변수(값이 있으면) > 설정 파일 > 기본값
 *   예전처럼 .env 로 넣은 값도 그대로 동작하고, 그 항목은 화면에서 "환경변수로 고정"으로 보입니다.
 *
 * 실전 주문 잠금 해제: 화면에서 owner 가 2단계 인증 코드로 켬(kis.realUnlock). owner 의 2단계 인증이 꺼지면 다시 잠김.
 *   KIS_ALLOW_REAL_ORDERS=yes 면 항상 해제, =no 면 화면에서도 못 풂.
 * ADMIN_PASSWORD (선택) 관리자 비밀번호를 화면 대신 고정하고 싶을 때. 예전 이름 TRADE_API_TOKEN 도 인식
 */
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { getUser } from "./users";
import { OWNER_ID } from "./userdir";

export type KisEnvName = "real" | "mock";
export type DataSource = "naver" | "kis" | "csv" | "synthetic";

export interface KisKeySet { appKey?: string; appSecret?: string; account?: string }

export interface BacktestDefaults {
  source: DataSource;
  /** 초기 자금(원) */
  cash: number;
  /** % 단위 (0.015 = 0.015%) */
  commission: number;
  slippage: number;
  /** % 단위, null 이면 연도별 법정세율 */
  sellTax: number | null;
  /** 미국 종목 수수료 % (0.25 = 0.25%) */
  usCommission: number;
  /** 미국 종목 환전 비용 % (살 때·팔 때 각각) */
  usFx: number;
  universeSize: number;
  /** 목표 연평균 수익률 % (15 = 연 15%) */
  targetCagr: number;
  /** 감당할 최대 낙폭 % (25 = -25% 까지) */
  maxDrawdown: number;
}

/** 실전 주문 금액 상한(원). 0 = 제한 없음 */
export interface OrderLimit { perOrder: number; perDay: number }

export const DEFAULT_ORDER_LIMIT: OrderLimit = { perOrder: 1_000_000, perDay: 5_000_000 };

/** 자동 매매 한도 (사람마다). realBudget: 실전 계좌로 운용할 수 있는 최대 금액(원, 0 = 제한 없음), maxLoss: 운용 금액 대비 손실 %에 닿으면 자동 매매를 멈춤(0 = 안 멈춤) */
export interface AutoLimit { realBudget: number; maxLoss: number }

export const DEFAULT_AUTO_LIMIT: AutoLimit = { realBudget: 1_000_000, maxLoss: 15 };

/** 자동 매매 (lib/auto) 서버 공용 설정. 관리자(owner)만 바꿈 */
export interface AutoSettings {
  /** 저녁 계산 시각 (한국 시간 HH:MM, 장 마감 15:30 이후) */
  eveningTime: string;
  /** 아침 자동 주문 시각 (장 시작 동시호가에 넣어 시가에 체결) */
  morningTime: string;
  /** 이 시각까지 체결 안 된 주문은 취소 */
  cutoffTime: string;
  /** 텔레그램 봇 토큰 (BotFather 에서 받음). 알림을 보내는 데만 씀 */
  telegramToken?: string;
  /** 봇 사용자 이름 (@ 없이). 토큰을 넣을 때 확인해서 저장 */
  telegramBot?: string;
  /** 증권사·규칙표에 없는 임시 휴장일 (시장별 YYYY-MM-DD) */
  extraClosed?: { KR?: string[]; US?: string[] };
  /** 한국 장이 10:00 에 열고 16:30 에 닫는 날 (수능일 등) */
  lateOpen?: string[];
}

export const DEFAULT_AUTO: AutoSettings = { eveningTime: "18:00", morningTime: "08:40", cutoffTime: "10:00" };

export interface RealUnlock { at: number; ip?: string }

export interface Settings {
  version: 1;
  auto: AutoSettings;
  kis: { real: KisKeySet; mock: KisKeySet; tradeEnv: KisEnvName; orderLimit: OrderLimit; autoLimit: AutoLimit; realUnlock?: RealUnlock };
  backtest: BacktestDefaults;
  auth: {
    passwordHash?: string; sessionSecret?: string; setupCode?: string;
    /** 2단계 인증 비밀 키(base32). 있으면 로그인에 인증 앱 6자리 코드가 필요 */
    totpSecret?: string;
    /** 등록 중(아직 코드 확인 전)인 키 */
    totpPending?: string;
    /** 마지막으로 쓴 코드의 시각 단위(같은 코드 재사용 방지) */
    totpLastCounter?: number;
    /** 점검용 접근 키 (lib/settings/diag.ts). 해시만 저장 */
    diagTokens?: import("./diag").DiagToken[];
  };
}

export const DEFAULT_BACKTEST: BacktestDefaults = {
  source: "naver", cash: 10_000_000, commission: 0.015, slippage: 0.1, sellTax: null, usCommission: 0.25, usFx: 0.1, universeSize: 100, targetCagr: 15, maxDrawdown: 25,
};

export const defaultSettings = (): Settings => ({
  version: 1,
  kis: { real: {}, mock: {}, tradeEnv: "mock", orderLimit: { ...DEFAULT_ORDER_LIMIT }, autoLimit: { ...DEFAULT_AUTO_LIMIT } },
  backtest: { ...DEFAULT_BACKTEST },
  auth: {},
  auto: { ...DEFAULT_AUTO },
});

type Env = Record<string, string | undefined>;

export function configDir(e: Env = process.env): string {
  return e.ALPHY_CONFIG_DIR?.trim() || path.join(process.cwd(), ".cache", "config");
}
export const settingsPath = (e: Env = process.env) => path.join(configDir(e), "settings.json");

let cache: { file: string; mtimeMs: number; size: number; value: Settings } | null = null;

function merge(raw: Partial<Settings> | null): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object") return d;
  return {
    version: 1,
    kis: {
      real: { ...(raw.kis?.real ?? {}) },
      mock: { ...(raw.kis?.mock ?? {}) },
      tradeEnv: raw.kis?.tradeEnv === "real" ? "real" : "mock",
      orderLimit: { ...d.kis.orderLimit, ...(raw.kis?.orderLimit ?? {}) },
      autoLimit: { ...d.kis.autoLimit, ...(raw.kis?.autoLimit ?? {}) },
      ...(typeof raw.kis?.realUnlock?.at === "number" ? { realUnlock: { at: raw.kis.realUnlock.at, ip: raw.kis.realUnlock.ip } } : {}),
    },
    backtest: { ...d.backtest, ...(raw.backtest ?? {}) },
    auth: { ...(raw.auth ?? {}) },
    auto: { ...d.auto, ...(raw.auto ?? {}) },
  };
}

/** 설정 파일 읽기 (파일이 바뀌지 않았으면 메모리 캐시) */
export function loadSettings(e: Env = process.env): Settings {
  const file = settingsPath(e);
  let st: fs.Stats | null = null;
  try { st = fs.statSync(file); } catch { /* 없음 */ }
  if (!st) { cache = null; return defaultSettings(); }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return structuredClone(cache.value);
  let raw: Partial<Settings> | null = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { console.error(`[settings] ${file} 를 읽지 못했습니다: ${(err as Error).message}`); }
  const value = merge(raw);
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, value };
  return structuredClone(value);
}

/** 원자적 저장 (임시 파일 → 이름 바꾸기), 권한 600 */
export function saveSettings(s: Settings, e: Env = process.env): void {
  const file = settingsPath(e);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = null;
}

export function updateSettings(fn: (s: Settings) => void, e: Env = process.env): Settings {
  const s = loadSettings(e);
  fn(s);
  saveSettings(s, e);
  return s;
}

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** 화면에서 바꿀 수 있는 KIS 항목 ↔ 환경변수 이름 */
export const KIS_FIELDS = {
  real: { appKey: "KIS_REAL_APP_KEY", appSecret: "KIS_REAL_APP_SECRET", account: "KIS_REAL_ACCOUNT" },
  mock: { appKey: "KIS_MOCK_APP_KEY", appSecret: "KIS_MOCK_APP_SECRET", account: "KIS_MOCK_ACCOUNT" },
} as const;

export interface ServerRealLock { open: boolean; env: "yes" | "no" | null; screen: boolean; at?: number; ownerTotp: boolean }

export function serverRealLock(e: Env = process.env, s: Settings = loadSettings(e)): ServerRealLock {
  const v = e.KIS_ALLOW_REAL_ORDERS?.trim() ?? "";
  const env = /^(yes|true|1)$/i.test(v) ? "yes" : /^(no|false|0)$/i.test(v) ? "no" : null;
  const ownerTotp = !!getUser(OWNER_ID, e)?.totpSecret;
  const screen = !!s.kis.realUnlock && ownerTotp;
  return { open: env === "yes" || (env === null && screen), env, screen, at: s.kis.realUnlock?.at, ownerTotp };
}

/** KIS 설정 코드(lib/kis/config.ts)가 읽는 값 묶음. 설정 파일 값 위에 환경변수를 덮어씀 */
export function runtimeEnv(e: Env = process.env): Env {
  const s = loadSettings(e);
  const out: Env = {};
  for (const env of ["real", "mock"] as const) {
    for (const [field, name] of Object.entries(KIS_FIELDS[env])) {
      out[name] = nonEmpty(e[name]) ?? nonEmpty(s.kis[env][field as keyof KisKeySet]);
    }
  }
  out.KIS_TRADE_ENV = nonEmpty(e.KIS_TRADE_ENV) ?? s.kis.tradeEnv;
  out.KIS_ALLOW_REAL_ORDERS = serverRealLock(e, s).open ? "yes" : undefined;
  return out;
}

/** 환경변수로 고정된 관리자 비밀번호 (없으면 화면에서 정함) */
export function envPassword(e: Env = process.env): string | undefined {
  return nonEmpty(e.ADMIN_PASSWORD) ?? nonEmpty(e.TRADE_API_TOKEN);
}

/** 비밀번호가 아직 없으면 1회용 설정 코드를 만들어 로그와 파일에 남김 (Jenkins 방식) */
export function ensureSetupCode(e: Env = process.env): string | null {
  if (envPassword(e)) return null;
  const s = loadSettings(e);
  if (s.auth.passwordHash) return null;
  if (s.auth.setupCode) return s.auth.setupCode;
  const code = randomBytes(4).toString("hex").toUpperCase();
  s.auth.setupCode = code;
  try {
    saveSettings(s, e);
    fs.writeFileSync(path.join(configDir(e), "setup-code.txt"), `${code}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`[settings] 설정 폴더(${configDir(e)})에 쓰지 못했습니다: ${(err as Error).message}`);
    return null;
  }
  console.log(`[alphy] 처음 설정 코드: ${code}  (설정 화면에서 관리자 비밀번호를 만들 때 필요합니다. nas/cache/config/setup-code.txt 에도 있습니다)`);
  return code;
}

export function clearSetupCode(e: Env = process.env) {
  try { fs.unlinkSync(path.join(configDir(e), "setup-code.txt")); } catch { /* 없음 */ }
}
