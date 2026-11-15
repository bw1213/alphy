import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_ID, userDir, userFile, validUserId } from "@/lib/settings/userdir";
import { loadStrategies, upsertStrategy } from "@/lib/strategies/library";
import { loadLastState, saveLastState } from "@/lib/strategies/lastState";
import { addUsage, usedToday } from "@/lib/kis/limits";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "alphy-users-")); env = { ALPHY_CONFIG_DIR: dir }; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const strat = (name: string) => ({ name, code: "return {}", params: "{}", rebalance: "M" });

describe("사용자별 저장 폴더", () => {
  it("사용자 이름은 영문 소문자·숫자·-_ 만", () => {
    expect(validUserId("owner")).toBe(true);
    expect(validUserId("mom-2")).toBe(true);
    expect(validUserId("../x")).toBe(false);
    expect(validUserId("")).toBe(false);
    expect(validUserId("Owner")).toBe(false);
    expect(() => userDir("../etc", env)).toThrow();
  });

  it("예전 위치 파일은 관리자 폴더로 옮기고 원본은 .moved 로 남김", () => {
    writeFileSync(path.join(dir, "strategies.json"), JSON.stringify([strat("예전 전략")]));
    writeFileSync(path.join(dir, "last-state.json"), JSON.stringify({ tickers: "069500" }));
    expect(loadStrategies(env).map((s) => s.name)).toEqual(["예전 전략"]);
    expect(loadLastState(env)?.tickers).toBe("069500");
    expect(existsSync(path.join(dir, "strategies.json"))).toBe(false);
    expect(existsSync(path.join(dir, "strategies.json.moved"))).toBe(true);
    const moved = path.join(dir, "users", OWNER_ID, "strategies.json");
    expect(statSync(moved).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(moved, "utf8"))[0].name).toBe("예전 전략");
  });

  it("새 파일이 이미 있으면 예전 파일로 덮어쓰지 않음", () => {
    upsertStrategy(strat("새 전략"), env);
    writeFileSync(path.join(dir, "strategies.json"), JSON.stringify([strat("예전 전략")]));
    expect(loadStrategies(env).map((s) => s.name)).toEqual(["새 전략"]);
    expect(existsSync(path.join(dir, "strategies.json"))).toBe(true);
  });

  it("사용자끼리 전략·마지막 설정·주문 사용량이 섞이지 않음", () => {
    const now = new Date();
    upsertStrategy(strat("내 것"), env, now, OWNER_ID);
    upsertStrategy(strat("엄마 것"), env, now, "mom");
    expect(loadStrategies(env, OWNER_ID).map((s) => s.name)).toEqual(["내 것"]);
    expect(loadStrategies(env, "mom").map((s) => s.name)).toEqual(["엄마 것"]);

    saveLastState({ tickers: "005930" }, env, now, "mom");
    expect(loadLastState(env, OWNER_ID)).toBeNull();
    expect(loadLastState(env, "mom")?.tickers).toBe("005930");

    addUsage(300_000, env, Date.now(), "mom");
    expect(usedToday(env, Date.now(), "mom")).toBe(300_000);
    expect(usedToday(env, Date.now(), OWNER_ID)).toBe(0);
  });

  it("다른 사용자는 예전 위치 파일을 가져가지 않음", () => {
    writeFileSync(path.join(dir, "order-usage.json"), JSON.stringify({ date: "2026-01-01", amount: 1 }));
    userFile("order-usage.json", "mom", env);
    expect(existsSync(path.join(dir, "order-usage.json"))).toBe(true);
  });
});
