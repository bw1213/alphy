/** 한국 시간 도우미 (서버 시간대와 상관없이 계산) */

export interface Kst {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  hm: string;
  /** 0=일 … 6=토 */
  dow: number;
}

export function kst(now = Date.now()): Kst {
  const d = new Date(now + 9 * 3600_000);
  return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16), dow: d.getUTCDay() };
}

export const isWeekday = (k: Kst) => k.dow >= 1 && k.dow <= 5;

/** "18:00" 같은 값 검사. 틀리면 null */
export function cleanHm(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

export const minusDays = (iso: string, n: number) => new Date(Date.parse(iso) - n * 864e5).toISOString().slice(0, 10);
