"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { drawdown, perf, type Summary } from "@/lib/engine/metrics";
import type { BacktestResult } from "@/lib/engine/types";
import { rollingReturns, splitStats, type SensitivityResult } from "@/lib/engine/validate";
import { SIGNAL_KEY, type SavedSignal } from "@/lib/trade/plan";
import CycleStatusCard from "./CycleStatusCard";

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

export default function Results({ res, s, names, label, title, onSensitivity }: {
  res: BacktestResult; s: Summary; names: Record<string, string>; label: string; title?: string;
  onSensitivity?: (onProgress: (done: number, total: number) => void) => Promise<SensitivityResult>;
}) {
  const c = useColors();
  const TARGET_CAGR = s.target;
  const T = `${+(s.target * 100).toFixed(1)}%`; // 목표 표시용
  const [tab, setTab] = useState<"signal" | "check" | "annual" | "trades" | "positions">("annual");
  const [log, setLog] = useState(true);

  const series = useMemo(() => {
    const e0 = res.equity[0];
    const b0 = e0?.benchmark;
    const dd = drawdown(res.equity.map(perf));
    const t0 = Date.parse(e0.date);
    return res.equity.map((e, k) => ({
      date: e.date,
      strategy: (perf(e) / perf(e0)) * 100,
      kospi: b0 && e.benchmark ? (e.benchmark / b0) * 100 : null,
      target: 100 * (1 + TARGET_CAGR) ** ((Date.parse(e.date) - t0) / (365.25 * 864e5)),
      dd: dd[k] * 100,
    }));
  }, [res]);

  const split = useMemo(() => splitStats(res.equity), [res]);
  const rolling = useMemo(() => rollingReturns(res.equity.map(perf), 252, s.target), [res, s.target]);
  const [sens, setSens] = useState<SensitivityResult | null>(null);
  const [sensBusy, setSensBusy] = useState("");
  const [sensErr, setSensErr] = useState("");
  useEffect(() => { setSens(null); setSensErr(""); }, [res]);
  const runSens = async () => {
    if (!onSensitivity) return;
    setSensErr(""); setSensBusy("계산 중…");
    try { setSens(await onSensitivity((d, t) => setSensBusy(`계산 중… ${d + 1}/${t}`))); }
    catch (e) { setSensErr((e as Error).message); } finally { setSensBusy(""); }
  };

  const hasBench = s.bench != null;
  const annual = s.annual.map((a) => ({ year: String(a.year), strategy: a.ret * 100, kospi: a.bench == null ? null : a.bench * 100 }));
  const sells = res.trades.filter((t) => t.side === "SELL");

  const download = () => {
    const head = "date,ticker,name,side,qty,price,fee,pnl,ret,reason,note";
    const rows = res.trades.map((t) => [t.date, t.ticker, names[t.ticker] ?? "", t.side, t.qty, t.price.toFixed(0),
      t.fee.toFixed(0), t.pnl?.toFixed(0) ?? "", t.ret?.toFixed(4) ?? "", t.reason, (t.note ?? "").replace(/,/g, " ")].join(","));
    const blob = new Blob(["﻿" + [head, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${label}.csv`;
    a.click();
  };

  return (
    <div className="stack">
      <CycleStatusCard res={res} names={names} />
      <div className="kpis">
        <div className="kpi">
          <div className="k">연평균 수익률 (CAGR)</div>
          <div className="v">{pct(s.cagr)}</div>
          <div className={`badge ${s.meetsTarget ? "ok" : "no"}`}>{s.meetsTarget ? `✓ 목표 ${T} 달성` : `✕ 목표 ${T} 미달`}</div>
        </div>
        <div className="kpi"><div className="k">최대 낙폭 (MDD)</div><div className="v">{pct(s.mdd)}</div>
          <div className={`badge ${s.withinDrawdown ? "ok" : "no"}`}>{s.withinDrawdown ? `✓ 기준 -${+(s.maxDrawdown * 100).toFixed(1)}% 이내` : `✕ 기준 -${+(s.maxDrawdown * 100).toFixed(1)}% 초과`}</div>
          <div className="s">KOSPI {pct(s.bench?.mdd)}</div></div>
        <div className="kpi"><div className="k">누적 수익률</div><div className="v">{pct(s.totalReturn)}</div>
          <div className="s">KOSPI {pct(s.bench?.totalReturn)}</div></div>
        <div className="kpi"><div className="k">샤프 / 소르티노</div><div className="v">{num(s.sharpe)}</div>
          <div className="s">소르티노 {num(s.sortino)}</div></div>
        <div className="kpi"><div className="k">승률 (청산 {s.nSells}건)</div><div className="v">{pct(s.winRate, 0)}</div>
          <div className="s">평균 {pct(s.avgTradeRet)}</div></div>
        <div className="kpi"><div className="k">연 {T} 달성 연도</div><div className="v">{s.yearsHitTarget} / {s.annual.length}</div>
          <div className="s">평균 투자비중 {pct(s.exposure, 0)}</div></div>
      </div>

      {s.deposits > 0 && (
        <div className="notice">
          <b>매달 추가 입금 포함</b>: 넣은 돈 {won(s.contributed)} (시작 {won(s.initial)} + 추가 {won(s.deposits)}) → 최종자산 {won(s.final)}, 손익 {won(s.final - s.contributed)}.
          {" "}수익률·낙폭·그래프는 입금으로 늘어난 금액을 빼고 계산한 값(펀드 기준가처럼 계산한 시간가중 수익률)입니다.
        </div>
      )}

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
          <span><i className="dash" />연 {T} 목표</span>
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
              <Line dataKey="target" name={`연 ${T} 목표`} stroke={c.t3} strokeDasharray="4 3" dot={false} strokeWidth={1.5} isAnimationActive={false} />
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
          <button className={tab === "check" ? "on" : ""} onClick={() => setTab("check")}>검증</button>
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

        {tab === "check" && (
          <>
            <p className="help">파라미터를 이리저리 바꾸다 보면 과거에만 잘 맞는 조합을 고르기 쉽습니다(과최적화). 아래 세 가지가 모두 괜찮아야 믿을 만합니다.</p>

            <h3>1. 앞 기간과 뒤 기간</h3>
            {!split ? <p className="help">기간이 짧아 나눌 수 없습니다(각 구간 60영업일 이상 필요).</p> : (
              <>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th className="l">구간</th><th className="l">기간</th><th>CAGR</th><th>MDD</th><th>샤프</th>{hasBench && <th>KOSPI CAGR</th>}<th className="l">목표 {T}</th></tr></thead>
                    <tbody>
                      {([["앞 70% (고르는 구간)", split.first], ["뒤 30% (확인 구간)", split.second]] as const).map(([name, x]) => (
                        <tr key={name}>
                          <td className="l">{name}</td><td className="l">{x.start} ~ {x.end}</td>
                          <td>{pct(x.cagr)}</td><td>{pct(x.mdd)}</td><td>{num(x.sharpe)}</td>
                          {hasBench && <td>{pct(x.bench?.cagr)}</td>}
                          <td className="l"><span className={`badge ${x.cagr >= TARGET_CAGR ? "ok" : "no"}`}>{x.cagr >= TARGET_CAGR ? "달성" : "미달"}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="help">
                  파라미터는 앞 구간 성과만 보고 정하고, 뒤 구간은 마지막에 한 번만 확인하세요. 뒤 구간을 보면서 계속 고치면 뒤 구간도 맞춘 것이 됩니다.
                  {split.second.cagr < split.first.cagr * 0.5 && split.first.cagr > 0 && <b> 뒤 구간 수익률이 앞 구간의 절반에 못 미칩니다. 과최적화를 의심하세요.</b>}
                </p>
              </>
            )}

            <h3>2. 아무 날에 시작해 1년 보유했다면</h3>
            {!rolling ? <p className="help">기간이 1년 남짓보다 짧아 계산할 수 없습니다.</p> : (
              <div className="kpis">
                <div className="kpi"><div className="k">{T} 이상이었던 비율</div><div className="v">{pct(rolling.hit, 0)}</div><div className="s">{rolling.n.toLocaleString()}개 구간</div></div>
                <div className="kpi"><div className="k">수익이 난 비율</div><div className="v">{pct(rolling.positive, 0)}</div></div>
                <div className="kpi"><div className="k">가장 나빴던 1년</div><div className="v">{pct(rolling.worst)}</div></div>
                <div className="kpi"><div className="k">중간값</div><div className="v">{pct(rolling.median)}</div><div className="s">가장 좋았던 1년 {pct(rolling.best)}</div></div>
              </div>
            )}

            <h3>3. 파라미터를 조금 바꿔도 비슷한가</h3>
            <p className="help">숫자 파라미터를 하나씩 20% 줄이고 늘려서 다시 돌립니다. 조금만 바꿔도 수익률이 크게 떨어지면 우연히 맞은 값일 가능성이 큽니다.</p>
            {onSensitivity && <button disabled={!!sensBusy} onClick={runSens}>{sensBusy || "파라미터 민감도 검사"}</button>}
            {sensErr && <div className="error" style={{ marginTop: 8 }}>{sensErr}</div>}
            {sens && (
              <>
                <p className="help" style={{ marginTop: 10 }}>
                  지금 설정 CAGR <b>{pct(sens.base.cagr)}</b> · 바꾼 {sens.rows.length}개 조합은 <b>{pct(sens.worst)} ~ {pct(sens.best)}</b> · 그중 {T} 이상 {pct(sens.hit, 0)}
                  {sens.base.cagr > 0 && sens.worst < sens.base.cagr * 0.5 && <b> · 일부 조합에서 수익률이 절반 아래로 떨어집니다. 값에 민감한 전략입니다.</b>}
                </p>
                <div className="tablewrap" style={{ maxHeight: 320 }}>
                  <table>
                    <thead><tr><th className="l">바꾼 값</th><th>CAGR</th><th>지금 대비</th><th>MDD</th></tr></thead>
                    <tbody>
                      {sens.rows.map((r) => (
                        <tr key={r.label}>
                          <td className="l">{r.label}</td><td>{pct(r.cagr)}</td>
                          <td style={{ color: r.cagr >= sens.base.cagr ? "var(--good)" : "var(--bad)" }}>{Number.isFinite(r.cagr) ? `${((r.cagr - sens.base.cagr) * 100).toFixed(1)}%p` : "–"}</td>
                          <td>{pct(r.mdd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {tab === "annual" && (
          <>
            <div className="legend">
              <span><i style={{ background: c.s1, height: 8 }} />전략</span>
              {hasBench && <span><i style={{ background: c.s2, height: 8 }} />KOSPI</span>}
              <span><i className="dash" />{T} 목표</span>
            </div>
            <div style={{ height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={annual} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2}>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <XAxis dataKey="year" tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} />
                  <YAxis tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} width={48} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                  <Tooltip content={<Tip fmt={(v: number) => `${v.toFixed(1)}%`} />} cursor={{ fill: c.grid }} />
                  <ReferenceLine y={0} stroke={c.t3} />
                  <ReferenceLine y={s.target * 100} stroke={c.t3} strokeDasharray="4 3" />
                  <Bar dataKey="strategy" name="전략" fill={c.s1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  {hasBench && <Bar dataKey="kospi" name="KOSPI" fill={c.s2} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>연도</th><th>전략</th><th>KOSPI</th><th>초과수익</th><th>{T} 달성</th></tr></thead>
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
              기간 {s.start} ~ {s.end} · 최종자산 {won(s.final)} ({s.deposits > 0
                ? <>넣은 돈 {won(s.contributed)} = 시작 {won(s.initial)} + 추가 입금 {won(s.deposits)}, 손익 {won(s.final - s.contributed)}</>
                : <>시작 {won(s.initial)}</>}) · 매매 {s.nTrades}건 · 비용(수수료+세금) {won(s.totalFees)}
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
                      <td className="l">{t.note ?? { rebalance: "리밸런싱", stop_loss: "손절", take_profit: "익절", delisted: "상장폐지" }[t.reason]}</td>
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
