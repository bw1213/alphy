/**
 * 화면에서 시세 받기 (/api/data).
 * 서버가 20초 안에 못 끝내면 작업 id 를 주므로(202), 끝날 때까지 GET ?job= 으로 이어서 물어봄.
 * 프록시·서버 오류로 JSON 이 아닌 응답(HTML 오류 페이지 등)이 와도 알아볼 수 있는 말로 알려 줌.
 */
import type { DataResponse } from "@/lib/data/server";

export interface Progress { done: number; total: number }

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** 응답 본문을 JSON 으로 읽되, JSON 이 아니면 상태 코드에 맞는 설명으로 에러 */
export async function readJson(r: Response): Promise<any> {
  const text = await r.text();
  try { return JSON.parse(text); }
  catch {
    if (r.status === 504 || r.status === 502 || r.status === 524) throw new Error(`서버 응답이 너무 늦어 중간 연결(프록시)이 끊겼습니다 (HTTP ${r.status}). 잠시 뒤 다시 실행해 주세요. 서버는 계속 받고 있어서 다시 하면 대개 빨리 끝납니다.`);
    if (r.status === 401) throw new Error("로그인이 풀렸습니다. 새로 고침해서 다시 로그인해 주세요.");
    throw new Error(`서버가 알 수 없는 응답을 보냈습니다 (HTTP ${r.status}${text ? `: ${text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)}` : ""}).`);
  }
}

export async function fetchData(req: object, onProgress?: (p: Progress) => void, f: Fetch = (u, i) => fetch(u, i), maxPolls = 720, retryMs = 2000): Promise<DataResponse> {
  let r = await f("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  let j = await readJson(r);
  let fails = 0;
  for (let i = 0; r.status === 202 && j?.job; i++) {
    if (i >= maxPolls) throw new Error("시세 받기가 너무 오래 걸립니다. 기간이나 종목 수를 줄여 다시 해 보세요.");
    if (j.progress && onProgress) onProgress(j.progress);
    const job = j;
    // 서버가 최대 20초 붙잡고 있다가 답하므로 바로 다시 물어봐도 됨
    try {
      r = await f(`/api/data?job=${encodeURIComponent(job.job)}`, { cache: "no-store" });
      j = await readJson(r);
      fails = 0;
    } catch (e) {
      // 잠깐의 네트워크 끊김·프록시 타임아웃이면 같은 작업을 다시 물어봄 (서버에서는 계속 받는 중)
      const transient = e instanceof TypeError || /프록시/.test((e as Error).message);
      if (!transient || ++fails > 5) throw e;
      await new Promise((ok) => setTimeout(ok, retryMs));
      r = new Response(null, { status: 202 });
      j = job;
    }
  }
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j as DataResponse;
}
