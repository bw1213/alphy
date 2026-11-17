/**
 * KIS 해외주식(미국) 주문·잔고·체결·취소·주문 가능 수량·현재가 (서버 전용).
 *
 * 거래ID는 실전 기준이고 모의투자는 맨 앞 T 를 V 로 바꿉니다. 매도 주문만 모의 ID 가 따로 있습니다(VTTT1001U).
 * 미국 주식은 시장가 주문이 없어 지정가로만 냅니다 (모의투자도 지정가만 됨).
 * 가격은 모두 달러, 종목 코드는 알피 형식(BRK.B) ↔ 한국투자증권 형식(BRK/B)으로 바꿔 씁니다.
 */
import type { KisClient } from "./client";
import type { Balance, OrderResult, Side } from "./trading";
import type { DayOrder } from "./orders";
import { kisUsSymbol, type KisExchange } from "./market";

const num = (s: unknown) => Number(String(s ?? "0").replace(/,/g, "")) || 0;
const ymd = (iso: string) => iso.replace(/-/g, "");
const fromKis = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\//g, ".");

/** 주문용 거래소 코드 */
export type OrderExchange = "NASD" | "NYSE" | "AMEX";
export const ORDER_EXCHANGE: Record<KisExchange, OrderExchange> = { NAS: "NASD", NYS: "NYSE", AMS: "AMEX" };
const QUOTE_EXCHANGE: Record<OrderExchange, KisExchange> = { NASD: "NAS", NYSE: "NYS", AMEX: "AMS" };

export function usOrderTrId(env: "real" | "mock", side: Side): string {
  if (env === "mock") return side === "buy" ? "VTTT1002U" : "VTTT1001U";
  return side === "buy" ? "TTTT1002U" : "TTTT1006U";
}
const tr = (env: "real" | "mock", id: string) => (env === "mock" ? "V" + id.slice(1) : id);

/** 달러 호가 단위: 1달러 이상은 센트, 미만은 0.0001 */
export const usdTick = (p: number) => (p >= 1 ? Math.round(p * 100) / 100 : Math.round(p * 10000) / 10000);

const account = (client: KisClient) => {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  return { CANO: cano, ACNT_PRDT_CD: acntPrdtCd };
};

/** 미국 현재가(달러). 거래소를 모르면 순서대로 시도하고 찾은 거래소를 함께 돌려줌 */
export async function usQuote(client: KisClient, ticker: string, exchanges: KisExchange[] = ["NAS", "NYS", "AMS"]): Promise<{ price: number; exchange: KisExchange }> {
  let lastErr: Error | null = null;
  for (const excd of exchanges) {
    try {
      const { body } = await client.call({
        method: "GET",
        path: "/uapi/overseas-price/v1/quotations/price",
        trId: "HHDFS00000300",
        query: { AUTH: "", EXCD: excd, SYMB: kisUsSymbol(ticker) },
      });
      const price = num((body.output as Record<string, unknown> | undefined)?.last);
      if (price > 0) return { price, exchange: excd };
    } catch (e) { lastErr = e as Error; }
  }
  throw new Error(`${ticker}: 미국 현재가를 받지 못했습니다${lastErr ? ` (${lastErr.message})` : ""}`);
}

export interface UsOrder { ticker: string; exchange: OrderExchange; side: Side; qty: number; /** 지정가(달러) */ price: number }

export function usOrderBody(acct: { CANO: string; ACNT_PRDT_CD: string }, o: UsOrder): Record<string, string> {
  return {
    ...acct,
    OVRS_EXCG_CD: o.exchange,
    PDNO: kisUsSymbol(o.ticker),
    ORD_QTY: String(o.qty),
    OVRS_ORD_UNPR: String(usdTick(o.price)),
    CTAC_TLNO: "", MGCO_APTM_ODNO: "",
    SLL_TYPE: o.side === "sell" ? "00" : "",
    ORD_SVR_DVSN_CD: "0",
    ORD_DVSN: "00", // 지정가
  };
}

export async function placeUsOrder(client: KisClient, o: UsOrder): Promise<OrderResult> {
  if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error("수량은 1 이상 정수입니다");
  if (!(o.price > 0)) throw new Error("미국 주식 주문은 지정가(달러)가 필요합니다");
  const { body } = await client.call({
    method: "POST",
    path: "/uapi/overseas-stock/v1/trading/order",
    trId: usOrderTrId(client.env, o.side),
    body: usOrderBody(account(client), o),
  });
  const out = (body.output ?? {}) as Record<string, string>;
  return { env: client.env, orderNo: out.ODNO ?? out.odno ?? "", orderTime: out.ORD_TMD ?? out.ord_tmd ?? "", message: String(body.msg1 ?? "").trim(), orgNo: out.KRX_FWDG_ORD_ORGNO ?? out.krx_fwdg_ord_orgno ?? undefined };
}

/** 남은 수량 전부 취소 */
export async function cancelUsOrder(client: KisClient, o: { orderNo: string; ticker: string; exchange: OrderExchange; qty: number }): Promise<string> {
  const { body } = await client.call({
    method: "POST",
    path: "/uapi/overseas-stock/v1/trading/order-rvsecncl",
    trId: tr(client.env, "TTTT1004U"),
    body: {
      ...account(client), OVRS_EXCG_CD: o.exchange, PDNO: kisUsSymbol(o.ticker), ORGN_ODNO: o.orderNo,
      RVSE_CNCL_DVSN_CD: "02", ORD_QTY: String(o.qty), OVRS_ORD_UNPR: "0", MGCO_APTM_ODNO: "", ORD_SVR_DVSN_CD: "0",
    },
  });
  return String(body.msg1 ?? "").trim();
}

export function parseUsBalance(env: "real" | "mock", rows: any[]): Balance {
  const holdings = rows.filter((r) => num(r.ovrs_cblc_qty) > 0).map((r) => ({
    code: fromKis(r.ovrs_pdno), name: String(r.ovrs_item_name ?? "").trim(), qty: num(r.ovrs_cblc_qty),
    avgPrice: num(r.pchs_avg_pric), price: num(r.now_pric2), value: num(r.ovrs_stck_evlu_amt),
    pnl: num(r.frcr_evlu_pfls_amt), pnlRate: num(r.evlu_pfls_rt),
    ...(r.ord_psbl_qty != null && r.ord_psbl_qty !== "" ? { sellable: num(r.ord_psbl_qty) } : {}),
  }));
  const stockValue = holdings.reduce((a, h) => a + h.value, 0);
  // 금액은 달러. 예수금·총평가액은 이 조회에 없어 0 (총자산은 usTotalAsset 으로 따로)
  return { env, holdings, cash: 0, stockValue, totalValue: 0, pnl: holdings.reduce((a, h) => a + h.pnl, 0) };
}

/** 미국 주식 잔고 (금액은 달러). 실전은 NASD 로 물으면 미국 전체, 모의는 거래소별로 물어 합침 */
export async function getUsBalance(client: KisClient): Promise<Balance> {
  const acct = account(client);
  const rows: any[] = [];
  const seen = new Set<string>();
  for (const excg of client.env === "real" ? ["NASD"] : ["NASD", "NYSE", "AMEX"]) {
    let fk = "", nk = "", trCont = "";
    for (let page = 0; page < 10; page++) {
      const r = await client.call({
        method: "GET",
        path: "/uapi/overseas-stock/v1/trading/inquire-balance",
        trId: tr(client.env, "TTTS3012R"),
        trCont,
        query: { ...acct, OVRS_EXCG_CD: excg, TR_CRCY_CD: "USD", CTX_AREA_FK200: fk, CTX_AREA_NK200: nk },
      });
      for (const row of (r.body.output1 as any[]) ?? []) {
        const key = String(row?.ovrs_pdno ?? "");
        if (key && !seen.has(key)) { seen.add(key); rows.push(row); }
      }
      if (r.trCont !== "M" && r.trCont !== "F") break;
      fk = String(r.body.ctx_area_fk200 ?? "");
      nk = String(r.body.ctx_area_nk200 ?? "");
      trCont = "N";
    }
  }
  return parseUsBalance(client.env, rows);
}

/** 계좌 총자산(원): 국내·해외 주식과 원화·외화 예수금을 원화로 합친 값. 못 읽으면 throw */
export async function usTotalAsset(client: KisClient): Promise<number> {
  const { body } = await client.call({
    method: "GET",
    path: "/uapi/overseas-stock/v1/trading/inquire-present-balance",
    trId: tr(client.env, "CTRP6504R"),
    query: { ...account(client), WCRC_FRCR_DVSN_CD: "02", NATN_CD: "000", TR_MKET_CD: "00", INQR_DVSN_CD: "00" },
  });
  const o = (Array.isArray(body.output3) ? body.output3[0] : body.output3) as Record<string, unknown> | undefined;
  const total = num(o?.tot_asst_amt);
  if (!(total > 0)) throw new Error("총자산을 읽지 못했습니다");
  return total;
}

export function parseUsOrders(rows: any[]): DayOrder[] {
  return rows.filter((r) => r && r.odno).map((r) => {
    const qty = num(r.ft_ord_qty), filled = num(r.ft_ccld_qty);
    const cancelled = String(r.rvse_cncl_dvsn ?? "") === "02" || /취소/.test(String(r.rvse_cncl_dvsn_name ?? ""));
    const rmn = r.nccs_qty !== undefined ? num(r.nccs_qty) : Math.max(0, qty - filled);
    return {
      orderNo: String(r.odno), orgNo: String(r.ord_gno_brno ?? ""), code: fromKis(r.pdno), name: String(r.prdt_name ?? "").trim(),
      side: String(r.sll_buy_dvsn_cd) === "01" ? "sell" : "buy",
      qty, filledQty: filled, openQty: cancelled ? 0 : rmn, avgPrice: num(r.ft_ccld_unpr3), price: num(r.ft_ord_unpr3),
      time: String(r.ord_tmd ?? ""), cancelled,
    };
  });
}

/** 주문·체결 내역. 주문일자가 한국 날짜인지 현지 날짜인지에 기대지 않도록 from~to 를 넉넉히 주고 주문번호로 찾는다 */
export async function listUsOrders(client: KisClient, from: string, to: string): Promise<DayOrder[]> {
  const acct = account(client);
  const rows: any[] = [];
  let fk = "", nk = "", trCont = "";
  for (let page = 0; page < 10; page++) {
    const r = await client.call({
      method: "GET",
      path: "/uapi/overseas-stock/v1/trading/inquire-ccnl",
      trId: tr(client.env, "TTTS3035R"),
      trCont,
      query: {
        ...acct, PDNO: client.env === "mock" ? "" : "%", ORD_STRT_DT: ymd(from), ORD_END_DT: ymd(to), SLL_BUY_DVSN: "00", CCLD_NCCS_DVSN: "00",
        OVRS_EXCG_CD: client.env === "mock" ? "" : "%", SORT_SQN: "DS", ORD_DT: "", ORD_GNO_BRNO: "", ODNO: "", CTX_AREA_NK200: nk, CTX_AREA_FK200: fk,
      },
    });
    rows.push(...((r.body.output as any[]) ?? []));
    if (r.trCont !== "M" && r.trCont !== "F") break;
    fk = String(r.body.ctx_area_fk200 ?? "");
    nk = String(r.body.ctx_area_nk200 ?? "");
    trCont = "N";
  }
  return parseUsOrders(rows);
}

/** 그 가격(달러)에 살 수 있는 최대 수량 (통합증거금이면 원화까지 포함) */
export async function usBuyableQty(client: KisClient, ticker: string, exchange: OrderExchange, price: number): Promise<number> {
  const { body } = await client.call({
    method: "GET",
    path: "/uapi/overseas-stock/v1/trading/inquire-psamount",
    trId: tr(client.env, "TTTS3007R"),
    query: { ...account(client), OVRS_EXCG_CD: exchange, OVRS_ORD_UNPR: String(usdTick(price)), ITEM_CD: kisUsSymbol(ticker) },
  });
  const o = (body.output ?? {}) as Record<string, unknown>;
  return Math.floor(Math.max(num(o.ovrs_max_ord_psbl_qty), num(o.max_ord_psbl_qty)));
}

export const quoteExchange = (x: OrderExchange): KisExchange => QUOTE_EXCHANGE[x];
