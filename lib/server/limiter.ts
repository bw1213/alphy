/**
 * 서버 부하 제한 (서버 전용, 프로세스 메모리). NAS(DS220+)가 느려서 여러 사람이 동시에 시세를 받으면 버거움.
 *
 * - 동시 실행 제한: 시세 받기(/api/data)·서버 백테스트는 한 번에 2건만 돌고, 나머지는 줄을 섬(최대 8건·3분)
 * - 사람별 요청 제한: 한 사람이 5분 동안 40번까지. 넘으면 잠시 뒤 다시 하라고 알려 줌
 */
export const MAX_ACTIVE = 2;
export const MAX_QUEUE = 8;
export const QUEUE_TIMEOUT_MS = 180_000;
export const RATE_MAX = 40;
export const RATE_WINDOW_MS = 5 * 60_000;

export class BusyError extends Error {
  readonly status = 429;
}

export interface Gate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  stats(): { active: number; queued: number; maxActive: number; maxQueue: number };
}

export function createGate(maxActive = MAX_ACTIVE, maxQueue = MAX_QUEUE, timeoutMs = QUEUE_TIMEOUT_MS): Gate {
  let active = 0;
  const waiting: { start: () => void; cancel: () => void }[] = [];
  const next = () => { if (active < maxActive) waiting.shift()?.start(); };
  return {
    stats: () => ({ active, queued: waiting.length, maxActive, maxQueue }),
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= maxActive) {
        if (waiting.length >= maxQueue) throw new BusyError("지금 다른 사람들의 요청이 많습니다. 1~2분 뒤에 다시 실행해 주세요.");
        await new Promise<void>((resolve, reject) => {
          const item = {
            start: () => { clearTimeout(timer); resolve(); },
            cancel: () => { const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i, 1); reject(new BusyError("앞선 요청이 오래 걸려 기다리다 멈췄습니다. 잠시 뒤 다시 실행해 주세요.")); },
          };
          const timer = setTimeout(item.cancel, timeoutMs);
          waiting.push(item);
        });
      }
      active++;
      try { return await fn(); }
      finally { active--; next(); }
    },
  };
}

/** 시세 받기·서버 백테스트가 함께 쓰는 문 */
export const dataGate = createGate();

const hits = new Map<string, number[]>();

/** 통과하면 0, 넘었으면 다시 해도 되는 때까지 남은 ms */
export function rateLimited(user: string, now = Date.now(), max = RATE_MAX, windowMs = RATE_WINDOW_MS): number {
  const list = (hits.get(user) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(user, list); return windowMs - (now - list[0]); }
  list.push(now);
  hits.set(user, list);
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return 0;
}

export function resetRateLimits() { hits.clear(); }
