import { describe, expect, it } from "vitest";
import { createJobStore } from "@/lib/server/jobs";
import { fetchData, readJson } from "@/lib/client/fetchData";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("작업 목록 (긴 시세 받기)", () => {
  it("끝나면 결과, 진행 상황을 보여 줌", async () => {
    const s = createJobStore<number>();
    let finish!: (v: number) => void;
    const j = s.start("u1", "k", (p) => { p(1, 4); return new Promise<number>((r) => { finish = r; }); });
    expect(j.state).toBe("running");
    await tick();
    expect(s.get("u1", j.id)?.progress).toEqual({ done: 1, total: 4 });
    const w = s.wait("u1", j.id, 5000);
    finish(42);
    expect((await w)?.result).toBe(42);
    expect(s.get("u1", j.id)?.state).toBe("done");
  });

  it("같은 사람이 같은 요청을 다시 보내면 돌던 작업을 그대로 씀, 다른 사람은 못 봄", async () => {
    const s = createJobStore<number>();
    let runs = 0;
    const fn = () => { runs++; return new Promise<number>(() => {}); };
    const a = s.start("u1", "k", fn);
    const b = s.start("u1", "k", fn);
    const c = s.start("u2", "k", fn);
    await tick();
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(runs).toBe(2);
    expect(s.get("u2", a.id)).toBeNull();
  });

  it("오류는 상태 코드와 함께, 기다리는 시간이 지나면 진행 중으로 답함", async () => {
    const s = createJobStore<number>();
    const e = s.start("u1", "x", async () => { throw new Error("바쁨"); }, () => 429);
    const v = await s.wait("u1", e.id, 1000);
    expect(v).toMatchObject({ state: "error", error: "바쁨", status: 429 });
    const r = s.start("u1", "y", () => new Promise<number>(() => {}));
    expect((await s.wait("u1", r.id, 10))?.state).toBe("running");
  });

  it("끝난 작업은 시간이 지나면 지워짐", async () => {
    let t = 0;
    const s = createJobStore<number>(() => t, 1000);
    const j = s.start("u1", "k", async () => 1);
    await s.wait("u1", j.id, 100);
    t = 5000;
    expect(s.get("u1", j.id)).toBeNull();
  });
});

const res = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("화면의 시세 받기", () => {
  it("프록시 HTML 오류 페이지면 'not valid JSON' 대신 알아볼 수 있는 말", async () => {
    await expect(readJson(res("<html><head><title>504 Gateway Time-out</title></head></html>", 504))).rejects.toThrow(/프록시/);
    await expect(readJson(res("<html>oops</html>", 500))).rejects.toThrow(/HTTP 500: oops/);
  });

  it("202 면 작업이 끝날 때까지 이어서 물어보고 진행 상황을 알려 줌", async () => {
    const calls: string[] = [];
    const replies = [
      res({ job: "J", progress: { done: 0, total: 3 } }, 202),
      res("<html>504</html>", 504), // 중간에 프록시가 한 번 끊겨도 계속
      res({ job: "J", progress: { done: 2, total: 3 } }, 202),
      res({ data: {}, names: {}, benchmark: null, warnings: ["ok"] }),
    ];
    const seen: number[] = [];
    const d = await fetchData({}, (p) => seen.push(p.done), async (u) => { calls.push(u); return replies.shift()!; }, 10, 0);
    expect(d.warnings).toEqual(["ok"]);
    expect(seen).toEqual([0, 0, 2]);
    expect(calls).toEqual(["/api/data", "/api/data?job=J", "/api/data?job=J", "/api/data?job=J"]);
  });

  it("작업이 오류로 끝나면 서버 메시지를 그대로", async () => {
    const replies = [res({ job: "J" }, 202), res({ error: "한국투자증권 앱키가 없습니다" }, 500)];
    await expect(fetchData({}, undefined, async () => replies.shift()!)).rejects.toThrow("한국투자증권 앱키가 없습니다");
  });
});

describe("오래 걸리는 API 공통 도우미 (프록시 60초 제한)", () => {
  it("기다리는 시간 안에 끝나면 결과, 아니면 202 + 작업 id 뒤 이어 묻기", async () => {
    const { namedJobs, startJob, pollJob } = await import("@/lib/server/jobReply");
    const store = namedJobs<{ v: number }>("test-" + Math.random());
    const fast = await startJob(store, "u", "a", async () => ({ v: 1 }), { waitMs: 200 });
    expect(fast.status).toBe(200);
    expect(await fast.json()).toEqual({ v: 1 });

    let finish!: () => void;
    const slow = await startJob(store, "u", "b", (p) => { p(1, 3); return new Promise((ok) => { finish = () => ok({ v: 2 }); }); }, { waitMs: 10 });
    expect(slow.status).toBe(202);
    const { job, progress } = await slow.json();
    expect(progress).toEqual({ done: 1, total: 3 });
    expect((await pollJob(store, "u", job, 10)).status).toBe(202);
    expect((await pollJob(store, "other", job, 10)).status).toBe(404);
    finish();
    const done = await pollJob(store, "u", job, 200);
    expect(await done.json()).toEqual({ v: 2 });
    expect((await pollJob(store, "u", job, 10)).status).toBe(404);
  });

  it("오류는 정한 상태 코드로", async () => {
    const { namedJobs, startJob } = await import("@/lib/server/jobReply");
    const r = await startJob(namedJobs("test-" + Math.random()), "u", "a", async () => { throw new Error("안 됨"); }, { errStatus: () => 400, waitMs: 200 });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "안 됨" });
  });

  it("fetchJob: 주소에 ?job= 을 붙여 끝날 때까지 물어봄", async () => {
    const { fetchJob } = await import("@/lib/client/fetchData");
    const calls: string[] = [];
    const replies = [new Response(JSON.stringify({ job: "j1" }), { status: 202 }), new Response(JSON.stringify({ job: "j1" }), { status: 202 }), new Response(JSON.stringify({ ok: true }), { status: 200 })];
    const r = await fetchJob("/api/x?env=real", { method: "POST" }, undefined, async (u) => { calls.push(u); return replies.shift()!; }, 10, 0);
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual(["/api/x?env=real", "/api/x?env=real&job=j1", "/api/x?env=real&job=j1"]);
  });
});
