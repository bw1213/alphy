/**
 * 웹 화면에서 바꾸는 설정 (서버 전용).
 *
 * 저장 위치: {ALPHY_CONFIG_DIR 또는 .cache/config}/settings.json  (권한 600)
 *   Docker 에서는 .cache 가 NAS 의 nas/cache 폴더에 연결돼 있어서 컨테이너를 업데이트해도 남습니다.
 *
 * 우선순위: 환경변수(값이 있으면) > 설정 파일 > 기본값
 *   예전처럼 .env 로 넣은 값도 그대로 동작하고, 그 항목은 화면에서 "환경변수로 고정"으로 보입니다.
 *
 * 환경변수로만 바꿀 수 있는 것 (보안상 이유):
 *   KIS_ALLOW_REAL_ORDERS  실전 주문 잠금 해제. 화면 비밀번호가 새도 실전 돈이 나가지 않도록 NAS 파일 접근이 있어야만 풀림
 *   ADMIN_PASSWORD         (선택) 관리자 비밀번호를 화면 대신 고정하고 싶을 때. 예전 이름 TRADE_API_TOKEN 도 인식
 */
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

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
  universeSize: number;
}

/** 실전 주문 금액 상한(원). 0 = 제한 없음 */
export interface OrderLimit { perOrder: number; perDay: number }

export const DEFAULT_ORDER_LIMIT: OrderLimit = { perOrder: 1_000_000, perDay: 5_000_000 };

export interface Settings {
  version: 1;
  kis: { real: KisKeySet; mock: KisKeySet; tradeEnv: KisEnvName; orderLimit: OrderLimit };
  backtest: BacktestDefaults;
  auth: { passwordHash?: string; sessionSecret?: string; setupCode?: string };
}

export const DEFAULT_BACKTEST: BacktestDefaults = {
  source: "naver", cash: 10_000_000, commission: 0.015, slippage: 0.1, sellTax: null, universeSize: 100,
};

export const defaultSettings = (): Settings => ({
  version: 1,
  kis: { real: {}, mock: {}, tradeEnv: "mock", orderLimit: { ...DEFAULT_ORDER_LIMIT } },
  backtest: { ...DEFAULT_BACKTEST },
  auth: {},
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
    },
    backtest: { ...d.backtest, ...(raw.backtest ?? {}) },
    auth: { ...(raw.auth ?? {}) },
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

/**
 * KIS 설정 코드(lib/kis/config.ts)가 읽는 값 묶음.
 * 설정 파일 값 위에 환경변수를 덮어씀. KIS_ALLOW_REAL_ORDERS 는 환경변수에서만 가져옴.
 */
export function runtimeEnv(e: Env = process.env): Env {
  const s = loadSettings(e);
  const out: Env = {};
  for (const env of ["real", "mock"] as const) {
    for (const [field, name] of Object.entries(KIS_FIELDS[env])) {
      out[name] = nonEmpty(e[name]) ?? nonEmpty(s.kis[env][field as keyof KisKeySet]);
    }
  }
  out.KIS_TRADE_ENV = nonEmpty(e.KIS_TRADE_ENV) ?? s.kis.tradeEnv;
  out.KIS_ALLOW_REAL_ORDERS = e.KIS_ALLOW_REAL_ORDERS;
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
