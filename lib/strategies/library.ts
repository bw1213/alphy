/**
 * 내 전략 보관함 (서버 전용). 화면에서 만든 전략을 NAS 에 저장해 어느 기기에서나 같은 목록을 씁니다.
 * 저장 위치: {설정 폴더}/strategies.json. 읽기는 누구나, 저장은 관리자 로그인 필요(코드가 브라우저에서 실행되므로).
 */
import fs from "fs";
import path from "path";
import { configDir } from "../settings/store";
import type { Rebalance } from "../engine/types";
import { normalizeSpec, type BuilderSpec } from "./builder";

export interface SavedStrategy {
  name: string;
  code: string;
  /** 파라미터 JSON 문자열 */
  params: string;
  rebalance: Rebalance;
  /** % 문자열, 비우면 없음 */
  stopLoss: string;
  takeProfit: string;
  warmup: number;
  /** 조건 고르기로 만든 전략이면 그 조건 (다시 열어 고칠 수 있게) */
  builder?: BuilderSpec;
  /** 저장 시각 (ISO) */
  updatedAt?: string;
}

type Env = Record<string, string | undefined>;
export const MAX_STRATEGIES = 100;
const file = (e: Env) => path.join(configDir(e), "strategies.json");

/** 화면에서 온 값을 검증해 깨끗한 항목으로. 잘못되면 에러 */
export function cleanStrategy(x: any): SavedStrategy {
  const name = String(x?.name ?? "").trim();
  if (!name || name.length > 60) throw new Error("전략 이름은 1~60자로 정하세요.");
  const code = String(x?.code ?? "");
  if (!code.trim()) throw new Error(`'${name}': 전략 코드가 비어 있습니다.`);
  if (code.length > 50_000) throw new Error(`'${name}': 전략 코드가 너무 깁니다.`);
  const params = String(x?.params ?? "{}").trim() || "{}";
  if (params.length > 5000) throw new Error(`'${name}': 파라미터가 너무 깁니다.`);
  try { const p = JSON.parse(params); if (!p || typeof p !== "object" || Array.isArray(p)) throw 0; }
  catch { throw new Error(`'${name}': 파라미터는 { "이름": 숫자 } 형식의 JSON 이어야 합니다.`); }
  const r = x?.rebalance;
  const rebalance: Rebalance = r === "D" || r === "W" || r === "M" || r === "Q" ? r
    : Number.isInteger(r) && r >= 1 && r <= 250 ? r : "M";
  const pctStr = (v: unknown) => { const t = String(v ?? "").trim(); return t !== "" && Number.isFinite(Number(t)) && Number(t) > 0 ? t : ""; };
  const warmup = Math.min(Math.max(Math.round(Number(x?.warmup) || 0), 0), 2000);
  return { name, code, params, rebalance, stopLoss: pctStr(x?.stopLoss), takeProfit: pctStr(x?.takeProfit), warmup,
    ...(x?.builder && typeof x.builder === "object" ? { builder: normalizeSpec(x.builder) } : {}),
    updatedAt: typeof x?.updatedAt === "string" ? x.updatedAt.slice(0, 30) : undefined };
}

export function loadStrategies(e: Env = process.env): SavedStrategy[] {
  try {
    const j = JSON.parse(fs.readFileSync(file(e), "utf8"));
    if (!Array.isArray(j)) return [];
    const out: SavedStrategy[] = [];
    for (const x of j) { try { out.push(cleanStrategy(x)); } catch { /* 깨진 항목은 건너뜀 */ } }
    return out;
  } catch { return []; }
}

function save(list: SavedStrategy[], e: Env) {
  fs.mkdirSync(configDir(e), { recursive: true, mode: 0o700 });
  const tmp = `${file(e)}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file(e));
}

/** 같은 이름이 있으면 덮어쓰고, 없으면 추가 */
export function upsertStrategy(x: unknown, e: Env = process.env, now = new Date()): SavedStrategy[] {
  const item = { ...cleanStrategy(x), updatedAt: now.toISOString() };
  const list = loadStrategies(e).filter((s) => s.name !== item.name);
  if (list.length >= MAX_STRATEGIES) throw new Error(`전략은 ${MAX_STRATEGIES}개까지 저장할 수 있습니다.`);
  list.push(item);
  save(list, e);
  return list;
}

export function deleteStrategy(name: string, e: Env = process.env): SavedStrategy[] {
  const list = loadStrategies(e).filter((s) => s.name !== name);
  save(list, e);
  return list;
}
