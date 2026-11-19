import { describe, expect, it } from "vitest";
import { periodReturn, relative, rollingReturn, weakPeriods } from "@/lib/engine/weak";

const day = (k: number) => new Date(Date.UTC(2020, 0, 1) + k * 864e5).toISOString().slice(0, 10);

describe("weakPeriods", () => {
  const dates = Array.from({ length: 10 }, (_, k) => day(k));
  //              0    1   2   3    4    5    6   7   8   9
  const values = [100, 90, 80, 100, 110, 104, 99, 95, 97, 100];
  it("고점 → 바닥 → 회복을 깊은 순으로", () => {
    const w = weakPeriods(dates, values);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ peak: day(0), trough: day(2), recovered: day(3), i0: 0, iTrough: 2, i1: 3, days: 3 });
    expect(w[0].depth).toBeCloseTo(-0.2);
    // 끝까지 회복 못 한 구간
    expect(w[1]).toMatchObject({ peak: day(4), trough: day(7), recovered: null, i1: 9, days: 5 });
    expect(w[1].depth).toBeCloseTo(95 / 110 - 1);
  });
  it("얕은 구간은 빼고 개수 제한", () => {
    expect(weakPeriods(dates, values, 1)).toHaveLength(1);
    expect(weakPeriods(dates, values, 5, 0.15)).toHaveLength(1);
    expect(weakPeriods(dates, [1, 2, 3], 5)).toEqual([]);
  });
});

describe("rollingReturn", () => {
  it("1년 전 값 대비, 1년 안 된 앞부분은 null", () => {
    const dates = Array.from({ length: 800 }, (_, k) => day(k));
    const values = dates.map((_, k) => 100 * 1.001 ** k);
    const r = rollingReturn(dates, values);
    expect(r[364]).toBeNull();
    expect(r[365]).toBeCloseTo(1.001 ** 365 - 1);
    expect(r[799]).toBeCloseTo(1.001 ** 365 - 1);
  });
  it("날짜가 듬성듬성하면 1년 전 직전 날 값", () => {
    const dates = ["2020-01-01", "2020-06-01", "2021-01-05", "2021-06-02"];
    const r = rollingReturn(dates, [100, 110, 120, 99]);
    expect(r.slice(0, 2)).toEqual([null, null]);
    expect(r[2]).toBeCloseTo(0.2);
    expect(r[3]).toBeCloseTo(99 / 110 - 1);
  });
  it("앞쪽 null 값은 건너뜀", () => {
    const dates = ["2020-01-01", "2020-06-01", "2021-01-05", "2021-06-02"];
    const r = rollingReturn(dates, [null, 100, 120, 130]);
    expect(r.slice(0, 3)).toEqual([null, null, null]);
    expect(r[3]).toBeCloseTo(0.3);
  });
});

describe("relative / periodReturn", () => {
  it("둘 다 값 있는 첫날 = 100", () => {
    expect(relative([100, 110, 121], [null, 100, 110])).toEqual([null, 100, 100]);
    expect(relative([100, 90], [100, 100])).toEqual([100, 90]);
  });
  it("기간 수익률", () => {
    expect(periodReturn([100, null, 80], 0, 2)).toBeCloseTo(-0.2);
    expect(periodReturn([null, 1], 0, 1)).toBeNull();
  });
});
