"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { drawdown, TARGET_CAGR, type Summary } from "@/lib/engine/metrics";
import type { BacktestResult } from "@/lib/engine/types";
import { SIGNAL_KEY, type SavedSignal } from "@/lib/trade/plan";

const pct = (x: number | null | undefined, d = 1) =>
  x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`;
const won = (x: number) => `${Math.round(x).toLocaleString("ko-KR")}원`;
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");

function useColors() {
  const read = () => {
    if (typeof window === "undefined") return { s1: "#2a78d6", s2: "#eb6834", grid: "#ecebe7", t2: "#52514e", t3: "#8a8984", bad: "#c62828" };
    const cs = getComputedStyle(document.documentElement);
    const g = (k: string) => cs.getPropertyValue(k).trim();
    return { s1: g("--series-1"), s2: g("--series-2"), grid: g("--grid"), t2: g("--text-2"), t3: g("--text-3"), bad: g("--bad") };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const f = () => setC(read());
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return c;
}

function Tip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="d">{label}</div>
      {payload.filter((p: any) => p.value != null).map((p: any) => (
        <div className="r" key={p.dataKey}>
          <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: p.color, marginRight: 6 }} />{p.name}</span>
          <b>{fmt(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

export default function Results({ res, s, names, label, title }: {
  res: BacktestResult; s: Summary; names: Record<string, string>; label: string; title?: string;
}) {
  const c = useColors();
  const [tab, setTab] = useState<"signal" | "annual" | "trades" | "positions">("annual");
  const [log, setLog] = useState(true);

  const series = useMemo(() => {
    const e0 = res.equity[0];
    const b0 = e0?.benchmark;
    const dd = drawdown(res.equity.map((e) => e.equity));
    const t0 = Date.parse(e0.date);
    return res.equity.map((e, k) => ({
      date: e.date,
      strategy: (e.equity / e0.equity) * 100,
      kospi: b0 && e.benchmark ? (e.benchmark / b0) * 100 : null,
      target: 100 * (1 + TARGET_CAGR) ** ((Date.parse(e.date) - t0) / (365.25 * 864e5)),
      dd: dd[k] * 100,
    }));
  }, [res]);

  const hasBench = s.bench != null;
  const annual = s.annual.map((a) => ({ year: String(a.year), strategy: a.ret * 100, kospi: a.bench == null ? null : a.bench * 100 }));
  const sells = res.trades.filter((t) => t.side === "SELL");

  const download = () => {
    const head = "date,ticker,name,side,qty,price,fee,pnl,ret,reason";
    const rows = res.trades.map((t) => [t.date, t.ticker, names[t.ticker] ?? "", t.side, t.qty, t.price.toFixed(0),
      t.fee.toFixed(0), t.pnl?.toFixed(0) ?? "", t.ret?.toFixed(4) ?? "", t.reason].join(","));
    const blob = new Blob(["﻿" + [head, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${label}.csv`;
    a.click();
  };

  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi">
          <div className="k">연평균 수익률 (CAGR)</div>
          <div className="v">{pct(s.cagr)}</div>
          <div className={`badge ${s.meetsTarget ? "ok" : "no"}`}>{s.meetsTarget ? "✓ 목표 30% 달성" : "✕ 목표 30% 미달"}</div>
        </div>
        <div className="kpi"><div className="k">최대 낙폭 (MDD)</div><div className="v">{pct(s.mdd)}</div>
          <div className="s">KOSPI {pct(s.bench?.mdd)}</div></div>
        <div className="kpi"><div className="k">누적 수익률</div><div className="v">{pct(s.totalReturn)}</div>
          <div className="s">KOSPI {pct(s.bench?.totalReturn)}</div></div>
        <div className="kpi"><div className="k">샤프 / 소르티노</div><div className="v">{num(s.sharpe)}</div>
          <div className="s">소르티노 {num(s.sortino)}</div></div>
        <div className="kpi"><div className="k">승률 (청산 {s.nSells}건)</div><div className="v">{pct(s.winRate, 0)}</div>
          <div className="s">평균 {pct(s.avgTradeRet)}</div></div>
        <div className="kpi"><div className="k">연 30% 달성 연도</div><div className="v">{s.yearsHitTarget} / {s.annual.length}</div>
          <div className="s">평균 투자비중 {pct(s.exposure, 0)}</div></div>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h2>자산 추이 (시작 = 100)</h2>
          <div className="seg" style={{ width: 140 }}>
            <button className={log ? "on" : ""} onClick={() => setLog(true)}>로그</button>
            <button className={!log ? "on" : ""} onClick={() => setLog(false)}>선형</button>
          </div>
        </div>
        <div className="legend">
          <span><i style={{ background: c.s1 }} />전략</span>
          {hasBench && <span><i style={{ background: c.s2 }} />KOSPI 지수</span>}
          <span><i className="dash" />연 30% 목표</span>
        </div>
        <div style={{ height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="date" tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} minTickGap={50}
                tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis scale={log ? "log" : "linear"} domain={["auto", "auto"]} tick={{ fill: c.t2, fontSize: 11 }}
                stroke={c.grid} width={48} allowDataOverflow tickFormatter={(v: number) => v.toFixed(0)} />
              <Tooltip content={<Tip fmt={(v: number) => v.toFixed(1)} />} />
              <Line dataKey="target" name="연 30% 목표" stroke={c.t3} strokeDasharray="4 3" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              {hasBench && <Line dataKey="kospi" name="KOSPI" stroke={c.s2} dot={false} strokeWidth={1.5} isAnimationActive={false} />}
              <Line dataKey="strategy" name="전략" stroke={c.s1} dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <h3>낙폭 (%)</h3>
        <div style={{ height: 120 }}>
          <ResponsiveContainer>
            <AreaChart data={series} margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="date" hide />
              <YAxis tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} width={48} tickFormatter={(v: number) => v.toFixed(0)} />
              <Tooltip content={<Tip fmt={(v: number) => `${v.toFixed(1)}%`} />} />
              <Area dataKey="dd" name="낙폭" stroke={c.bad} fill={c.bad} fillOpacity={0.25} strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <div className="tabs">
          <button className={tab === "signal" ? "on" : ""} onClick={() => setTab("signal")}>추천 종목{res.signal ? ` (${res.signal.picks.length})` : ""}</button>
          <button className={tab === "annual" ? "on" : ""} onClick={() => setTab("annual")}>연도별 수익률</button>
          <button className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>매매 내역 ({res.trades.length})</button>
          <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>현재 보유 ({res.finalPositions.length})</button>
        </div>

        {tab === "signal" && (
          !res.signal ? <p className="help">데이터가 모자라 추천 종목을 계산하지 못했습니다(워밍업 기간 부족).</p> : (
            <>
              <p className="help">
                <b>{res.signal.date}</b> 종가까지의 데이터로 이 전략이 고른 종목과 비중입니다. 다음 거래일에 이 비중으로 맞춘다는 뜻이고, 리밸런싱 주기와 상관없이 &quot;오늘 새로 시작한다면&quot; 기준으로 계산합니다.
                {res.signal.kept && " 전략이 '이번엔 매매 안 함'을 돌려줘서 백테스트상 보유 종목을 그대로 보여 줍니다."}
                {res.signal.date >= new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10) && " 오늘 장이 끝나기 전이면 마지막 봉이 장중 가격이라 장 마감 후 결과와 다를 수 있습니다."}
              </p>
              {res.signal.picks.length === 0 ? <p className="help"><b>전량 현금</b>: 지금은 조건에 맞는 종목이 없거나 시장 필터에 걸렸습니다.</p> : (
                <div className="tablewrap">
                  <table>
                    <thead><tr><th className="l">종목</th><th>목표 비중</th><th>기준일 종가</th><th>백테스트 초기 자금 기준 금액</th></tr></thead>
                    <tbody>
                      {res.signal.picks.map((p) => (
                        <tr key={p.ticker}>
                          <td className="l">{names[p.ticker] ?? p.ticker} <span className="help">{p.ticker}</span></td>
                          <td>{pct(p.weight)}</td>
                          <td>{Math.round(p.close).toLocaleString()}</td>
                          <td>{won(s.initial * p.weight)}</td>
                        </tr>
                      ))}
                      <tr><td className="l">현금</td><td>{pct(Math.max(0, 1 - res.signal.picks.reduce((a, p) => a + p.weight, 0)))}</td><td></td><td></td></tr>
                    </tbody>
                  </table>
                </div>
              )}
              <div className="btns" style={{ marginTop: 10 }}>
                <button className="primary" onClick={() => {
                  const sig: SavedSignal = {
                    date: res.signal!.date, label: title || label, savedAt: new Date().toISOString(),
                    picks: res.signal!.picks.map((p) => ({ ...p, name: names[p.ticker] ?? p.ticker })),
                  };
                  try { localStorage.setItem(SIGNAL_KEY, JSON.stringify(sig)); } catch { /* 저장 불가 환경 */ }
                  window.location.href = "/trade#plan";
                }}>이 비중으로 주문 목록 만들기 →</button>
              </div>
              <p className="help">주문 화면에서 내 잔고와 비교해 살 종목·팔 종목 목록을 만듭니다. 목록을 확인하고 실행을 눌러야 주문이 나갑니다. 과거 성과가 미래 수익을 보장하지 않습니다.</p>
            </>
          )
        )}

        {tab === "annual" && (
          <>
            <div className="legend">
              <span><i style={{ background: c.s1, height: 8 }} />전략</span>
              {hasBench && <span><i style={{ background: c.s2, height: 8 }} />KOSPI</span>}
              <span><i className="dash" />30% 목표</span>
            </div>
            <div style={{ height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={annual} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2}>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <XAxis dataKey="year" tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} />
                  <YAxis tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} width={48} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                  <Tooltip content={<Tip fmt={(v: number) => `${v.toFixed(1)}%`} />} cursor={{ fill: c.grid }} />
                  <ReferenceLine y={0} stroke={c.t3} />
                  <ReferenceLine y={30} stroke={c.t3} strokeDasharray="4 3" />
                  <Bar dataKey="strategy" name="전략" fill={c.s1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  {hasBench && <Bar dataKey="kospi" name="KOSPI" fill={c.s2} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>연도</th><th>전략</th><th>KOSPI</th><th>초과수익</th><th>30% 달성</th></tr></thead>
                <tbody>
                  {s.annual.map((a) => (
                    <tr key={a.year}>
                      <td>{a.year}</td><td>{pct(a.ret)}</td><td>{pct(a.bench)}</td>
                      <td>{a.bench == null ? "–" : pct(a.ret - a.bench)}</td>
                      <td>{a.ret >= TARGET_CAGR ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="help">
              기간 {s.start} ~ {s.end} · 최종자산 {won(s.final)} (시작 {won(s.initial)}) · 매매 {s.nTrades}건 · 비용(수수료+세금) {won(s.totalFees)}
            </p>
          </>
        )}

        {tab === "trades" && (
          <>
            <div className="btns" style={{ marginBottom: 8 }}>
              <button onClick={download}>CSV 다운로드</button>
              <span className="help">최근 300건 표시 · 청산 {sells.length}건</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>날짜</th><th className="l">종목</th><th>구분</th><th>수량</th><th>체결가</th><th>비용</th><th>손익</th><th>수익률</th><th className="l">사유</th></tr></thead>
                <tbody>
                  {res.trades.slice(-300).reverse().map((t, k) => (
                    <tr key={k}>
                      <td>{t.date}</td>
                      <td className="l">{names[t.ticker] ?? t.ticker} <span className="help">{t.ticker}</span></td>
                      <td>{t.side === "BUY" ? "매수" : "매도"}</td>
                      <td>{t.qty.toLocaleString()}</td>
                      <td>{Math.round(t.price).toLocaleString()}</td>
                      <td>{Math.round(t.fee).toLocaleString()}</td>
                      <td>{t.pnl == null ? "" : Math.round(t.pnl).toLocaleString()}</td>
                      <td>{t.ret == null ? "" : pct(t.ret)}</td>
                      <td className="l">{{ rebalance: "리밸런싱", stop_loss: "손절", take_profit: "익절" }[t.reason]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "positions" && (
          <div className="tablewrap">
            {res.finalPositions.length === 0 ? <p className="help">마지막 날 기준 보유 종목이 없습니다 (전량 현금).</p> : (
              <table>
                <thead><tr><th className="l">종목</th><th>수량</th><th>평단</th><th>평가금액</th><th>비중</th></tr></thead>
                <tbody>
                  {res.finalPositions.sort((a, b) => b.value - a.value).map((p) => (
                    <tr key={p.ticker}>
                      <td className="l">{names[p.ticker] ?? p.ticker} <span className="help">{p.ticker}</span></td>
                      <td>{p.qty.toLocaleString()}</td>
                      <td>{Math.round(p.avgPrice).toLocaleString()}</td>
                      <td>{won(p.value)}</td>
                      <td>{pct(p.value / s.final)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
