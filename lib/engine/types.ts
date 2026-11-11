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
  reason: "rebalance" | "stop_loss" | "take_profit";
}

export interface EquityPoint {
  date: string;
  equity: number;
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
