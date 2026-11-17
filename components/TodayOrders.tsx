"use client";

import { useCallback, useState } from "react";
import type { DayOrder } from "@/lib/kis/orders";

const won = (n: number) => Math.round(n).toLocaleString("ko-KR");
const tm = (t: string) => (t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t);

/** 오늘 주문·체결 내역과 미체결 취소 (주문·잔고 화면) */
export default function TodayOrders({ loggedIn, onLog }: { loggedIn: boolean; onLog?: (l: string) => void }) {
  const [list, setList] = useState<DayOrder[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy("load"); setError("");
    try {
      const r = await fetch("/api/kis/orders", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setList(j.orders);
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }, []);

  const cancel = async (o: DayOrder) => {
    setBusy(o.orderNo); setError("");
    try {
      const r = await fetch("/api/kis/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderNo: o.orderNo, orgNo: o.orgNo }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      onLog?.(`${new Date().toLocaleTimeString("ko-KR")} 취소 ${o.name} ${o.openQty}주 (주문번호 ${o.orderNo}) ${j.message ?? ""}`);
      await load();
    } catch (e) { setError((e as Error).message); setBusy(""); }
  };

  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>오늘 주문·체결
        <button style={{ marginLeft: "auto" }} disabled={!!busy || !loggedIn} onClick={load}>{busy === "load" ? "조회 중…" : "조회"}</button>
      </h2>
      {!list ? <p className="help">조회 버튼을 누르세요.</p> : (
        <div className="tablewrap"><table>
          <thead><tr><th>시각</th><th>구분</th><th>종목</th><th>주문</th><th>체결</th><th>미체결</th><th></th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={7} className="empty">오늘 주문이 없습니다</td></tr>}
            {list.map((o) => (
              <tr key={o.orderNo}>
                <td>{tm(o.time)}</td>
                <td style={{ color: o.side === "buy" ? "var(--bad)" : "var(--accent)" }}>{o.side === "buy" ? "매수" : "매도"}{o.cancelled ? " (취소)" : ""}</td>
                <td>{o.name} <span className="help">{o.code}</span></td>
                <td>{won(o.qty)}주{o.price > 0 ? ` · ${won(o.price)}원` : " · 시장가"}</td>
                <td>{o.filledQty > 0 ? `${won(o.filledQty)}주 · ${won(o.avgPrice)}원` : "-"}</td>
                <td>{o.openQty > 0 ? `${won(o.openQty)}주` : "-"}</td>
                <td>{o.openQty > 0 && !o.cancelled && <button disabled={!!busy} onClick={() => cancel(o)}>{busy === o.orderNo ? "취소 중…" : "취소"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
