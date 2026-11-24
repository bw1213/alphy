import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataRequest, DataResponse } from "@/lib/data/server";
import { runEvening } from "@/lib/auto/evening";
import { cleanPlan, loadPlan, savePlan, syncPlan, type AutoPlan } from "@/lib/auto/store";
import { cleanAccount, loadAccounts, saveAccounts } from "@/lib/manual/store";
import { upsertStrategy, type SavedStrategy } from "@/lib/strategies/library";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-sync-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const today = "2026-11-18";
const mix = (over: Partial<SavedStrategy> = {}): SavedStrategy => ({
  name: "내 비중", code: "return {};", params: JSON.stringify({ months: 3, w_AAPL: 70, w_MSFT: 30 }), rebalance: "D", stopLoss: "", takeProfit: "", warmup: 2,
  universe: { mode: "list", size: 100, pit: false, tickers: "AAPL, MSFT" }, intraday: false, ...over,
});

describe("내 전략을 매매에 그대로", () => {
  it("운용을 정할 때 종목·장중 매도는 내 전략 것을 씀 (화면에서 넣은 값은 무시)", () => {
    const p = cleanPlan({ strategy: "saved:내 비중", tickers: "QQQ", budget: 1_000_000, intraday: true }, "owner", today, [mix()]);
    expect(p.tickers).toEqual(["AAPL", "MSFT"]);
    expect(p.intraday).toBe(false);
  });
  it("종목 정보가 없는 예전 전략은 화면에서 넣은 종목", () => {
    const p = cleanPlan({ strategy: "saved:내 비중", tickers: "QQQ", budget: 1_000_000 }, "owner", today, [mix({ universe: undefined, intraday: undefined })]);
    expect(p.tickers).toEqual(["QQQ"]);
    expect(p.intraday).toBe(true);
  });
  it("백테스트에서 다시 저장하면 자동 매매가 새 내용을 따라가고, 실전 확인은 다시 받음", () => {
    upsertStrategy(mix(), env);
    const plan = { ...cleanPlan({ strategy: "saved:내 비중", budget: 1_000_000 }, "owner", today, [mix()]), realConfirmedAt: "2026-11-18T00:00:00Z" };
    savePlan(plan, "owner", env);
    expect(loadPlan("owner", env)?.realConfirmedAt).toBe("2026-11-18T00:00:00Z"); // 바뀐 것 없으면 그대로
    upsertStrategy(mix({ params: JSON.stringify({ months: 3, w_AAPL: 50, w_MSFT: 30, w_GOOG: 20 }), universe: { mode: "list", size: 100, pit: false, tickers: "AAPL, MSFT, GOOG" } }), env);
    const next = loadPlan("owner", env)!;
    expect(next.tickers).toEqual(["AAPL", "MSFT", "GOOG"]);
    expect(JSON.parse(next.strategy!.params).w_GOOG).toBe(20);
    expect(next.realConfirmedAt).toBeUndefined();
  });
  it("보관함에서 지운 전략은 복사본 그대로", () => {
    const plan = cleanPlan({ strategy: "saved:내 비중", budget: 1_000_000 }, "owner", today, [mix()]);
    expect(syncPlan(plan, [], "owner")).toBe(plan);
  });
  it("다른 사람이 조건 고르기 전략을 같은 이름의 코드 전략으로 바꿔도 서버에서 그 코드를 실행하지 않음", async () => {
    const built = mix({ builder: { marketMa: 0, filters: [], rank: { metric: "ret", n: 60, m: 0, dir: "desc" }, topK: 1 } });
    const plan = cleanPlan({ strategy: "saved:내 비중", budget: 1_000_000 }, "mom", today, [built]);
    const evil = mix({ code: "globalThis.__ran = true; return {};" });
    expect(syncPlan(plan, [evil], "mom")).toBe(plan);
    expect(syncPlan(plan, [evil], "owner").strategy?.code).toBe(evil.code);
    const forced: AutoPlan = { ...plan, strategy: evil };
    const r = await runEvening(forced, "manual", { load: async () => { throw new Error("stop"); }, env, user: "mom" });
    expect(r.error).toMatch(/관리자만/);
    expect((globalThis as any).__ran).toBeUndefined();
  });
  it("수동 계좌도 따라감", () => {
    upsertStrategy(mix(), env);
    const a = cleanAccount({ name: "토스", cash: 1_000_000, plan: { strategy: "saved:내 비중", budget: 1_000_000 } }, null, "owner", today, [mix()]);
    saveAccounts([a], "owner", env);
    upsertStrategy(mix({ universe: { mode: "list", size: 100, pit: false, tickers: "AAPL, 005930" } }), env);
    expect(loadAccounts("owner", env)[0].plan?.tickers).toEqual(["AAPL", "005930"]);
  });
  it("저녁 계산은 내 전략의 상장 전 채우기·상위 N 설정으로 시세를 받음", async () => {
    const reqs: DataRequest[] = [];
    const load = async (q: DataRequest): Promise<DataResponse> => { reqs.push(q); throw new Error("stop"); };
    const plan: AutoPlan = { ...cleanPlan({ strategy: "saved:내 비중", budget: 1_000_000 }, "owner", today,
      [mix({ universe: { mode: "list", size: 100, pit: false, tickers: "AAPL, MSFT", backfill: { on: true, picks: {} } } })]) };
    await runEvening(plan, "manual", { load, env, user: "owner" });
    expect(reqs[0].backfill).toEqual({ AAPL: "auto", MSFT: "auto" });
    const top: AutoPlan = { ...cleanPlan({ strategy: "saved:상위", budget: 1_000_000 }, "owner", today,
      [mix({ name: "상위", universe: { mode: "top", size: 30, pit: false, tickers: "" } })]) };
    await runEvening(top, "manual", { load, env, user: "owner" });
    expect(reqs[1].tickers).toBeUndefined();
    expect(reqs[1].universeSize).toBe(30);
  });
});
