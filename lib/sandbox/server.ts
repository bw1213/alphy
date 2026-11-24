/**
 * 전략 실행기 (별도 컨테이너). 비밀값·설정 폴더·인터넷 없이 시세와 전략 코드만 받아 결과를 돌려줌.
 * docker-compose.yml 의 alphy-runner 가 이 파일(sandbox-runner.js)을 실행.
 */
import http from "http";
import { DEFAULT_LIMITS, runIsolated, SandboxError, type SandboxJob } from "./run";

const PORT = 3100;
const MAX_BODY = 300 * 1024 * 1024;
const MAX_WAITING = 8;

let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/run") return send(res, 404, { error: "not found" });
  if (waiting >= MAX_WAITING) return send(res, 503, { error: "전략 실행기가 바쁩니다. 잠시 뒤 다시 하세요." });
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: "요청이 너무 큽니다." }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    let job: SandboxJob;
    try { job = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "요청 형식 오류" }); }
    const timeoutMs = Math.min(Math.max(Number((job as any)?.timeoutMs) || DEFAULT_LIMITS.timeoutMs, 1000), DEFAULT_LIMITS.timeoutMs);
    waiting++;
    chain = chain.then(async () => {
      try { send(res, 200, await runIsolated(job, { ...DEFAULT_LIMITS, timeoutMs })); }
      catch (e) { send(res, e instanceof SandboxError ? 422 : 500, { error: (e as Error).message }); }
      finally { waiting--; }
    });
  });
}).listen(PORT, "0.0.0.0", () => console.log(`[runner] listening on ${PORT}`));
