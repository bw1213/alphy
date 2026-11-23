"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { accountReturns, type Flow, type ReturnPoint } from "@/lib/manual/returns";
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
  useEffect(() => {
    if (!id) return;
    fetch("/api/dashboard", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const pts: Snapshot[] = j?.points?.[id] ?? [];
      const fl: Flow[] = j?.flows?.[id] ?? [];
      setFlows(fl);
      setToday(j?.today ?? "");
      setRows(accountReturns(pts, fl));
    }).catch(() => setRows([]));
  }, [id, reload, mine]);
  const [showFlows, setShowFlows] = useState(false);
  const last = rows?.at(-1);
  const net = flows.reduce((s, f) => s + f.amount, 0);
  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>누적 수익률
        <Info>입금·출금을 뺀 시간가중 수익률입니다. 아래 &quot;입금·출금&quot;에서 넣고 고치고 지웁니다. 수동 계좌는 예수금도 함께 바뀌고, 지난 날짜로 넣으면 그날부터 그 돈이 있었던 것으로 기록을 고칩니다.</Info>
        {last && rows!.length > 1 && <span style={{ marginLeft: "auto", fontWeight: 700, color: last.ret >= 0 ? "var(--bad)" : "var(--accent)" }}>{pct(last.ret)}</span>}
      </h2>
      {!rows ? <p className="help">불러오는 중…</p> : rows.length < 2 ? <p className="help">기록이 이틀 이상 쌓이면 계산합니다.</p> : (
        <>
          <p className="help" style={{ marginTop: 0 }}>{rows[0].date}부터{flows.length ? ` · 입출금 ${flows.length}건 (순 ${net >= 0 ? "입금" : "출금"} ${won(Math.abs(net))}) 뺌` : ""}</p>
          <div style={{ height: 160 }}>
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={40} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} width={44} domain={["auto", "auto"]} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <ReferenceLine y={0} stroke="var(--text-3)" />
                <Tooltip formatter={(v) => pct(Number(v))} labelStyle={{ color: "var(--text)" }} />
                <Line dataKey="ret" name="누적 수익률" stroke="var(--accent)" strokeWidth={2} dot={rows.length < 3 ? { r: 4 } : false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <button style={{ width: "auto", padding: "4px 10px" }} onClick={() => setShowFlows((v) => !v)}>입금·출금 {flows.length ? `${flows.length}건 ` : ""}{showFlows ? "닫기" : "보기·넣기"}</button>
      </div>
      {showFlows && today && (
        <div style={{ marginTop: 8 }}>
          <FlowEditor accounts={[{ id, name: "" }]} flows={{ [id]: flows }} today={today} limit={30} onChanged={async () => { if (onChange) await onChange(); else setMine((k) => k + 1); }} />
        </div>
      )}
    </div>
  );
}
