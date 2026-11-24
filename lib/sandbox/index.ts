import { cleanResult, DEFAULT_LIMITS, runIsolated, SandboxError, type SandboxJob } from "./run";
import type { BacktestResult } from "../engine/types";

export { SandboxError, type SandboxJob } from "./run";

const RUNNER = "http://alphy-runner:3100";
const RETRY_AFTER = 60_000;
let downUntil = 0;
let lastWhere: "runner" | "local" | null = null;

export const sandboxWhere = () => lastWhere;

export async function runnerAlive(): Promise<boolean> {
  try { return (await fetch(`${RUNNER}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

const unreachable = (e: unknown) => {
  const code = (e as any)?.cause?.code ?? (e as any)?.code;
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ECONNRESET"].includes(code);
};

/**
 * 사용자 전략 코드로 백테스트. 전략 실행기 컨테이너가 있으면 거기서, 없으면 이 프로세스 안의 V8 격리 공간에서.
 * 어느 쪽이든 결과는 cleanResult 로 다시 검사.
 */
export async function runStrategyCode(job: SandboxJob, timeoutMs = DEFAULT_LIMITS.timeoutMs): Promise<BacktestResult> {
  if (Date.now() >= downUntil) {
    try {
      const r = await fetch(`${RUNNER}/run`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...job, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 15_000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new SandboxError(j?.error ?? `전략 실행기 오류 (${r.status})`);
      lastWhere = "runner";
      return cleanResult(j, job);
    } catch (e) {
      if (!unreachable(e)) throw e instanceof SandboxError ? e : new SandboxError(`전략 실행기 오류: ${(e as Error).message}`);
      downUntil = Date.now() + RETRY_AFTER;
    }
  }
  lastWhere = "local";
  return runIsolated(job, { ...DEFAULT_LIMITS, timeoutMs });
}
