import { describe, expect, it } from "vitest";
import { KisClient } from "@/lib/kis/client";
import { kisReport } from "@/lib/diag/kis";

const env = { KIS_MOCK_APP_KEY: "mk-secret", KIS_MOCK_APP_SECRET: "ms-secret", KIS_MOCK_ACCOUNT: "50012345-01" };

function fake(handler: (url: URL) => { status?: number; body: unknown }) {
  const paths: string[] = [];
  const f = (async (u: string, init: RequestInit) => {
    const url = new URL(u);
    paths.push(`${init.method} ${url.pathname}`);
    if (url.pathname === "/oauth2/tokenP") return new Response(JSON.stringify({ access_token: "TOK", expires_in: 86400 }));
    const r = handler(url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, paths };
}

const ok = (x: object) => ({ body: { rt_cd: "0", msg1: "정상", ...x } });

describe("diag kis", () => {
  it("모든 조회 단계를 돌리고 주문(POST)은 내지 않으며 비밀값을 내보내지 않음", async () => {
    const { f, paths } = fake((u) => {
      const p = u.pathname;
      if (p.endsWith("inquire-price")) return ok({ output: { hts_kor_isnm: "삼성전자", stck_prpr: "70000", prdy_ctrt: "1.2" } });
      if (p.endsWith("itemchartprice")) return ok({ output2: [{ stck_bsop_date: "20261113", stck_oprc: "1", stck_hgpr: "1", stck_lwpr: "1", stck_clpr: "70000", acml_vol: "1" }] });
      if (p.endsWith("indexchartprice")) return ok({ output2: [{ stck_bsop_date: "20261113", bstp_nmix_prpr: "2500", bstp_nmix_oprc: "1", bstp_nmix_hgpr: "1", bstp_nmix_lwpr: "1", acml_vol: "1" }] });
      if (p.endsWith("inquire-balance")) return ok({ output1: [{ pdno: "005930", hldg_qty: "3", prdt_name: "삼성전자" }], output2: [{ dnca_tot_amt: "1234567", tot_evlu_amt: "9876543" }] });
      if (p.endsWith("inquire-psbl-order")) return ok({ output: { ord_psbl_cash: "1234567", max_buy_qty: "17" } });
      if (p.endsWith("inquire-daily-ccld")) return ok({ output1: [{ ord_dt: "20261116", ord_tmd: "091500", odno: "0000123", sll_buy_dvsn_cd_name: "매수", pdno: "005930", ord_qty: "1", tot_ccld_qty: "1", rmn_qty: "0" }] });
      if (p.endsWith("/dailyprice")) return ok({ output2: [{ xymd: u.searchParams.get("BYMD")! < "20240700" ? "20240607" : "20261113", clos: "120.888", open: "119", high: "121", low: "118", tvol: "100" }] });
      if (p.endsWith("inquire-daily-chartprice")) return ok({ output2: [{ stck_bsop_date: "20261113", ovrs_nmix_prpr: "1336.2", ovrs_nmix_oprc: "1330", ovrs_nmix_hgpr: "1340", ovrs_nmix_lwpr: "1329", acml_vol: "0" }] });
      return { status: 500, body: { rt_cd: "1", msg1: "unknown" } };
    });
    const r = await kisReport({}, { env, clientFor: (c) => new KisClient(c, { fetch: f, cacheDir: null, sleep: async () => {}, minIntervalMs: 0 }) });
    const mock = r.envs.find((x) => x.env === "mock")!;
    expect(mock.ok).toBe(true);
    expect(mock.checks.map((c) => c.step)).toEqual(["token", "quote", "daily", "index", "usDaily", "usHistory", "fx", "sp500", "balance", "buyable", "orders"]);
    expect(mock.checks.find((c) => c.step === "usHistory")?.info).toMatchObject({ nvda20240607: 120.888, splitAdjusted: true });
    expect(r.envs.find((x) => x.env === "real")).toMatchObject({ keys: false, checks: [] });
    expect(paths.filter((p) => p.startsWith("POST") && !p.includes("tokenP"))).toEqual([]);
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/mk-secret|ms-secret|50012345|1234567|9876543/);
    expect(mock.checks.find((c) => c.step === "orders")?.info).toMatchObject({ count: 1 });
  });

  it("토큰이 실패하면 그 뒤 단계는 건너뛰고 증권사 문구를 보여 줌", async () => {
    const f = (async () => new Response(JSON.stringify({ error_description: "유효하지 않은 AppKey입니다.", error_code: "EGW00103" }), { status: 403 })) as unknown as typeof fetch;
    const r = await kisReport({ env: "mock" }, { env, clientFor: (c) => new KisClient(c, { fetch: f, cacheDir: null, sleep: async () => {}, minIntervalMs: 0 }) });
    expect(r.envs).toHaveLength(1);
    expect(r.envs[0].checks).toHaveLength(1);
    expect(r.envs[0].checks[0]).toMatchObject({ ok: false });
    expect(r.envs[0].checks[0].error).toMatch(/AppKey/);
  });
});
