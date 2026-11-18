import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiagToken } from "@/lib/settings/diag";
import { POST } from "@/app/api/diag/strategies/route";
import { loadStrategies, upsertStrategy } from "@/lib/strategies/library";
import { STRATEGIES } from "@/lib/strategies";

let dir: string;
const saved = process.env.ALPHY_CONFIG_DIR;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-diagst-")); process.env.ALPHY_CONFIG_DIR = dir; });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ALPHY_CONFIG_DIR; else process.env.ALPHY_CONFIG_DIR = saved;
});
const env = () => ({ ALPHY_CONFIG_DIR: dir });
const call = (token: string | null, body: unknown) => POST(new Request("http://x/api/diag/strategies", {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}));
const body = { name: "모멘텀 회전", builtin: "rotation", params: { topK: 3, minMom: 999 }, tickers: ["qld", "SSO", "122630"], backfill: true };

describe("점검 키로 내 전략 추가", () => {
  it("읽기 전용 키·키 없음은 막힘", async () => {
    expect((await call(null, body)).status).toBe(401);
    const { token } = createDiagToken("ro", 1, env());
    expect((await call(token, body)).status).toBe(403);
    expect(loadStrategies(env())).toHaveLength(0);
  });

  it("허용한 키는 기본 전략 코드 + 종목·파라미터로 저장 (범위 밖 값은 범위 안으로)", async () => {
    const { token } = createDiagToken("rw", 1, env(), Date.now(), true);
    const r = await call(token, body);
    expect(r.status).toBe(200);
    const [s] = loadStrategies(env());
    expect(s.name).toBe("모멘텀 회전");
    expect(s.code).toBe(STRATEGIES.find((x) => x.id === "rotation")!.code);
    expect(JSON.parse(s.params)).toEqual({ topK: 3, minMom: 20 });
    expect(s.universe).toMatchObject({ mode: "list", tickers: "QLD, SSO, 122630", backfill: { on: true } });
    expect(s.rebalance).toBe("M");
  });

  it("코드를 보내도 무시, 같은 이름은 overwrite 일 때만, 직접 쓴 코드는 덮어쓰지 않음", async () => {
    const { token } = createDiagToken("rw", 1, env(), Date.now(), true);
    await call(token, { ...body, code: "fetch('evil')" });
    expect(loadStrategies(env())[0].code).not.toContain("evil");
    expect((await call(token, body)).status).toBe(409);
    expect((await call(token, { ...body, params: { topK: 2 }, overwrite: true })).status).toBe(200);
    expect(JSON.parse(loadStrategies(env())[0].params).topK).toBe(2);
    upsertStrategy({ name: "내 코드", code: "return {};", params: "{}", rebalance: "M", warmup: 0 }, env());
    expect((await call(token, { ...body, name: "내 코드", overwrite: true })).status).toBe(409);
    expect(loadStrategies(env()).find((s) => s.name === "내 코드")!.code).toBe("return {};");
  });

  it("모르는 기본 전략·종목 없음은 400", async () => {
    const { token } = createDiagToken("rw", 1, env(), Date.now(), true);
    expect((await call(token, { ...body, builtin: "nope" })).status).toBe(400);
    expect((await call(token, { ...body, tickers: [] })).status).toBe(400);
  });
});
