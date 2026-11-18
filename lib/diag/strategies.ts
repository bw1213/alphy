/**
 * 점검 키로 내 전략 추가 (서버 전용). POST /api/diag/strategies
 *
 * 기본 전략(앱에 들어 있는 코드) 하나를 골라 종목·파라미터만 넣어 owner 의 내 전략에 저장한다.
 * - 코드는 받지 않음: 내 전략 코드는 사용자 브라우저에서 실행되므로, 밖에서 코드를 넣을 수 있으면 위험하다.
 * - 같은 이름이 있으면 overwrite: true 일 때만, 그것도 기본 전략 코드로 된 항목만 덮어씀(직접 쓴 코드는 건드리지 않음).
 */
import { normalizeTicker } from "../data/market";
import { STRATEGIES } from "../strategies";
import { loadStrategies, upsertStrategy, type SavedStrategy } from "../strategies/library";
import { cleanUniverse } from "../strategies/universe";

type Env = Record<string, string | undefined>;

export interface DiagStrategyRequest {
  /** 내 전략 이름 */
  name: string;
  /** 기본 전략 id (예: "rotation") */
  builtin: string;
  /** 바꿀 파라미터만. 없는 키는 기본값, 범위를 넘으면 범위 안으로 */
  params?: Record<string, number>;
  /** 종목 코드 1~30개 */
  tickers: string[];
  /** 상장 전 기간을 지수로 채우기 */
  backfill?: boolean;
  /** 같은 이름(기본 전략으로 저장된 것)을 덮어쓰기 */
  overwrite?: boolean;
}

export class DiagStrategyError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const BUILTIN_CODES = new Set(STRATEGIES.map((s) => s.code));

export function saveBuiltinStrategy(body: DiagStrategyRequest, e: Env = process.env, now = new Date()): SavedStrategy {
  const def = STRATEGIES.find((s) => s.id === body?.builtin);
  if (!def) throw new DiagStrategyError(`기본 전략 id 가 아닙니다. 쓸 수 있는 것: ${STRATEGIES.map((s) => s.id).join(", ")}`);
  const name = String(body.name ?? "").trim();
  const tickers = [...new Set((Array.isArray(body.tickers) ? body.tickers : []).map((t) => normalizeTicker(String(t))).filter(Boolean))];
  if (!tickers.length || tickers.length > 30) throw new DiagStrategyError("종목은 1~30개를 넣으세요.");
  const given = body.params && typeof body.params === "object" ? body.params : {};
  const p: Record<string, number> = {};
  for (const s of def.params) {
    const v = Number(given[s.key]);
    p[s.key] = Number.isFinite(v) ? Math.min(Math.max(v, s.min ?? -Infinity), s.max ?? Infinity) : s.default;
  }
  const old = loadStrategies(e).find((s) => s.name === name);
  if (old && !body.overwrite) throw new DiagStrategyError(`'${name}' 이름의 전략이 이미 있습니다. 바꾸려면 overwrite: true`, 409);
  if (old && !BUILTIN_CODES.has(old.code)) throw new DiagStrategyError(`'${name}'은 직접 작성한 코드 전략이라 덮어쓰지 않습니다. 다른 이름을 쓰세요.`, 409);
  const pct = (x: number | null) => (x ? String(Math.round(x * 1000) / 10) : "");
  const universe = cleanUniverse({ mode: "list", size: 100, pit: false, tickers: tickers.join(", "), backfill: body.backfill ? { on: true, picks: {} } : undefined });
  const item = {
    name, code: def.code, params: JSON.stringify(p), rebalance: def.rebalance,
    stopLoss: pct(def.stopLoss), takeProfit: pct(def.takeProfit), warmup: def.warmup(p),
    ...(universe ? { universe } : {}), intraday: false,
  };
  const list = upsertStrategy(item, e, now);
  return list.find((s) => s.name === name)!;
}
