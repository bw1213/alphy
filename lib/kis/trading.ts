/**
 * KIS 주문·잔고 (서버 전용). 기본은 모의투자 계좌.
 * 실전 주문은 KIS_TRADE_ENV=real + KIS_ALLOW_REAL_ORDERS=yes 둘 다 있어야만 나갑니다 (config.tradeCredentials).
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
  return { env: client.env, orderNo: out.ODNO ?? out.odno ?? "", orderTime: out.ORD_TMD ?? out.ord_tmd ?? "", message: String(body.msg1 ?? "").trim() };
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
