"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { accountReturns, type Flow, type ReturnPoint } from "@/lib/manual/returns";
import type { Snapshot } from "@/lib/manual/value";
import Info from "@/components/Info";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 계좌 하나의 누적 수익률 (입출금 뺀 값). 입출금 넣기·지우기는 전체 계좌 화면에서 */
export default function AccountReturn({ id, reload = 0 }: { id: string; reload?: number }) {
  const [rows, setRows] = useState<ReturnPoint[] | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  useEffect(() => {
    if (!id) return;
    fetch("/api/dashboard", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const pts: Snapshot[] = j?.points?.[id] ?? [];
      const fl: Flow[] = j?.flows?.[id] ?? [];
      setFlows(fl);
      setRows(accountReturns(pts, fl));
    }).catch(() => setRows([]));
  }, [id, reload]);
  const last = rows?.at(-1);
  const net = flows.reduce((s, f) => s + f.amount, 0);
  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>누적 수익률
        <Info>입금·출금을 뺀 시간가중 수익률입니다. 입출금은 <a href="/dashboard">전체 계좌</a> 화면 아래에서 넣고 지웁니다.</Info>
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
    </div>
  );
}
