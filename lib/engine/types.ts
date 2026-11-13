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
}

export interface BacktestResult {
  equity: EquityPoint[];
  trades: Trade[];
  finalPositions: { ticker: string; qty: number; avgPrice: number; value: number }[];
  /** 워밍업이 안 끝났으면 null */
  signal: Signal | null;
}

export type Weights = Record<string, number>;

/** 비중 대신 이 값을 주면 "이 종목은 지금 수량 그대로 둠" (다른 종목만 사고팔 때) */
export const HOLD = -1;

/** 그 날짜 시점의 종목 목록(시총 상위 등). 날짜 오름차순. 생존편향을 없애려고 씀 */
export interface UniverseSnapshot { date: string; tickers: string[] }
