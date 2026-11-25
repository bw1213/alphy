"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { accountReturns, annualized, maxDrawdown, moneySummary, moneyWeighted, yearlyReturns, type Flow, type ReturnPoint } from "@/lib/manual/returns";
import type { Snapshot } from "@/lib/manual/value";
import Info from "@/components/Info";
import FlowEditor from "@/components/accounts/FlowEditor";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 계좌 하나의 누적 수익률 (입출금 뺀 값)과 그 계좌 입금·출금 기록. onChange 는 입출금으로 예수금이 바뀌었을 때 */
export default function AccountReturn({ id, reload = 0, onChange }: { id: string; reload?: number; onChange?: () => unknown }) {
  const [rows, setRows] = useState<ReturnPoint[] | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [today, setToday] = useState("");
  const [mine, setMine] = useState(0);
  const [start, setStart] = useState("");
  const [startForm, setStartForm] = useState<string | null>(null);
  const [startErr, setStartErr] = useState("");
  useEffect(() => {
    if (!id) return;
    fetch("/api/dashboard", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const pts: Snapshot[] = j?.points?.[id] ?? [];
      const fl: Flow[] = j?.flows?.[id] ?? [];
      setFlows(fl);
      setToday(j?.today ?? "");
      setStart(j?.starts?.[id] ?? "");
      setRows(accountReturns(pts, j?.retFlows?.[id] ?? fl));
    }).catch(() => setRows([]));
  }, [id, reload, mine]);
  const [showFlows, setShowFlows] = useState(false);
  const saveStart = async (date: string | null) => {
    setStartErr("");
    const r = await fetch("/api/dashboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retStart", accountId: id, date }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setStartErr(j.error ?? "저장하지 못했습니다."); return; }
    setStartForm(null);
    setMine((k) => k + 1);
  };
  const last = rows?.at(-1);
  const cagr = rows ? annualized(rows) : null;
  const mwr = rows ? moneyWeighted(rows) : null;
  const sum = rows ? moneySummary(rows) : null;
  const years = rows && rows.length > 1 ? yearlyReturns(rows) : [];
  const mdd = rows && rows.length > 1 ? maxDrawdown(rows) : 0;
  const color = (v: number) => (v >= 0 ? "var(--bad)" : "var(--accent)");
  const net = flows.reduce((s, f) => s + f.amount, 0);
  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>누적 수익률
        <Info>입금·출금을 뺀 시간가중 수익률입니다. 아래 &quot;입금·출금&quot;에서 넣고 고치고 지웁니다. 수동 계좌는 예수금도 함께 바뀌고, 지난 날짜로 넣으면 그날부터 그 돈이 있었던 것으로 기록을 고칩니다. 앱이 기록하기 전 기간은 이 계좌의 &quot;과거 기록&quot;을 넣으면 함께 계산합니다. 연평균은 1년이 넘으면, 금액가중(넣은 시점·금액을 반영한 연 수익률)은 한 달이 넘으면 보여 줍니다.</Info>
        {last && rows!.length > 1 && <span style={{ marginLeft: "auto", fontWeight: 700, color: last.ret >= 0 ? "var(--bad)" : "var(--accent)" }}>{pct(last.ret)}</span>}
      </h2>
      {!rows ? <p className="help">불러오는 중…</p> : rows.length < 2 ? <p className="help">기록이 이틀 이상 쌓이면 계산합니다.</p> : (
        <>
          <p className="help" style={{ marginTop: 0 }}>{rows[0].date}부터{start ? " (시작일 지정)" : ""}{flows.length ? ` · 앱 입출금 ${flows.length}건 (순 ${net >= 0 ? "입금" : "출금"} ${won(Math.abs(net))}) 뺌` : ""}</p>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 120px), 1fr))", margin: "6px 0" }}>
            {cagr != null && <div className="kpi"><div className="k">연평균</div><div className="v" style={{ fontSize: 18, color: color(cagr) }}>{pct(cagr)}</div></div>}
            {mwr != null && <div className="kpi"><div className="k">금액가중 (연)</div><div className="v" style={{ fontSize: 18, color: color(mwr) }}>{pct(mwr)}</div></div>}
            {sum && <div className="kpi"><div className="k">손익 금액</div><div className="v" style={{ fontSize: 18, color: color(sum.profit) }}>{sum.profit >= 0 ? "+" : "−"}{won(Math.abs(sum.profit))}</div><div className="s">넣은 돈 {won(sum.invested)}</div></div>}
            <div className="kpi"><div className="k">최대 낙폭</div><div className="v" style={{ fontSize: 18 }}>{mdd.toFixed(1)}%</div></div>
          </div>
          <div style={{ height: 160 }}>
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={40} tickFormatter={(d: string) => (rows[0].date.slice(0, 4) !== rows.at(-1)!.date.slice(0, 4) ? d.slice(2, 7) : d.slice(5))} />
                <YAxis tick={{ fontSize: 11 }} width={44} domain={["auto", "auto"]} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <ReferenceLine y={0} stroke="var(--text-3)" />
                <Tooltip formatter={(v) => pct(Number(v))} labelStyle={{ color: "var(--text)" }} />
                <Line dataKey="ret" name="누적 수익률" stroke="var(--accent)" strokeWidth={2} dot={rows.length < 3 ? { r: 4 } : false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      {years.length > 1 && (
        <div className="tablewrap" style={{ marginTop: 6 }}><table>
          <thead><tr><th>연도</th>{years.map((y) => <th key={y.year} style={{ textAlign: "right" }}>{y.year}</th>)}</tr></thead>
          <tbody><tr><td>수익률</td>{years.map((y) => <td key={y.year} title={`${y.from} ~ ${y.to}`} style={{ textAlign: "right", fontWeight: 600, color: color(y.ret) }}>{pct(y.ret)}</td>)}</tr></tbody>
        </table></div>
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button style={{ width: "auto", padding: "4px 10px" }} onClick={() => setShowFlows((v) => !v)}>입금·출금 {flows.length ? `${flows.length}건 ` : ""}{showFlows ? "닫기" : "보기·넣기"}</button>
        <button style={{ width: "auto", padding: "4px 10px" }} onClick={() => { setStartErr(""); setStartForm(startForm == null ? start || today : null); }}>{startForm != null ? "시작일 닫기" : start ? `시작일 ${start}` : "시작일 바꾸기"}</button>
      </div>
      {startForm != null && (
        <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "end" }}>
          <label className="f" style={{ flex: "1 1 160px" }}>수익률 시작일<input type="date" value={startForm} max={today || undefined} onChange={(e) => setStartForm(e.target.value)} /></label>
          <button className="primary" style={{ width: "auto" }} disabled={!startForm} onClick={() => saveStart(startForm)}>저장</button>
          {start && <button style={{ width: "auto" }} onClick={() => saveStart(null)}>처음부터</button>}
          <Info>이 날짜의 평가액을 출발점으로 삼고, 그 전 기록과 입출금은 수익률에서 뺍니다. 기록 자체는 지우지 않아 언제든 &quot;처음부터&quot;로 되돌릴 수 있습니다. 초기 금액이 잘못 잡혔을 때 바로잡은 날로 정하세요.</Info>
          {startErr && <p className="help" style={{ color: "var(--bad)", margin: 0, flexBasis: "100%" }}>{startErr}</p>}
        </div>
      )}

      {showFlows && today && (
        <div style={{ marginTop: 8 }}>
          <FlowEditor accounts={[{ id, name: "" }]} flows={{ [id]: flows }} today={today} limit={30} onChanged={async () => { if (onChange) await onChange(); else setMine((k) => k + 1); }} />
        </div>
      )}
    </div>
  );
}
