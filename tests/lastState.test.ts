import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanLastState, clearLastState, loadLastState, saveLastState } from "@/lib/strategies/lastState";
import { defaultCycleSpec } from "@/lib/strategies/cycle";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample = {
  sid: "saved:내 적립", mode: "cycle", params: { momentum: { lookback: 120 } }, code: "return {}", customParams: "{}",
  customName: "내 적립", customWarmup: 30, cycleSpec: defaultCycleSpec(), rebalance: "D", stopLoss: "", takeProfit: "",
  source: "naver", start: "2020-01-01", end: "", universeMode: "list", universeSize: 100, pit: false, tickers: "069500",
  cash: 500_000, monthly: 0, commission: "0.015", slippage: "0.1", sellTax: "",
};

describe("마지막 설정", () => {
  it("없으면 null, 저장하면 그대로 다시 읽힘(권한 600)", () => {
    expect(loadLastState(env)).toBeNull();
    saveLastState(sample, env);
    const s = loadLastState(env)!;
    expect(s.sid).toBe("saved:내 적립");
    expect(s.mode).toBe("cycle");
    expect(s.tickers).toBe("069500");
    expect(s.cash).toBe(500_000);
    expect(s.params.momentum.lookback).toBe(120);
    expect(s.cycleSpec).toBeDefined();
    expect(s.savedAt).toBeTruthy();
    expect(statSync(path.join(dir, "last-state.json")).mode & 0o777).toBe(0o600);
    clearLastState(env);
    expect(loadLastState(env)).toBeNull();
  });
  it("이상한 값은 안전한 값으로 바꿈", () => {
    const s = cleanLastState({ ...sample, mode: "evil", source: "x", start: "어제", universeSize: 9999, rebalance: "Y", cash: "abc" });
    expect(s.mode).toBe("builder");
    expect(s.source).toBe("naver");
    expect(s.start).toBe("2018-01-01");
    expect(s.universeSize).toBe(300);
    expect(s.rebalance).toBe("M");
    expect(s.cash).toBe(10_000_000);
    expect(() => cleanLastState([1])).toThrow();
  });
});
