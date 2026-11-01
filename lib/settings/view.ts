/** 설정 화면용: 비밀값을 가린 보기 + 화면에서 보낸 변경 적용 */
import { parseAccount } from "../kis/config";
import { envPassword, KIS_FIELDS, settingsPath, type BacktestDefaults, type DataSource, type KisEnvName, type KisKeySet, type Settings } from "./store";

type Env = Record<string, string | undefined>;
const has = (v: string | undefined) => !!(v && v.trim());

export interface FieldView { set: boolean; fromEnv: boolean; hint?: string }
export interface SettingsView {
  kis: Record<KisEnvName, { appKey: FieldView; appSecret: FieldView; account: FieldView }> & {
    tradeEnv: { value: KisEnvName; fromEnv: boolean };
  };
  realOrdersAllowed: boolean;
  backtest: BacktestDefaults;
  passwordFromEnv: boolean;
  path: string;
}

const maskAccount = (s: string) => {
  const a = parseAccount(s);
  return a ? `${a.cano.slice(0, 4)}****-${a.acntPrdtCd}` : "형식 오류";
};

export function settingsView(s: Settings, e: Env = process.env): SettingsView {
  const field = (env: KisEnvName, f: keyof KisKeySet): FieldView => {
    const envName = KIS_FIELDS[env][f];
    const fromEnv = has(e[envName]);
    const v = (fromEnv ? e[envName] : s.kis[env][f])?.trim() ?? "";
    if (!v) return { set: false, fromEnv: false };
    const hint = f === "appKey" ? `…${v.slice(-4)}` : f === "account" ? maskAccount(v) : undefined;
    return { set: true, fromEnv, hint };
  };
  const one = (env: KisEnvName) => ({ appKey: field(env, "appKey"), appSecret: field(env, "appSecret"), account: field(env, "account") });
  const tradeFromEnv = has(e.KIS_TRADE_ENV);
  return {
    kis: {
      real: one("real"), mock: one("mock"),
      tradeEnv: { value: (tradeFromEnv ? e.KIS_TRADE_ENV!.trim().toLowerCase() : s.kis.tradeEnv) === "real" ? "real" : "mock", fromEnv: tradeFromEnv },
    },
    realOrdersAllowed: /^(yes|true|1)$/i.test(e.KIS_ALLOW_REAL_ORDERS?.trim() ?? ""),
    backtest: s.backtest,
    passwordFromEnv: !!envPassword(e),
    path: settingsPath(e),
  };
}

/** 화면에서 보내는 변경. 항목이 없으면 그대로, "" 이면 지움 */
export interface SettingsPatch {
  kis?: Partial<Record<KisEnvName, Partial<Record<keyof KisKeySet, string>>>> & { tradeEnv?: KisEnvName };
  backtest?: Partial<BacktestDefaults>;
}

const SOURCES: DataSource[] = ["naver", "kis", "csv", "synthetic"];

function num(v: unknown, label: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}: ${min} ~ ${max} 사이 숫자를 넣으세요.`);
  return n;
}

/** 변경을 검증해서 s 에 적용 (잘못된 값이면 에러, s 는 그대로) */
export function applyPatch(s: Settings, p: SettingsPatch): Settings {
  const next = structuredClone(s);
  for (const env of ["real", "mock"] as const) {
    const part = p.kis?.[env];
    if (!part) continue;
    for (const f of ["appKey", "appSecret", "account"] as const) {
      if (part[f] === undefined) continue;
      const v = String(part[f] ?? "").trim();
      if (v.length > 500) throw new Error("값이 너무 깁니다.");
      if (f === "account" && v && !parseAccount(v)) throw new Error(`${env === "real" ? "실전" : "모의투자"} 계좌번호는 12345678-01 형식입니다.`);
      if (v) next.kis[env][f] = v; else delete next.kis[env][f];
    }
  }
  if (p.kis?.tradeEnv !== undefined) {
    if (p.kis.tradeEnv !== "real" && p.kis.tradeEnv !== "mock") throw new Error("주문 대상은 mock 또는 real 입니다.");
    next.kis.tradeEnv = p.kis.tradeEnv;
  }
  const b = p.backtest;
  if (b) {
    if (b.source !== undefined) {
      if (!SOURCES.includes(b.source)) throw new Error("데이터 소스가 올바르지 않습니다.");
      next.backtest.source = b.source;
    }
    if (b.cash !== undefined) next.backtest.cash = Math.round(num(b.cash, "초기 자금", 100_000, 1e12));
    if (b.commission !== undefined) next.backtest.commission = num(b.commission, "수수료 %", 0, 5);
    if (b.slippage !== undefined) next.backtest.slippage = num(b.slippage, "슬리피지 %", 0, 10);
    if (b.sellTax !== undefined) next.backtest.sellTax = b.sellTax === null || String(b.sellTax).trim() === "" ? null : num(b.sellTax, "매도세 %", 0, 5);
    if (b.universeSize !== undefined) next.backtest.universeSize = Math.round(num(b.universeSize, "종목 수", 5, 300));
  }
  return next;
}
