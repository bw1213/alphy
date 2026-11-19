"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bestOf, type CompareReport, type CompareRow } from "@/lib/compare/compare";
import { lossLen, num, pct, Tip, useColors } from "./Results";
import Info from "./Info";

/** 전략 비교 결과: 수익 곡선 겹쳐 보기, 지표 표, 연도별 수익률 (S&P 500·KOSPI 함께) */
export default function CompareResults({ report, onOpen, onClose }: {
  report: CompareReport;
  /** 전략 이름을 누르면 그 전략을 위 화면에 불러옴 */
  onOpen?: (id: string) => void;
  onClose?: () => void;
}) {
  const c = useColors();
  const [log, setLog] = useState(true);
  const palette = [c.s1, c.s3, c.s5, c.s6, c.s7, c.s8];
  const color = (r: CompareRow, k: number) => (r.index ? (r.index === "sp500" ? c.s4 : c.s2) : palette[k % palette.length]);
  const { rows, indices: ix } = report;
  const best = useMemo(() => bestOf(rows), [rows]);

  const series = useMemo(() => report.dates.map((d, k) => ({
    date: d,
    ...Object.fromEntries(rows.map((r, i) => [`s${i}`, r.values[k]])),
    ...Object.fromEntries(ix.map((r) => [r.id, r.values[k]])),
    ...Object.fromEntries(rows.map((r, i) => [`d${i}`, r.dd[k]])),
  })), [report, rows, ix]);

  const Dot = ({ col, dash }: { col: string; dash?: boolean }) => (
    <i style={{ display: "inline-block", width: 14, height: 0, borderTop: `${dash ? "2px dashed" : "2px solid"} ${col}`, verticalAlign: "middle", marginRight: 6 }} />
  );
  const B = ({ on, children }: { on: boolean; children: React.ReactNode }) => (on ? <b>{children}</b> : <>{children}</>);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2>전략 비교 ({rows.length}개)</h2>
        {onClose && <button className="link" onClick={onClose}>닫기</button>}
      </div>
      <p className="help">
        {report.start} ~ {report.end}
        {report.lateBy && <> · 같은 기간으로 맞추느라 <b>{report.lateBy}</b> 시작일부터 비교합니다</>}
        <Info>모든 전략을 지금 화면의 기간·자금·비용으로 돌린 뒤, 모두 값이 있는 같은 기간으로 맞춰 계산합니다. 내 전략은 저장된 종목, 기본 전략은 지금 화면의 종목을 씁니다. 지수는 배당 제외 가격 지수(원화)입니다.</Info>
      </p>
      {report.errors.length > 0 && (
        <div className="error" style={{ marginTop: 8 }}>
          {report.errors.map((e) => <div key={e.name}><b>{e.name}</b>: {e.error}</div>)}
        </div>
      )}

      <div className="tablewrap" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th className="l">전략</th><th>연평균</th><th>MDD</th><th>최장 손실</th><th>누적</th><th>샤프</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td className="l" style={{ whiteSpace: "normal", minWidth: 160 }}>
                  <Dot col={color(r, i)} />
                  {onOpen ? <button className="link" onClick={() => onOpen(r.id)} title="이 전략 열기">{r.name}</button> : r.name}
                  {r.universe && <span className="help" style={{ display: "block" }}>{r.universe}</span>}
                </td>
                <td><B on={best.cagr === r.id}>{pct(r.stats.cagr)}</B></td>
                <td><B on={best.mdd === r.id}>{pct(r.stats.mdd)}</B></td>
                <td><B on={best.lossDays === r.id}>{lossLen(r.stats.lossDays)}</B></td>
                <td><B on={best.totalReturn === r.id}>{pct(r.stats.totalReturn, 0)}</B></td>
                <td><B on={best.sharpe === r.id}>{num(r.stats.sharpe)}</B></td>
              </tr>
            ))}
            {ix.map((r) => (
              <tr key={r.id} style={{ color: "var(--text-3)" }}>
                <td className="l"><Dot col={color(r, 0)} dash />{r.name}{r.ownStart && r.ownStart > report.start && <span className="help"> ({r.ownStart}~)</span>}</td>
                <td>{pct(r.stats.cagr)}</td><td>{pct(r.stats.mdd)}</td><td>{lossLen(r.stats.lossDays)}</td>
                <td>{pct(r.stats.totalReturn, 0)}</td><td>{num(r.stats.sharpe)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="help">굵은 글씨가 항목별 1등입니다. 이름을 누르면 그 전략을 엽니다.</p>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <h3 style={{ margin: 0 }}>자산 추이 (시작 = 100)</h3>
        <div className="seg" style={{ width: 140 }}>
          <button className={log ? "on" : ""} onClick={() => setLog(true)}>로그</button>
          <button className={!log ? "on" : ""} onClick={() => setLog(false)}>선형</button>
        </div>
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        {rows.map((r, i) => <span key={r.id}><Dot col={color(r, i)} />{r.name}</span>)}
        {ix.map((r) => <span key={r.id}><Dot col={color(r, 0)} dash />{r.name}</span>)}
      </div>
      <div style={{ height: 340 }}>
        <ResponsiveContainer>
          <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} minTickGap={50} tickFormatter={(d: string) => d.slice(0, 7)} />
            <YAxis scale={log ? "log" : "linear"} domain={["auto", "auto"]} tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} width={52} allowDataOverflow tickFormatter={(v: number) => v.toFixed(0)} />
            <Tooltip content={<Tip fmt={(v: number) => v.toFixed(1)} />} />
            {ix.map((r) => <Line key={r.id} dataKey={r.id} name={r.name} stroke={color(r, 0)} strokeDasharray="5 3" dot={false} strokeWidth={1.3} isAnimationActive={false} />)}
            {rows.map((r, i) => <Line key={r.id} dataKey={`s${i}`} name={r.name} stroke={color(r, i)} dot={false} strokeWidth={2} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3>낙폭 (%)</h3>
      <div style={{ height: 150 }}>
        <ResponsiveContainer>
          <LineChart data={series} margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="date" hide />
            <YAxis tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} width={52} tickFormatter={(v: number) => v.toFixed(0)} />
            <Tooltip content={<Tip fmt={(v: number) => `${v.toFixed(1)}%`} />} />
            {rows.map((r, i) => <Line key={r.id} dataKey={`d${i}`} name={r.name} stroke={color(r, i)} dot={false} strokeWidth={1.3} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3>연도별 수익률</h3>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="l">연도</th>
              {[...rows, ...ix].map((r) => (
                <th key={r.id} style={{ whiteSpace: "normal", maxWidth: 120, verticalAlign: "bottom" }}>
                  <Dot col={color(r, rows.indexOf(r))} dash={!!r.index} />{r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...report.years].reverse().map((y) => {
              const vals = rows.map((r) => r.annual.get(y));
              const top = Math.max(...vals.filter((v): v is number => v != null && Number.isFinite(v)));
              return (
                <tr key={y}>
                  <td className="l">{y}{y === report.years[0] && report.start.slice(5) > "01-10" ? <span className="help"> ({report.start.slice(5)}~)</span> : null}</td>
                  {rows.map((r, i) => {
                    const v = vals[i];
                    return <td key={r.id} style={{ color: v != null && v < 0 ? "var(--bad)" : undefined }}><B on={rows.length > 1 && v === top}>{pct(v)}</B></td>;
                  })}
                  {ix.map((r) => { const v = r.annual.get(y); return <td key={r.id} style={{ color: "var(--text-3)" }}>{pct(v)}</td>; })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
