import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualReport } from "@/lib/diag/manual";
import { saveBuiltinStrategy } from "@/lib/diag/strategies";
import { cleanAccount, saveAccounts } from "@/lib/manual/store";
import { loadStrategies } from "@/lib/strategies/library";

let dir: string;
let env: Record<string, string>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-diagman-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("manualReport", () => {
  it("계좌별 전략·기본 전략 id·종목을 보여 줌", () => {
    saveBuiltinStrategy({ name: "회전", builtin: "rotation", params: { topK: 2 }, tickers: ["SPY", "TLT"] }, env);
    const lib = loadStrategies(env);
    const a = cleanAccount({ name: "토스", broker: "토스증권", cash: 1000, positions: [], plan: { strategy: "saved:회전", tickers: "", budget: 1_000_000, startDate: "2026-01-02" } }, null, "owner", "2026-01-02", lib);
    saveAccounts([a], "owner", env);
    const r = manualReport(env);
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0].plan?.builtin).toBe("rotation");
    expect(r.accounts[0].plan?.strategy?.params).toMatchObject({ topK: 2 });
    expect(r.accounts[0].plan?.tickers).toEqual(["SPY", "TLT"]);
    expect(r.accounts[0].evenings).toEqual([]);
  });
});
