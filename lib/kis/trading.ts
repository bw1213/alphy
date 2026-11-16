/**
 * KIS 주문·잔고 (서버 전용). 기본은 모의투자 계좌.
 * 실전 주문은 주문 대상=실전(설정 화면) + KIS_ALLOW_REAL_ORDERS=yes(환경변수) 둘 다 있어야만 나갑니다 (config.tradeCredentials).
 */
import type { KisClient } from "./client";

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface OrderRequest {
  code: string;
  side: Side;
  qty: number;
  type: OrderType;
  /** 지정가일 때 주문 단가(원) */
  price?: number;
}

export interface OrderResult {
  env: "real" | "mock";
  orderNo: string;
  orderTime: string;
  message: string;
  /** 주문을 받은 지점 번호 (취소할 때 필요) */
  orgNo?: string;
}

/** 주식주문(현금) 거래ID. 2024년 개편된 신규 ID */
export function orderTrId(env: "real" | "mock", side: Side): string {
  const id = side === "buy" ? "TTTC0012U" : "TTTC0011U";
  return env === "mock" ? "V" + id.slice(1) : id;
}

export function validateOrder(o: Partial<OrderRequest>): OrderRequest {
  const code = String(o.code ?? "").trim().toUpperCase();
  if (!/^[0-9A-Z]{6}$/.test(code)) throw new Error("종목코드는 6자리입니다 (예: 005930)");
  if (o.side !== "buy" && o.side !== "sell") throw new Error("매수/매도를 선택하세요");
  const qty = Number(o.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 1_000_000) throw new Error("수량은 1 이상 정수입니다");
  const type: OrderType = o.type === "limit" ? "limit" : "market";
  let price: number | undefined;
  if (type === "limit") {
    price = Number(o.price);
    if (!Number.isInteger(price) || price <= 0) throw new Error("지정가 주문은 가격(원, 정수)이 필요합니다");
  }
  return { code, side: o.side, qty, type, price };
}

export function orderBody(cano: string, acntPrdtCd: string, o: OrderRequest): Record<string, string> {
  return {
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    PDNO: o.code,
    ORD_DVSN: o.type === "limit" ? "00" : "01", // 00 지정가, 01 시장가
    ORD_QTY: String(o.qty),
    ORD_UNPR: o.type === "limit" ? String(o.price) : "0",
  };
}

export async function placeOrder(client: KisClient, order: OrderRequest): Promise<OrderResult> {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  const o = validateOrder(order);
  const { body } = await client.call({
    method: "POST",
    path: "/uapi/domestic-stock/v1/trading/order-cash",
    trId: orderTrId(client.env, o.side),
    body: orderBody(cano, acntPrdtCd, o),
  });
  const out = (body.output ?? {}) as Record<string, string>;
  return { env: client.env, orderNo: out.ODNO ?? out.odno ?? "", orderTime: out.ORD_TMD ?? out.ord_tmd ?? "", message: String(body.msg1 ?? "").trim(), orgNo: out.KRX_FWDG_ORD_ORGNO ?? out.krx_fwdg_ord_orgno ?? undefined };
}

export interface Holding {
  code: string; name: string; qty: number; avgPrice: number; price: number;
  value: number; pnl: number; pnlRate: number;
}

export interface Balance {
  env: "real" | "mock";
  holdings: Holding[];
  cash: number;          // 예수금 총액
  stockValue: number;    // 유가평가금액
  totalValue: number;    // 총평가금액
  pnl: number;           // 평가손익 합계
}

const num = (s: unknown) => Number(String(s ?? "0").replace(/,/g, "")) || 0;

export function parseBalance(env: "real" | "mock", rows: any[], summary: any): Balance {
  const holdings = rows
    .filter((r) => num(r.hldg_qty) > 0)
    .map((r) => ({
      code: String(r.pdno), name: String(r.prdt_name ?? "").trim(), qty: num(r.hldg_qty),
      avgPrice: num(r.pchs_avg_pric), price: num(r.prpr), value: num(r.evlu_amt),
      pnl: num(r.evlu_pfls_amt), pnlRate: num(r.evlu_pfls_rt),
    }));
  const s = summary ?? {};
  return {
    env, holdings,
    cash: num(s.dnca_tot_amt), stockValue: num(s.scts_evlu_amt), totalValue: num(s.tot_evlu_amt),
    pnl: num(s.evlu_pfls_smtl_amt),
  };
}

export async function getBalance(client: KisClient): Promise<Balance> {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  const rows: any[] = [];
  let summary: any = null;
  let fk = "", nk = "", trCont = "";
  for (let page = 0; page < 20; page++) {
    const r = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/trading/inquire-balance",
      trId: client.env === "mock" ? "VTTC8434R" : "TTTC8434R",
      trCont,
      query: {
        CANO: cano, ACNT_PRDT_CD: acntPrdtCd, AFHR_FLPR_YN: "N", OFL_YN: "", INQR_DVSN: "02", UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N", FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "00",
        CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
      },
    });
    rows.push(...((r.body.output1 as any[]) ?? []));
    summary = ((r.body.output2 as any[]) ?? [])[0] ?? summary;
    if (r.trCont !== "M" && r.trCont !== "F") break;
    fk = String(r.body.ctx_area_fk100 ?? "");
    nk = String(r.body.ctx_area_nk100 ?? "");
    trCont = "N";
  }
  return parseBalance(client.env, rows, summary);
}

/** 매수가능조회 (주문은 내지 않음). 계좌 권한·주문 경로가 살아 있는지 확인용 */
export async function getBuyable(client: KisClient, code: string, price = 0): Promise<{ cash: number; maxQty: number }> {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  const { body } = await client.call({
    method: "GET",
    path: "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
    trId: client.env === "mock" ? "VTTC8908R" : "TTTC8908R",
    query: {
      CANO: cano, ACNT_PRDT_CD: acntPrdtCd, PDNO: code,
      ORD_UNPR: price > 0 ? String(price) : "0", ORD_DVSN: price > 0 ? "00" : "01",
      CMA_EVLU_AMT_ICLD_YN: "N", OVRS_ICLD_YN: "N",
    },
  });
  const o = (body.output ?? {}) as Record<string, string>;
  return { cash: num(o.ord_psbl_cash), maxQty: num(o.max_buy_qty || o.nrcvb_buy_qty) };
}

export interface OrderRecord {
  date: string; time: string; orderNo: string; side: string; code: string; name: string;
  qty: number; filledQty: number; price: number; avgPrice: number; remaining: number; cancelled: boolean;
}

/** 일별 주문·체결 내역 (기간은 YYYYMMDD, 최근 3개월 안) */
export async function getOrders(client: KisClient, from: string, to: string): Promise<OrderRecord[]> {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  const out: OrderRecord[] = [];
  let fk = "", nk = "", trCont = "";
  for (let page = 0; page < 10; page++) {
    const r = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
      trId: client.env === "mock" ? "VTTC0081R" : "TTTC0081R",
      trCont,
      query: {
        CANO: cano, ACNT_PRDT_CD: acntPrdtCd, INQR_STRT_DT: from, INQR_END_DT: to,
        SLL_BUY_DVSN_CD: "00", INQR_DVSN: "00", PDNO: "", CCLD_DVSN: "00", ORD_GNO_BRNO: "", ODNO: "",
        INQR_DVSN_3: "00", INQR_DVSN_1: "", CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
      },
    });
    for (const x of ((r.body.output1 as any[]) ?? [])) {
      if (!x?.odno) continue;
      out.push({
        date: String(x.ord_dt ?? ""), time: String(x.ord_tmd ?? ""), orderNo: String(x.odno),
        side: String(x.sll_buy_dvsn_cd_name ?? x.sll_buy_dvsn_cd ?? "").trim(), code: String(x.pdno ?? ""),
        name: String(x.prdt_name ?? "").trim(), qty: num(x.ord_qty), filledQty: num(x.tot_ccld_qty),
        price: num(x.ord_unpr), avgPrice: num(x.avg_prvs), remaining: num(x.rmn_qty), cancelled: x.cncl_yn === "Y",
      });
    }
    if (r.trCont !== "M" && r.trCont !== "F") break;
    fk = String(r.body.ctx_area_fk100 ?? "");
    nk = String(r.body.ctx_area_nk100 ?? "");
    trCont = "N";
  }
  return out;
}
