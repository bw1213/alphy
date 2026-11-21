import { describe, expect, it, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { detectLateOpen, fetchKrDays, krTradingStarted, prevTradingDay, refreshKrCalendar, resetCalendarRetry, resetProbe, tradingDay, upcomingClosed } from "@/lib/market/holidays";
import { sessionOn } from "@/lib/auto/calendar";
import { krSession, US_SESSION } from "@/lib/auto/session";
import { pickReport } from "@/lib/auto/morning";
import { updateSettings } from "@/lib/settings/store";

let env: Record<string, string>;
beforeEach(() => { env = { ALPHY_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "alphy-cal-")) }; resetCalendarRetry(); resetProbe(); });

const closed = (m: "KR" | "US", year: number) => {
  const out: string[] = [];
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d = new Date(d.getTime() + 864e5)) {
    const t = tradingDay(m, d.toISOString().slice(0, 10), env);
    if (!t.open && t.source !== "weekend") out.push(t.date);
  }
  return out;
};

describe("미국 휴장일 (NYSE 규칙)", () => {
  it("2026년 휴장일", () => {
    expect(closed("US", 2026)).toEqual(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]);
  });
  it("토요일 설날은 앞 금요일에 쉬지 않음, 크리스마스는 대신 쉼", () => {
    expect(tradingDay("US", "2027-12-31", env).open).toBe(true);
    expect(tradingDay("US", "2027-12-24", env).open).toBe(false);
    expect(tradingDay("US", "2025-04-18", env).name).toBe("Good Friday");
  });
  it("조기 마감", () => {
    expect(tradingDay("US", "2026-11-27", env).closeAt).toBe("13:00");
    expect(tradingDay("US", "2026-12-24", env).closeAt).toBe("13:00");
    expect(tradingDay("US", "2026-07-02", env).closeAt).toBeUndefined();
    const s = sessionOn(US_SESSION, "2026-11-27", env);
    expect([s.watchUntil, s.close, s.cutoff]).toEqual(["12:50", "13:00", "10:30"]);
  });
});

describe("한국 휴장일", () => {
  it("규칙표: 2026년 (대체휴일 포함)", () => {
    expect(closed("KR", 2026)).toEqual([
      "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-02", "2026-05-01", "2026-05-05", "2026-05-25",
      "2026-06-03", "2026-08-17", "2026-09-24", "2026-09-25", "2026-10-05", "2026-10-09", "2026-12-25", "2026-12-31",
    ]);
  });
  it("증권사 조회 결과가 규칙표보다 우선, 직접 넣은 휴장일도 반영", () => {
    fs.writeFileSync(path.join(env.ALPHY_CONFIG_DIR, "market-calendar.json"), JSON.stringify({ kr: { "2026-12-25": true, "2026-12-30": false } }));
    expect(tradingDay("KR", "2026-12-25", env)).toMatchObject({ open: true, source: "kis" });
    expect(tradingDay("KR", "2026-12-30", env)).toMatchObject({ open: false, source: "kis" });
    updateSettings((s) => { s.auto.extraClosed = { KR: ["2026-12-29"], US: [] }; }, env);
    expect(tradingDay("KR", "2026-12-29", env)).toMatchObject({ open: false, source: "manual" });
    expect(upcomingClosed("KR", "2026-12-28", 4, env).map((d) => d.date)).toEqual(["2026-12-29", "2026-12-30", "2026-12-31"]);
  });
  it("새해 첫 거래일은 10시 개장 → 체결 확인·취소 시각을 늦춤", () => {
    expect(tradingDay("KR", "2027-01-04", env).openAt).toBe("10:00");
    expect(tradingDay("KR", "2027-01-05", env).openAt).toBeUndefined();
    const s = sessionOn(krSession({ morning: "08:40", cutoff: "10:00" }), "2027-01-04", env);
    expect([s.orderAt, s.followFrom, s.buyFrom, s.buyBy, s.cutoff, s.watchFrom]).toEqual(["08:40", "10:00", "10:01", "10:10", "11:00", "10:00"]);
  });
  it("앞 거래일", () => {
    expect(prevTradingDay("KR", "2026-09-28", 1, env)).toBe("2026-09-23");
    expect(prevTradingDay("US", "2026-11-27", 1, env)).toBe("2026-11-25");
  });
});

describe("증권사 휴장일 조회", () => {
  const fake = (pages: { rows: [string, string][]; cont: string }[]) => {
    const calls: Record<string, string>[] = [];
    let i = 0;
    const client: any = {
      env: "real",
      call: async (o: any) => {
        calls.push({ ...o.query, trCont: o.trCont });
        const p = pages[i++];
        return { body: { output: p.rows.map(([d, y]) => ({ bass_dt: d, opnd_yn: y })), ctx_area_nk: "NK", ctx_area_fk: "FK" }, trCont: p.cont };
      },
    };
    return { client, calls };
  };
  it("다음 쪽까지 이어 받음", async () => {
    const { client, calls } = fake([{ rows: [["20261224", "Y"], ["20261225", "N"]], cont: "M" }, { rows: [["20261228", "Y"]], cont: "D" }]);
    expect(await fetchKrDays(client, "2026-12-24")).toEqual({ "2026-12-24": true, "2026-12-25": false, "2026-12-28": true });
    expect(calls[1]).toMatchObject({ BASS_DT: "20261224", CTX_AREA_NK: "NK", trCont: "N" });
  });
  it("하루 한 번만 받고, 실패하면 규칙표로", async () => {
    const now = Date.parse("2026-11-21T00:00:00Z");
    const { client, calls } = fake([{ rows: [["20261121", "N"], ["20261123", "Y"]], cont: "D" }]);
    const c = await refreshKrCalendar(env, { now, client });
    expect(c.kr?.["2026-11-23"]).toBe(true);
    await refreshKrCalendar(env, { now: now + 3600_000, client });
    expect(calls.length).toBe(1);
    const bad: any = { env: "real", call: async () => { throw new Error("네트워크"); } };
    const r = await refreshKrCalendar(env, { now: now + 864e5, client: bad, force: true });
    expect(r.krError).toMatch(/네트워크/);
    expect(r.kr?.["2026-11-23"]).toBe(true);
    expect(tradingDay("KR", "2026-12-25", env)).toMatchObject({ open: false, source: "rule" });
  });
});

describe("긴 연휴 뒤 아침 주문", () => {
  it("추석 연휴 앞 마지막 계산을 따름", () => {
    const plan: any = { label: "L", enabled: true };
    const r: any = { status: "ok", label: "L", runDate: "2026-09-23", ranAt: "2026-09-23T09:00:00Z", orders: [] };
    expect(pickReport([r], plan, "2026-09-28").report?.runDate).toBe("2026-09-23");
    expect(pickReport([{ ...r, runDate: "2026-09-18" }], plan, "2026-09-28").report).toBeNull();
  });
});

describe("늦은 개장 (수능일 등)", () => {
  const quote = (vol: number) => { const calls: string[] = []; return { calls, client: { env: "real", call: async (o: any) => { calls.push(o.trId); return { body: { output: { stck_prpr: "1000", acml_vol: String(vol) } }, trCont: "" }; } } as any }; };
  const at = (hm: string) => Date.parse(`2026-11-19T${hm}:00+09:00`);

  it("09:01 에 거래가 없으면 그날은 10:00 개장·16:30 마감", async () => {
    const q = quote(0);
    expect(await detectLateOpen(env, { now: at("09:00"), client: q.client })).toBeNull();
    expect(await detectLateOpen(env, { now: at("09:01"), client: q.client })).toBe(true);
    expect(await detectLateOpen(env, { now: at("09:02"), client: q.client })).toBeNull();
    expect(q.calls.length).toBe(1);
    expect(tradingDay("KR", "2026-11-19", env)).toMatchObject({ open: true, openAt: "10:00", closeAt: "16:30" });
    const s = sessionOn(krSession({ morning: "08:40", cutoff: "10:00" }), "2026-11-19", env);
    expect([s.followFrom, s.buyBy, s.cutoff, s.watchFrom, s.watchUntil, s.close]).toEqual(["10:00", "10:10", "11:00", "10:00", "16:20", "16:30"]);
  });
  it("거래가 있으면 평소대로", async () => {
    expect(await detectLateOpen(env, { now: at("09:01"), client: quote(1200).client })).toBe(false);
    expect(tradingDay("KR", "2026-11-19", env).openAt).toBeUndefined();
  });
  it("직접 넣은 늦은 개장일, 휴장일 다시 받아도 유지", async () => {
    updateSettings((s) => { s.auto.lateOpen = ["2027-11-18"]; }, env);
    expect(tradingDay("KR", "2027-11-18", env)).toMatchObject({ openAt: "10:00", source: "manual" });
    await detectLateOpen(env, { now: at("09:01"), client: quote(0).client });
    const fake: any = { env: "real", call: async () => ({ body: { output: [{ bass_dt: "20261119", opnd_yn: "Y" }] }, trCont: "" }) };
    await refreshKrCalendar(env, { now: at("09:05"), client: fake, force: true });
    expect(tradingDay("KR", "2026-11-19", env).openAt).toBe("10:00");
  });
  it("거래 시작 여부는 1분 기억", async () => {
    const q = quote(0);
    expect(await krTradingStarted(env, { now: at("10:00"), client: q.client })).toBe(false);
    expect(await krTradingStarted(env, { now: at("10:00") + 30_000, client: q.client })).toBe(false);
    expect(q.calls.length).toBe(1);
    expect(await krTradingStarted(env, { now: at("10:01") + 1000, client: quote(5).client })).toBe(true);
  });
});
