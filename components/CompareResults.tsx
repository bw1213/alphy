"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { rollingReturn, weakPeriods } from "@/lib/engine/weak";
import { rebase, useDragZoom, ZoomBar } from "./ChartZoom";
import { bestOf, type CompareReport, type CompareRow } from "@/lib/compare/compare";
import { lossLen, num, pct, Tip, useColors } from "./Results";
import Info from "./Info";

export default function CompareResults({ report, onOpen, onClose }: {
  report: CompareReport;
  onOpen?: (id: string) => void;
  onClose?: () => void;
}) {
  const c = useColors();
  const [log, setLog] = useState(true);
  const palette = [c.s1, c.s3, c.s5, c.s6, c.s7, c.s8];
  const color = (r: CompareRow, k: number) => (r.index ? (r.index === "sp500" ? c.s4 : c.s2) : palette[k % palette.length]);
  const { rows, indices: ix } = report;
  const best = useMemo(() => bestOf(rows), [rows]);

  const [view, setView] = useState<"cum" | "roll">("cum");
  const series = useMemo(() => {
    const p100 = (v: number | null) => (v == null ? null : v * 100);
    const rr = rows.map((r) => rollingReturn(report.dates, r.values));
    const ir = ix.map((r) => rollingReturn(report.dates, r.values));
    return report.dates.map((d, k) => ({
      date: d,
      ...Object.fromEntries(rows.map((r, i) => [`s${i}`, r.values[k]])),
      ...Object.fromEntries(ix.map((r) => [r.id, r.values[k]])),
      ...Object.fromEntries(rows.map((r, i) => [`d${i}`, r.dd[k]])),
      ...Object.fromEntries(rows.map((r, i) => [`r${i}`, p100(rr[i][k])])),
      ...Object.fromEntries(ix.map((r, i) => [`r_${r.id}`, p100(ir[i][k])])),
    }));
  }, [report, rows, ix]);
  const zm = useDragZoom(report.dates);
  const shown = useMemo(() => {
    const part = zm.slice(series);
    return zm.zoom ? rebase(part, [...rows.map((_, i) => `s${i}`), ...ix.map((r) => r.id)]) : part;
  }, [series, zm.zoom, rows, ix]);
  const worst = useMemo(() => rows.map((r) => weakPeriods(report.dates, r.values.map((v) => v ?? NaN), 1, 0)[0] ?? null), [rows, report]);
  const worstYear = useMemo(() => rows.map((r) => {
    const rr = rollingReturn(report.dates, r.values).filter((v): v is number => v != null);
    return rr.length ? Math.min(...rr) : null;
  }), [rows, report]);

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
        <Info>모든 전략을 지금 화면의 기간·자금·비용으로 돌린 뒤, 모두 값이 있는 같은 기간으로 맞춰 계산합니다. 내 전략은 저장된 종목, 기본 전략은 지금 화면의 종목을 씁니다. 지수는 배당 제외 가격 지수(원화)입니다. 표의 굵은 글씨가 항목별 1등입니다. 이름을 누르면 그 전략을 열고, 떨어진 구간을 누르면 그래프를 확대합니다.</Info>
      </p>
      {report.errors.length > 0 && (
        <div className="error" style={{ marginTop: 8 }}>
          {report.errors.map((e) => <div key={e.name}><b>{e.name}</b>: {e.error}</div>)}
        </div>
      )}

      <div className="tablewrap" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th className="l">전략</th><th>연평균</th><th>MDD</th><th className="l">가장 크게 떨어진 구간</th><th>최장 손실</th><th title="아무 날에 시작해 1년 보유했을 때 가장 나빴던 수익률">최악의 1년</th><th>누적</th><th>샤프</th></tr></thead>
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
                <td className="l">{worst[i] ? <button className="link" title="이 구간 확대" onClick={() => zm.focus(worst[i]!.i0, worst[i]!.i1)}>{worst[i]!.peak.slice(0, 7)} → {worst[i]!.trough.slice(0, 7)}{!worst[i]!.recovered && " (미회복)"}</button> : "–"}</td>
                <td><B on={best.lossDays === r.id}>{lossLen(r.stats.lossDays)}</B></td>
                <td style={{ color: worstYear[i] != null && worstYear[i]! < 0 ? "var(--bad)" : undefined }}>{pct(worstYear[i])}</td>
                <td><B on={best.totalReturn === r.id}>{pct(r.stats.totalReturn, 0)}</B></td>
                <td><B on={best.sharpe === r.id}>{num(r.stats.sharpe)}</B></td>
              </tr>
            ))}
            {ix.map((r) => (
              <tr key={r.id} style={{ color: "var(--text-3)" }}>
                <td className="l"><Dot col={color(r, 0)} dash />{r.name}{r.ownStart && r.ownStart > report.start && <span className="help"> ({r.ownStart}~)</span>}</td>
                <td>{pct(r.stats.cagr)}</td><td>{pct(r.stats.mdd)}</td><td></td><td>{lossLen(r.stats.lossDays)}</td><td></td>
                <td>{pct(r.stats.totalReturn, 0)}</td><td>{num(r.stats.sharpe)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <h3 style={{ margin: 0 }}>{view === "cum" ? "자산 추이 (시작 = 100)" : "1년 수익률 (%)"}{view === "roll" && <Info>날마다 그날까지 1년 수익률입니다. 0 아래(빨간 바탕)가 1년 손실 구간입니다.</Info>}</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div className="seg" style={{ width: 160 }}>
            <button className={view === "cum" ? "on" : ""} onClick={() => setView("cum")}>누적</button>
            <button className={view === "roll" ? "on" : ""} onClick={() => setView("roll")}>1년 수익률</button>
          </div>
          {view === "cum" && (
            <div className="seg" style={{ width: 110 }}>
              <button className={log ? "on" : ""} onClick={() => setLog(true)}>로그</button>
              <button className={!log ? "on" : ""} onClick={() => setLog(false)}>선형</button>
            </div>
          )}
        </div>
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        {rows.map((r, i) => <span key={r.id}><Dot col={color(r, i)} />{r.name}</span>)}
        {ix.map((r) => <span key={r.id}><Dot col={color(r, 0)} dash />{r.name}</span>)}
      </div>
      <ZoomBar dates={report.dates} zoom={zm.zoom} onReset={() => zm.setZoom(null)} />
      <div style={{ height: 340, userSelect: "none" }}>
        <ResponsiveContainer>
          <LineChart data={shown} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} {...zm.handlers}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} minTickGap={50} tickFormatter={(d: string) => (zm.zoom ? d.slice(2) : d.slice(0, 7))} />
            <YAxis scale={view === "cum" && log ? "log" : "linear"} domain={["auto", "auto"]} tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} width={52} allowDataOverflow tickFormatter={(v: number) => v.toFixed(0)} />
            <Tooltip content={<Tip fmt={(v: number) => (view === "roll" ? `${v.toFixed(1)}%` : v.toFixed(1))} />} />
            {zm.sel && <ReferenceArea x1={zm.sel[0]} x2={zm.sel[1]} fill={c.s1} fillOpacity={0.12} stroke="none" />}
            {view === "roll" && <ReferenceArea y1={-1000} y2={0} fill={c.bad} fillOpacity={0.06} stroke="none" ifOverflow="hidden" />}
            {view === "roll" && <ReferenceLine y={0} stroke={c.t3} />}
            {ix.map((r) => <Line key={r.id} dataKey={view === "cum" ? r.id : `r_${r.id}`} name={r.name} stroke={color(r, 0)} strokeDasharray="5 3" dot={false} strokeWidth={1.3} isAnimationActive={false} />)}
            {rows.map((r, i) => <Line key={r.id} dataKey={view === "cum" ? `s${i}` : `r${i}`} name={r.name} stroke={color(r, i)} dot={false} strokeWidth={2} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3>낙폭 (%)</h3>
      <div style={{ height: 150, userSelect: "none" }}>
        <ResponsiveContainer>
          <LineChart data={shown} margin={{ top: 0, right: 12, bottom: 0, left: 0 }} {...zm.handlers}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="date" hide />
            <YAxis tick={{ fill: c.t2, fontSize: 11 }} stroke={c.grid} width={52} tickFormatter={(v: number) => v.toFixed(0)} />
            <Tooltip content={<Tip fmt={(v: number) => `${v.toFixed(1)}%`} />} />
            {zm.sel && <ReferenceArea x1={zm.sel[0]} x2={zm.sel[1]} fill={c.s1} fillOpacity={0.12} stroke="none" />}
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
