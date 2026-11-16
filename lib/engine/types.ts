export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 티커별 일봉 */
export type PriceData = Record<string, Bar[]>;

/** 배당금·분배금 1건: date = 배당락일(이날 장 시작 전에 들고 있던 수량만 받음), amount = 1주당 세전 금액(시세와 같은 통화·분할 기준) */
export interface Dividend { date: string; amount: number }
/** 티커별 배당 이력 (날짜 오름차순) */
export type DividendData = Record<string, Dividend[]>;

/** 백테스트 중 받은 배당 1건 */
export interface DividendPayment {
  date: string;
  ticker: string;
  /** 받은 수량(배당락일 전날 종가 기준 보유 수량) */
  qty: number;
  perShare: number;
  gross: number;
  tax: number;
  /** 세후 = 계좌에 들어온 돈 */
  net: number;
}

export interface StockInfo {
  code: string;
  name: string;
  marketCap?: number;
}

export type Rebalance = "D" | "W" | "M" | "Q" | number;

export interface RunSettings {
  rebalance: Rebalance;
  stopLoss: number | null; // 0.1 = -10%
  takeProfit: number | null; // 0.3 = +30%
  rebalanceBand: number; // 보유비중 차이가 이보다 작으면 수량 조정 안 함
  warmup: number; // 최소 영업일 수
}

export interface CostSettings {
  commission: number; // 0.00015
  slippage: number; // 0.001
  sellTax: number | null; // null → 연도별 법정세율
  /** 미국 종목 비용 (없으면 기본값). commission 0.0025 = 0.25%, fx = 원화↔달러 환전 비용 (살 때·팔 때 각각) */
  us?: { commission: number; fx: number };
}

export interface Trade {
  date: string;
  ticker: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  fee: number;
  pnl: number | null;
  ret: number | null;
  reason: "rebalance" | "stop_loss" | "take_profit" | "delisted";
  /** 전략이 남긴 매매 이유 (예: "적립 매수", "하락 매도 1단계"). 있으면 화면에 reason 대신 보여 줌 */
  note?: string;
}

export interface EquityPoint {
  date: string;
  /** 실제 평가액(현금 + 주식). 추가 입금이 있으면 입금만큼 늘어남 */
  equity: number;
  /** 수익률 계산용 가치: 추가 입금 효과를 뺀 시간가중 기준, 시작 자금에서 출발. 입금이 없으면 equity 와 같음 */
  nav?: number;
  /** 지금까지 넣은 돈 (시작 자금 + 추가 입금) */
  contributed?: number;
  cash: number;
  invested: number;
  benchmark: number | null;
}

/** 마지막 날 종가 기준으로 전략이 고른 종목 = 다음 거래일에 맞출 목표 */
export interface Signal {
  /** 신호 기준일(데이터의 마지막 날) */
  date: string;
  picks: { ticker: string; weight: number; close: number }[];
  /** 전략이 '이번엔 매매 안 함(null)'을 돌려줘서 백테스트상 보유 종목을 그대로 보여주는 경우 */
  kept: boolean;
  /** 전략이 남긴 종목별 매매 이유 (예: 적립 매수) */
  notes?: Record<string, string>;
}

export interface BacktestResult {
  equity: EquityPoint[];
  trades: Trade[];
  finalPositions: { ticker: string; qty: number; avgPrice: number; value: number }[];
  /** 워밍업이 안 끝났으면 null */
  signal: Signal | null;
  /** 전략이 ctx.state 에 남긴 메모 (마지막 날 상태 설명용) */
  state?: Record<string, any>;
  /** 받은 배당금·분배금 (배당 데이터를 넣었을 때만) */
  dividends?: DividendPayment[];
}

export type Weights = Record<string, number>;

/** 비중 대신 이 값을 주면 "이 종목은 지금 수량 그대로 둠" (다른 종목만 사고팔 때) */
export const HOLD = -1;

/** 그 날짜 시점의 종목 목록(시총 상위 등). 날짜 오름차순. 생존편향을 없애려고 씀 */
export interface UniverseSnapshot { date: string; tickers: string[] }
