/** 1분봉 받기 + 월별 파일 캐시 (서버 전용). 지난 날은 바뀌지 않으므로 한 번 받으면 다시 안 받음 */
import { promises as fs } from "fs";
import path from "path";
import type { MinuteBar } from "../kis/minute";

export interface MinuteDay { date: string; bars: MinuteBar[] }

type MonthCache = Record<string, MinuteBar[]>;

const ROOT = path.join(process.cwd(), ".cache");

const kstNow = (now: number) => new Date(now + 9 * 3600_000).toISOString();

/** 오늘(한국 시간)이고 장 마감 처리 전이면 아직 확정 안 된 날 */
export function settled(date: string, now = Date.now()): boolean {
  const k = kstNow(now);
  const today = k.slice(0, 10);
  if (date < today) return true;
  if (date > today) return false;
  return k.slice(11, 16) >= "16:40";
}

export interface MinuteFetchOptions {
  cacheDir?: string;
  now?: number;
  onDay?: (done: number, total: number) => void;
}

/** dates(YYYY-MM-DD) 날짜별 1분봉. 증권사가 보관하지 않은 날은 빈 배열로 기억함 */
export async function cachedMinuteDays(code: string, dates: string[], fetchDay: (ymd: string) => Promise<MinuteBar[]>, opt: MinuteFetchOptions = {}): Promise<MinuteDay[]> {
  const dir = path.join(opt.cacheDir ?? ROOT, "minute", code.replace(/[^0-9A-Z]/gi, "_"));
  const now = opt.now ?? Date.now();
  const months = new Map<string, MonthCache>();
  const dirty = new Set<string>();
  const load = async (m: string) => {
    if (!months.has(m)) {
      let v: MonthCache = {};
      try { v = JSON.parse(await fs.readFile(path.join(dir, `${m}.json`), "utf8")); } catch { /* 없음 */ }
      months.set(m, v);
    }
    return months.get(m)!;
  };
  const save = async (m: string) => {
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, `${m}.json`);
    await fs.writeFile(`${p}.tmp`, JSON.stringify(months.get(m)));
    await fs.rename(`${p}.tmp`, p);
    dirty.delete(m);
  };
  const out: MinuteDay[] = [];
  let done = 0;
  try {
    for (const date of dates) {
      const m = date.slice(0, 7);
      const cache = await load(m);
      let bars = cache[date];
      if (!bars) {
        bars = await fetchDay(date.replace(/-/g, ""));
        if (settled(date, now)) { cache[date] = bars; dirty.add(m); }
      }
      for (const d of [...dirty]) if (d !== m) await save(d);
      if (bars.length) out.push({ date, bars });
      opt.onDay?.(++done, dates.length);
    }
  } finally {
    for (const d of [...dirty]) await save(d).catch(() => undefined);
  }
  return out;
}
