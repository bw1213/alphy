/**
 * 오래 걸릴 수 있는 API 를 "작업 시작 → 짧게 기다림 → 안 끝나면 202 + 작업 id → 주기적으로 다시 물어봄" 으로 바꾸는 도우미 (서버 전용).
 *
 * 규칙: 외부 접속은 NAS(DSM) 역방향 프록시를 거치고, 프록시는 응답이 60초 없으면 연결을 끊고 HTML 오류 페이지를 줌.
 * 그래서 30초 넘게 걸릴 수 있는 요청은 끝날 때까지 붙잡지 말고 이 도우미를 씀. 화면 쪽은 lib/client/fetchData.ts 의 fetchJob.
 */
import { NextResponse } from "next/server";
import { createJobStore, type JobStore, type JobView } from "./jobs";

/** 한 요청이 기다리는 최대 시간. 프록시 60초 제한보다 넉넉히 짧게 */
export const WAIT_MS = 20_000;
const noStore = { "Cache-Control": "no-store" };

const g = globalThis as unknown as { __alphyJobStores?: Map<string, JobStore<unknown>> };

/** 이름별 작업 목록 (개발 모드에서 모듈이 다시 읽혀도 유지) */
export function namedJobs<T>(name: string): JobStore<T> {
  const all = (g.__alphyJobStores ??= new Map());
  if (!all.has(name)) all.set(name, createJobStore<unknown>());
  return all.get(name) as JobStore<T>;
}

/** 끝났으면 결과(또는 오류), 아니면 202 { job, progress } */
export function jobReply<T>(store: JobStore<T>, owner: string, j: JobView<T>): NextResponse {
  if (j.state === "done") {
    store.remove(owner, j.id);
    return NextResponse.json(j.result, { headers: noStore });
  }
  if (j.state === "error") {
    store.remove(owner, j.id);
    return NextResponse.json({ error: j.error }, { status: j.status ?? 500, headers: noStore });
  }
  return NextResponse.json({ job: j.id, progress: j.progress ?? null }, { status: 202, headers: noStore });
}

export interface StartOptions {
  /** 오류일 때 돌려줄 HTTP 상태 (기본 500) */
  errStatus?: (e: unknown) => number | undefined;
  waitMs?: number;
}

/** 작업을 시작하고 waitMs 만큼만 기다려 답함. 같은 사람이 같은 key 로 이미 돌리고 있으면 그 작업을 이어서 봄 */
export async function startJob<T>(store: JobStore<T>, owner: string, key: string, fn: (progress: (done: number, total: number) => void) => Promise<T>, opts: StartOptions = {}): Promise<NextResponse> {
  const j = store.start(owner, key, fn, opts.errStatus);
  return jobReply(store, owner, (await store.wait(owner, j.id, opts.waitMs ?? WAIT_MS)) ?? j);
}

/** ?job= 으로 이어서 물어볼 때 */
export async function pollJob<T>(store: JobStore<T>, owner: string, id: string, waitMs = WAIT_MS): Promise<NextResponse> {
  const j = await store.wait(owner, id, waitMs);
  if (!j) return NextResponse.json({ error: "작업을 찾지 못했습니다 (이미 결과를 받았거나 서버가 다시 시작됐을 수 있어요). 다시 실행해 주세요." }, { status: 404, headers: noStore });
  return jobReply(store, owner, j);
}
