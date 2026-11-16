/**
 * 오래 걸리는 작업을 요청과 떼어 서버에서 돌리는 작업 목록 (서버 전용, 프로세스 메모리).
 *
 * 왜: 외부 접속은 DSM 역방향 프록시를 거치는데, 프록시는 응답이 60초쯤 없으면 연결을 끊고
 * HTML 오류 페이지(504)를 돌려줌. 긴 기간·여러 종목 시세를 처음 받을 때는 그보다 오래 걸려서
 * 화면이 그 HTML 을 JSON 으로 읽다가 "Unexpected token '<' ... is not valid JSON" 이 났음.
 * 그래서 시세 받기는 작업으로 시작해 두고, 화면은 짧은 요청으로 몇 초마다 진행 상황을 물어봄.
 */
import crypto from "crypto";

export interface JobView<T> {
  id: string;
  state: "running" | "done" | "error";
  /** 진행 상황 (예: 12/100 종목) */
  progress?: { done: number; total: number };
  result?: T;
  error?: string;
  /** 오류일 때 돌려줄 HTTP 상태 (기본 500) */
  status?: number;
}

interface Job<T> extends JobView<T> {
  owner: string;
  key: string;
  createdAt: number;
  finishedAt?: number;
}

export interface JobStore<T> {
  /** 같은 사람이 같은 요청을 이미 돌리고 있으면 그 작업을 그대로 돌려줌 */
  start(owner: string, key: string, fn: (progress: (done: number, total: number) => void) => Promise<T>, errStatus?: (e: unknown) => number | undefined): JobView<T>;
  /** 다른 사람의 작업은 없는 것으로 봄 */
  get(owner: string, id: string): JobView<T> | null;
  /** 끝날 때까지 최대 ms 만큼 기다린 뒤 상태 */
  wait(owner: string, id: string, ms: number): Promise<JobView<T> | null>;
  /** 결과를 화면에 넘긴 뒤 메모리에서 지움 (시세 결과는 수십 MB 가 될 수 있음) */
  remove(owner: string, id: string): void;
  size(): number;
}

export const JOB_KEEP_MS = 10 * 60_000;
const MAX_JOBS = 50;

const view = <T>(j: Job<T>): JobView<T> => ({ id: j.id, state: j.state, progress: j.progress, result: j.result, error: j.error, status: j.status });

export function createJobStore<T>(now = () => Date.now(), keepMs = JOB_KEEP_MS): JobStore<T> {
  const jobs = new Map<string, Job<T>>();
  const waiters = new Map<string, Set<() => void>>();
  const prune = () => {
    const t = now();
    for (const [id, j] of jobs) if (j.finishedAt !== undefined && t - j.finishedAt > keepMs) jobs.delete(id);
    // 너무 많이 쌓이면 끝난 것부터 오래된 순으로 지움
    if (jobs.size > MAX_JOBS) for (const [id, j] of [...jobs].filter(([, j]) => j.state !== "running").sort((a, b) => a[1].createdAt - b[1].createdAt)) {
      if (jobs.size <= MAX_JOBS) break;
      if (j.state !== "running") jobs.delete(id);
    }
  };
  const finish = (j: Job<T>) => {
    j.finishedAt = now();
    for (const w of waiters.get(j.id) ?? []) w();
    waiters.delete(j.id);
  };
  const own = (owner: string, id: string) => { const j = jobs.get(id); return j && j.owner === owner ? j : null; };
  return {
    size: () => jobs.size,
    remove(owner, id) { if (own(owner, id)) jobs.delete(id); },
    start(owner, key, fn, errStatus) {
      prune();
      for (const j of jobs.values()) if (j.owner === owner && j.key === key && j.state === "running") return view(j);
      const j: Job<T> = { id: crypto.randomBytes(12).toString("base64url"), owner, key, state: "running", createdAt: now() };
      jobs.set(j.id, j);
      const progress = (done: number, total: number) => { j.progress = { done, total }; };
      // 다음 틱에 시작 (fn 이 바로 예외를 던져도 start 는 작업을 돌려줌)
      Promise.resolve().then(() => fn(progress)).then(
        (r) => { j.state = "done"; j.result = r; finish(j); },
        (e) => { j.state = "error"; j.error = (e as Error)?.message ?? String(e); j.status = errStatus?.(e) ?? 500; finish(j); },
      );
      return view(j);
    },
    get(owner, id) {
      prune();
      const j = own(owner, id);
      return j ? view(j) : null;
    },
    async wait(owner, id, ms) {
      const j = own(owner, id);
      if (!j) return null;
      if (j.state === "running" && ms > 0) {
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); waiters.get(id)?.delete(done); resolve(); };
          const timer = setTimeout(done, ms);
          if (!waiters.has(id)) waiters.set(id, new Set());
          waiters.get(id)!.add(done);
        });
      }
      return view(j);
    },
  };
}
