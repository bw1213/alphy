"use client";

import { cycleStatus } from "@/lib/strategies/cycle";
import type { BacktestResult } from "@/lib/engine/types";

const won = (x: number) => `${Math.round(x).toLocaleString("ko-KR")}원`;
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");

/** 적립·분할 매도 전략: 마지막 날 기준 종목별 상태와, 마지막 거래 이후 거래가 없는 이유 */
export default function CycleStatusCard({ res, names }: { res: BacktestResult; names: Record<string, string> }) {
  const dates = res.equity.map((e) => e.date);
  const list = cycleStatus(res.state, dates);
  if (!list.length) return null;
  const end = dates[dates.length - 1];
  const lastTrade = (t: string) => res.trades.filter((x) => x.ticker === t).at(-1)?.date;
  const fall = (u: "pct" | "won", v: number) => (u === "pct" ? `${f1(v)}%` : won(v));

  const lastEq = res.equity.at(-1);
  const allCash = !!lastEq && lastEq.invested === 0;
  return (
    <div className="notice">
      <b>{end} 기준 적립·분할 매도 상태</b>
      <ul>
        {list.map((s) => {
          const nm = `${names[s.ticker] ?? s.ticker} (${s.ticker})`;
          const lt = lastTrade(s.ticker);
          const quiet = lt ? ` 마지막 거래 ${lt}.` : " 거래 없음.";
          if (s.phase === "buy") {
            const sk = s.skipped;
            return (
              <li key={s.ticker}>
                <b>{nm}</b>: 적립 단계.{quiet} 기준 최고가 {won(s.peak)}, 현재 {won(s.close)} (최고가 대비 {fall(s.dropUnit, s.dropNow)} 하락, {fall(s.dropUnit, s.sellAt)} 떨어지면 매도).
                {sk && (sk.reason === "share"
                  ? <> <b>{sk.since}부터 적립 {sk.count}번이 1주 값({won(s.close)})에 못 미쳐 아직 사지 못했습니다.</b> 모은 금액 {won(sk.saved ?? 0)}이 1주 값을 넘으면 그때 삽니다. 더 자주 사려면 적립 금액을 1주 값 이상으로 올리세요.</>
                  : sk.reason === "cash"
                  ? <> <b>{sk.since}부터 매수 {sk.count}번을 현금이 부족해 건너뛰었습니다</b> (남은 현금 {won(sk.cash)}, 한 번에 필요한 금액 약 {won(sk.need)}). 주식이 매도되거나 &quot;매달 추가 입금&quot;이 있어야 다시 삽니다.</>
                  : <> <b>{sk.since}부터 매수 {sk.count}번을 투자 비율 상한에 걸려 건너뛰었습니다.</b> 주가가 내려 비중이 줄거나 상한을 올리면 다시 삽니다.</>)}
              </li>
            );
          }
          const waits = [
            s.reboundNeed ? `바닥 대비 반등 ${f1(s.reboundNow!)}% / 필요 ${s.reboundNeed}%` : "",
            s.calmNeed ? `신저가 없이 ${s.calmNow}영업일 / 필요 ${s.calmNeed}영업일` : "",
            s.maNeed ? `종가가 ${s.maNeed}일 이동평균선 위` : "",
          ].filter(Boolean).join(", ");
          return (
            <li key={s.ticker}>
              <b>{nm}</b>: <b>하락 대응 단계라 매수를 멈춘 상태</b>입니다.{quiet} 기준 최고가 {won(s.peak)}, 바닥 {won(s.trough!)} ({s.troughDate}), 현재 {won(s.close)}. 다시 적립하려면: {waits}. 다음 추가 매도는 최고가 대비 {fall(s.dropUnit, s.sellAt)} 하락 시.
            </li>
          );
        })}
      </ul>
      {allCash && <p style={{ margin: "6px 0 0" }}>지금은 주식이 하나도 없고 현금만 있어서, 주가가 움직여도 평가 금액이 바뀌지 않습니다.</p>}
    </div>
  );
}
