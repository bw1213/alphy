/**
 * KIS 주문 조회·취소·주문 가능 금액 (서버 전용).
 * 거래ID는 실전 기준이고, 모의투자는 맨 앞 T 를 V 로 바꿉니다.
 */
import type { KisClient } from "./client";

const num = (s: unknown) => Number(String(s ?? "0").replace(/,/g, "")) || 0;
const tr = (env: "real" | "mock", id: string) => (env === "mock" ? "V" + id.slice(1) : id);
const ymd = (iso: string) => iso.replace(/-/g, "");

export interface DayOrder {
  orderNo: string;
  /** 주문을 받은 지점 번호 (취소할 때 필요) */
  orgNo: string;
  code: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  /** 남은(미체결) 수량 */
  openQty: number;
  /** 체결 평균가 */
  avgPrice: number;
  /** 주문 가격 (시장가면 0) */
  price: number;
  time: string;
  /** 취소 주문이거나 취소된 주문 */
  cancelled: boolean;
}

export function parseDayOrders(rows: any[]): DayOrder[] {
  return rows.filter((r) => r && r.odno).map((r) => {
    const qty = num(r.ord_qty), filled = num(r.tot_ccld_qty);
    const cancelled = String(r.cncl_yn ?? "").toUpperCase() === "Y" || /취소/.test(String(r.sll_buy_dvsn_cd_name ?? "")) || num(r.cncl_cfrm_qty) > 0;
    const rmn = r.rmn_qty !== undefined ? num(r.rmn_qty) : Math.max(0, qty - filled);
    return {
      orderNo: String(r.odno), orgNo: String(r.ord_gno_brno ?? ""), code: String(r.pdno ?? ""), name: String(r.prdt_name ?? "").trim(),
      side: String(r.sll_buy_dvsn_cd) === "01" ? "sell" : "buy",
      qty, filledQty: filled, openQty: cancelled ? 0 : rmn, avgPrice: num(r.avg_prvs), price: num(r.ord_unpr),
      time: String(r.ord_tmd ?? ""), cancelled,
    };
  });
}

/** 그날 주문·체결 내역 (기본 오늘, 한국 시간 날짜 YYYY-MM-DD) */
export async function listDayOrders(client: KisClient, date: string): Promise<DayOrder[]> {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  const rows: any[] = [];
  let fk = "", nk = "", trCont = "";
  for (let page = 0; page < 10; page++) {
    const r = await client.call({
      method: "GET",
      path: "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
      trId: tr(client.env, "TTTC0081R"),
      trCont,
      query: {
        CANO: cano, ACNT_PRDT_CD: acntPrdtCd, INQR_STRT_DT: ymd(date), INQR_END_DT: ymd(date),
        SLL_BUY_DVSN_CD: "00", INQR_DVSN: "00", PDNO: "", CCLD_DVSN: "00", ORD_GNO_BRNO: "", ODNO: "",
        INQR_DVSN_3: "00", INQR_DVSN_1: "", EXCG_ID_DVSN_CD: "KRX", CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
      },
    });
    rows.push(...((r.body.output1 as any[]) ?? []));
    if (r.trCont !== "M" && r.trCont !== "F") break;
    fk = String(r.body.ctx_area_fk100 ?? "");
    nk = String(r.body.ctx_area_nk100 ?? "");
    trCont = "N";
  }
  return parseDayOrders(rows);
}

/** 남은 수량 전부 취소 */
export async function cancelOrder(client: KisClient, o: Pick<DayOrder, "orderNo" | "orgNo">): Promise<string> {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  const { body } = await client.call({
    method: "POST",
    path: "/uapi/domestic-stock/v1/trading/order-rvsecncl",
    trId: tr(client.env, "TTTC0013U"),
    body: {
      CANO: cano, ACNT_PRDT_CD: acntPrdtCd, KRX_FWDG_ORD_ORGNO: o.orgNo, ORGN_ODNO: o.orderNo,
      ORD_DVSN: "00", RVSE_CNCL_DVSN_CD: "02", ORD_QTY: "0", ORD_UNPR: "0", QTY_ALL_ORD_YN: "Y", EXCG_ID_DVSN_CD: "KRX",
    },
  });
  return String(body.msg1 ?? "").trim();
}

/** 미수 없이 살 수 있는 현금(원). 그 종목·가격 기준으로 증권사가 계산 */
export async function buyableCash(client: KisClient, code: string, price: number): Promise<number> {
  const { cano, acntPrdtCd } = client.cred;
  if (!cano || !acntPrdtCd) throw new Error("계좌번호가 설정되지 않았습니다");
  const { body } = await client.call({
    method: "GET",
    path: "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
    trId: tr(client.env, "TTTC8908R"),
    query: { CANO: cano, ACNT_PRDT_CD: acntPrdtCd, PDNO: code, ORD_UNPR: String(Math.max(0, Math.round(price))), ORD_DVSN: "01", CMA_EVLU_AMT_ICLD_YN: "N", OVRS_ICLD_YN: "N" },
  });
  const o = (body.output ?? {}) as Record<string, unknown>;
  return num(o.nrcvb_buy_amt ?? o.ord_psbl_cash);
}

