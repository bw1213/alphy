/** 내 단타 전략 (사용자별 daytrade.json). 날마다 종목을 고르는 단타는 일봉 전략 엔진으로 돌지 않아 따로 둠 */
import fs from "fs";
import { OWNER_ID, userFile, writeUserFile } from "../settings/userdir";
import { normalizeDayTrade, type DayTradeSpec } from "./screen";

type Env = Record<string, string | undefined>;

export interface SavedDayTrade { name: string; spec: DayTradeSpec; note?: string; updatedAt: string }

export const MAX_DAYTRADES = 30;

export function loadDayTrades(user: string = OWNER_ID, e: Env = process.env): SavedDayTrade[] {
  try {
    const j = JSON.parse(fs.readFileSync(userFile("daytrade.json", user, e), "utf8"));
    return Array.isArray(j) ? j.filter((x) => x && typeof x.name === "string").map((x) => ({ name: x.name, spec: normalizeDayTrade(x.spec), note: typeof x.note === "string" ? x.note : undefined, updatedAt: String(x.updatedAt ?? "") })) : [];
  } catch { return []; }
}

export function saveDayTrade(x: { name?: unknown; spec?: unknown; note?: unknown }, opts: { overwrite?: boolean; user?: string; now?: Date } = {}, e: Env = process.env): SavedDayTrade {
  const name = String(x.name ?? "").trim();
  if (!name || name.length > 60) throw new Error("전략 이름은 1~60자로 정하세요.");
  const user = opts.user ?? OWNER_ID;
  const list = loadDayTrades(user, e);
  const old = list.findIndex((s) => s.name === name);
  if (old >= 0 && !opts.overwrite) throw new Error(`'${name}' 이름의 단타 전략이 이미 있습니다.`);
  if (old < 0 && list.length >= MAX_DAYTRADES) throw new Error(`단타 전략은 ${MAX_DAYTRADES}개까지 저장합니다.`);
  const item: SavedDayTrade = { name, spec: normalizeDayTrade(x.spec), ...(typeof x.note === "string" && x.note.trim() ? { note: x.note.trim().slice(0, 500) } : {}), updatedAt: (opts.now ?? new Date()).toISOString() };
  if (old >= 0) list[old] = item; else list.unshift(item);
  writeUserFile("daytrade.json", JSON.stringify(list, null, 2), user, e);
  return item;
}

export function deleteDayTrade(name: string, user: string = OWNER_ID, e: Env = process.env): void {
  const list = loadDayTrades(user, e).filter((s) => s.name !== name);
  writeUserFile("daytrade.json", JSON.stringify(list, null, 2), user, e);
}
