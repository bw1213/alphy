import { describe, expect, it } from "vitest";
import { BusyError, createGate, rateLimited, resetRateLimits } from "@/lib/server/limiter";

const defer = () => { let done!: () => void; const p = new Promise<void>((r) => { done = r; }); return { p, done }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("동시 실행 제한", () => {
  it("정해진 수만 동시에 돌고 나머지는 순서대로 기다림", async () => {
    const g = createGate(2, 5, 1000);
    const d = [defer(), defer(), defer()];
    const order: number[] = [];
    const runs = d.map((x, i) => g.run(async () => { order.push(i); await x.p; return i; }));
    await tick();
    expect(order).toEqual([0, 1]);
    expect(g.stats()).toMatchObject({ active: 2, queued: 1 });
    d[0].done(); await tick(); await tick();
    expect(order).toEqual([0, 1, 2]);
    d[1].done(); d[2].done();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(g.stats()).toMatchObject({ active: 0, queued: 0 });
  });
  it("줄이 꽉 차면 바로 거절, 오래 기다리면 멈춤, 실패해도 자리는 비워짐", async () => {
    const g = createGate(1, 1, 30);
    const a = defer();
    const first = g.run(() => a.p);
    const second = g.run(async () => "late");
    await expect(g.run(async () => 1)).rejects.toBeInstanceOf(BusyError);
    await expect(second).rejects.toThrow(/기다리다/);
    expect(g.stats().queued).toBe(0);
    a.done(); await first;
    await expect(g.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await g.run(async () => "ok")).toBe("ok");
  });
});

describe("사람별 요청 제한", () => {
  it("정해진 횟수를 넘으면 막히고, 시간이 지나면 풀리며, 다른 사람은 영향 없음", () => {
    resetRateLimits();
    for (let k = 0; k < 3; k++) expect(rateLimited("mom", 1000 + k, 3, 60_000)).toBe(0);
    expect(rateLimited("mom", 2000, 3, 60_000)).toBeGreaterThan(0);
    expect(rateLimited("dad", 2000, 3, 60_000)).toBe(0);
    expect(rateLimited("mom", 62_000, 3, 60_000)).toBe(0);
  });
});
