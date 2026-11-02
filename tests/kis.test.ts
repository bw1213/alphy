import { describe, expect, it } from "vitest";
import { credentialsFor, parseAccount, quoteCredentials, tradeCredentials, kisStatus } from "@/lib/kis/config";
import { KisClient } from "@/lib/kis/client";
import { kisDaily, parseIndexDaily, parseStockDaily, prevDay } from "@/lib/kis/market";
import { getBalance, orderBody, orderTrId, placeOrder, validateOrder } from "@/lib/kis/trading";

const mockEnv = { KIS_MOCK_APP_KEY: "mk", KIS_MOCK_APP_SECRET: "ms", KIS_MOCK_ACCOUNT: "50012345-01" };
const noSleep = async () => {};

/** 호출 기록 + 응답 큐를 가진 가짜 fetch */
function fakeFetch(handler: (url: URL, init: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (u: string, init: RequestInit) => {
    const url = new URL(u);
    calls.push({ url, init });
    if (url.pathname === "/oauth2/tokenP") return new Response(JSON.stringify({ access_token: "TOK", expires_in: 86400 }), { status: 200 });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const client = (f: typeof fetch) =>
  new KisClient(credentialsFor("mock", mockEnv)!, { fetch: f, cacheDir: null, sleep: noSleep, minIntervalMs: 0 });

describe("kis config", () => {
  it("계좌번호 파싱", () => {
    expect(parseAccount("50012345-01")).toEqual({ cano: "50012345", acntPrdtCd: "01" });
    expect(parseAccount("5001234522")).toEqual({ cano: "50012345", acntPrdtCd: "22" });
    expect(parseAccount("50012345")).toEqual({ cano: "50012345", acntPrdtCd: "01" });
    expect(parseAccount("123")).toBeNull();
  });
  it("시세는 실전 키 우선, 없으면 모의", () => {
    expect(quoteCredentials(mockEnv)?.env).toBe("mock");
    expect(quoteCredentials({ ...mockEnv, KIS_REAL_APP_KEY: "rk", KIS_REAL_APP_SECRET: "rs" })?.env).toBe("real");
    expect(quoteCredentials({})).toBeNull();
  });
  it("주문은 기본 모의, 실전은 잠금 해제가 있어야 함", () => {
    expect(tradeCredentials(mockEnv).env).toBe("mock");
    const realEnv = { ...mockEnv, KIS_REAL_APP_KEY: "rk", KIS_REAL_APP_SECRET: "rs", KIS_REAL_ACCOUNT: "12345678-01", KIS_TRADE_ENV: "real" };
    expect(() => tradeCredentials(realEnv)).toThrow(/KIS_ALLOW_REAL_ORDERS/);
    expect(tradeCredentials({ ...realEnv, KIS_ALLOW_REAL_ORDERS: "yes" }).env).toBe("real");
    expect(() => tradeCredentials({ KIS_MOCK_APP_KEY: "a", KIS_MOCK_APP_SECRET: "b" })).toThrow(/계좌번호/);
  });
  it("상태에는 키 값이 들어가지 않음", () => {
    expect(JSON.stringify(kisStatus(mockEnv))).not.toMatch(/mk|ms|50012345/);
  });
});

describe("kis market", () => {
  it("일봉 파싱: 빈 행 제거, 오름차순", () => {
    const bars = parseStockDaily([
      { stck_bsop_date: "20240103", stck_oprc: "100", stck_hgpr: "110", stck_lwpr: "90", stck_clpr: "105", acml_vol: "1000" },
      { stck_bsop_date: "20240102", stck_oprc: "99", stck_hgpr: "101", stck_lwpr: "98", stck_clpr: "100", acml_vol: "500" },
      {},
    ]);
    expect(bars.map((b) => b.date)).toEqual(["2024-01-02", "2024-01-03"]);
    expect(bars[1]).toMatchObject({ open: 100, high: 110, low: 90, close: 105, volume: 1000 });
    const idx = parseIndexDaily([{ stck_bsop_date: "20240102", bstp_nmix_prpr: "2669.81", bstp_nmix_oprc: "2650", bstp_nmix_hgpr: "2670", bstp_nmix_lwpr: "2640", acml_vol: "1" }]);
    expect(idx[0].close).toBeCloseTo(2669.81);
  });
  it("prevDay 는 월·연 경계를 넘김", () => {
    expect(prevDay("20240301")).toBe("20240229");
    expect(prevDay("20240101")).toBe("20231231");
  });
  it("100건씩 과거로 반복 조회해 합침", async () => {
    // 2024-01-01 ~ 2024-12-31 매일 데이터가 있다고 가정, 한 번에 최근 100건만 반환
    const all: string[] = [];
    for (let t = Date.UTC(2024, 0, 1); t <= Date.UTC(2024, 11, 31); t += 864e5) all.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, ""));
    const { f, calls } = fakeFetch((url) => {
      const from = url.searchParams.get("FID_INPUT_DATE_1")!, to = url.searchParams.get("FID_INPUT_DATE_2")!;
      const rows = all.filter((d) => d >= from && d <= to).slice(-100).reverse()
        .map((d) => ({ stck_bsop_date: d, stck_oprc: "1", stck_hgpr: "1", stck_lwpr: "1", stck_clpr: "1", acml_vol: "1" }));
      return { body: { rt_cd: "0", output2: rows } };
    });
    const bars = await kisDaily(client(f), "005930", "2024-02-01", "2024-12-31");
    expect(bars[0].date).toBe("2024-02-01");
    expect(bars.at(-1)!.date).toBe("2024-12-31");
    expect(bars.length).toBe(all.filter((d) => d >= "20240201").length);
    const dataCalls = calls.filter((c) => c.url.pathname.includes("itemchartprice"));
    expect(dataCalls.length).toBe(4);
    const h = dataCalls[0].init.headers as Record<string, string>;
    expect(h.tr_id).toBe("FHKST03010100");
    expect(h.authorization).toBe("Bearer TOK");
    expect(dataCalls[0].url.searchParams.get("FID_ORG_ADJ_PRC")).toBe("0");
  });
  it("초당 한도 초과는 재시도, 그 외 오류는 메시지와 함께 실패", async () => {
    let n = 0;
    const { f } = fakeFetch(() => (++n === 1
      ? { status: 500, body: { rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수를 초과하였습니다." } }
      : { body: { rt_cd: "0", output: { stck_prpr: "70000" } } }));
    const c = client(f);
    const r = await c.call({ method: "GET", path: "/x", trId: "T" });
    expect(n).toBe(2);
    expect(r.body.rt_cd).toBe("0");
    const { f: f2 } = fakeFetch(() => ({ body: { rt_cd: "1", msg_cd: "APBK0013", msg1: "주문가능금액을 초과 했습니다" } }));
    await expect(client(f2).call({ method: "GET", path: "/x", trId: "T" })).rejects.toThrow(/주문가능금액.*APBK0013/);
  });
  it("토큰은 한 번만 발급해 재사용", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { rt_cd: "0" } }));
    const c = client(f);
    await Promise.all([c.call({ method: "GET", path: "/a", trId: "T" }), c.call({ method: "GET", path: "/b", trId: "T" })]);
    expect(calls.filter((x) => x.url.pathname === "/oauth2/tokenP").length).toBe(1);
  });
});

describe("kis trading", () => {
  it("거래ID: 모의는 V, 실전은 T", () => {
    expect(orderTrId("mock", "buy")).toBe("VTTC0012U");
    expect(orderTrId("mock", "sell")).toBe("VTTC0011U");
    expect(orderTrId("real", "buy")).toBe("TTTC0012U");
  });
  it("주문 검증", () => {
    expect(() => validateOrder({ code: "12", side: "buy", qty: 1 })).toThrow();
    expect(() => validateOrder({ code: "005930", side: "buy", qty: 0 })).toThrow();
    expect(() => validateOrder({ code: "005930", side: "buy", qty: 1, type: "limit" })).toThrow(/가격/);
    expect(validateOrder({ code: "005930", side: "sell", qty: 3 })).toEqual({ code: "005930", side: "sell", qty: 3, type: "market", price: undefined });
  });
  it("주문 본문", () => {
    expect(orderBody("50012345", "01", { code: "005930", side: "buy", qty: 2, type: "limit", price: 70000 }))
      .toEqual({ CANO: "50012345", ACNT_PRDT_CD: "01", PDNO: "005930", ORD_DVSN: "00", ORD_QTY: "2", ORD_UNPR: "70000" });
    expect(orderBody("50012345", "01", { code: "005930", side: "buy", qty: 2, type: "market" }).ORD_UNPR).toBe("0");
  });
  it("모의 주문 전송", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { rt_cd: "0", msg1: "모의투자 매수주문이 완료 되었습니다.", output: { ODNO: "0000123", ORD_TMD: "093001" } } }));
    const r = await placeOrder(client(f), { code: "005930", side: "buy", qty: 1, type: "market" });
    expect(r).toMatchObject({ env: "mock", orderNo: "0000123" });
    const c = calls.find((x) => x.url.pathname.endsWith("/order-cash"))!;
    expect(c.url.origin).toBe("https://openapivts.koreainvestment.com:29443");
    expect((c.init.headers as Record<string, string>).tr_id).toBe("VTTC0012U");
    expect(JSON.parse(String(c.init.body)).ORD_DVSN).toBe("01");
  });
  it("잔고: 연속조회 합침", async () => {
    let page = 0;
    const { f } = fakeFetch(() => {
      page++;
      return {
        headers: { tr_cont: page === 1 ? "M" : "D" },
        body: {
          rt_cd: "0", ctx_area_fk100: "FK", ctx_area_nk100: "NK",
          output1: [{ pdno: page === 1 ? "005930" : "000660", prdt_name: "X", hldg_qty: "10", pchs_avg_pric: "100", prpr: "110", evlu_amt: "1100", evlu_pfls_amt: "100", evlu_pfls_rt: "10.00" }],
          output2: [{ dnca_tot_amt: "1000000", scts_evlu_amt: "2200", tot_evlu_amt: "1002200", evlu_pfls_smtl_amt: "200" }],
        },
      };
    });
    const b = await getBalance(client(f));
    expect(b.holdings.map((h) => h.code)).toEqual(["005930", "000660"]);
    expect(b.cash).toBe(1_000_000);
    expect(b.totalValue).toBe(1_002_200);
  });
});
