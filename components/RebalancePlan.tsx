"use client";

import { useEffect, useState } from "react";
import type { Balance, OrderResult } from "@/lib/kis/trading";
import { buildPlan, SIGNAL_KEY, type Plan, type SavedSignal } from "@/lib/trade/plan";

const won = (n: number) => Math.round(n).toLocaleString("ko-KR");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** 백테스트 화면에서 보낸 추천 종목(목표 비중)과 실제 잔고를 비교해 주문 목록을 만들고 실행 */
export default function RebalancePlan({ env, loggedIn, onLog, onDone }: {
  env: "real" | "mock"; loggedIn: boolean; onLog: (line: string) => void; onDone: () => void;
}) {
  const [signal, setSignal] = useState<SavedSignal | null>(null);
  const [budget, setBudget] = useState("");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [sellOthers, setSellOthers] = useState(env === "mock");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [state, setState] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem(SIGNAL_KEY) ?? "null"); if (s?.picks) setSignal(s); } catch { /* 없음 */ }
  }, []);
  useEffect(() => { setSellOthers(env === "mock"); }, [env]);

  const make = async () => {
    if (!signal) return;
    setError(""); setPlan(null); setState({}); setConfirming(false);
    try {
      setBusy("잔고 조회 중");
      const r = await fetch("/api/kis/balance", { cache: "no-store" });
      const bal = await r.json();
      if (!r.ok) throw new Error(bal.error ?? `HTTP ${r.status}`);
      const b = bal as Balance;
      const prices: Record<string, number> = {};
      for (const [k, p] of signal.picks.entries()) {
        setBusy(`현재가 조회 중 (${k + 1}/${signal.picks.length})`);
        const q = await fetch(`/api/kis/quote?code=${encodeURIComponent(p.ticker)}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        prices[p.ticker] = q?.price > 0 ? q.price : p.close; // 현재가를 못 받으면 신호일 종가
      }
      let use = Number(budget);
      if (!(use > 0)) { use = Math.floor(b.totalValue * 0.98); setBudget(String(use)); } // 수수료·가격 변동 여유 2%
      const pl = buildPlan({ picks: signal.picks, prices, holdings: b.holdings, budget: use, sellOthers: true });
      setPlan(pl);
      setPicked(new Set(pl.orders.filter((o) => !o.other || sellOthers).map((o) => o.code)));
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };

  const run = async () => {
    if (!plan) return;
    setConfirming(false); setError("");
    const list = plan.orders.filter((o) => picked.has(o.code));
    for (const [k, o] of list.entries()) {
      setBusy(`주문 중 (${k + 1}/${list.length})`);
      setState((s) => ({ ...s, [o.code]: "주문 중…" }));
      try {
        const body = { code: o.code, side: o.side, qty: o.qty, type: orderType, price: orderType === "limit" ? Math.round(o.price) : undefined };
        const r = await fetch("/api/kis/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        const res = j as OrderResult;
        setState((s) => ({ ...s, [o.code]: `✓ 주문번호 ${res.orderNo}` }));
        onLog(`${new Date().toLocaleTimeString("ko-KR")} ${res.env === "mock" ? "[모의]" : "[실전]"} ${o.side === "buy" ? "매수" : "매도"} ${o.code} ${o.qty}주 → 주문번호 ${res.orderNo} ${res.message}`);
      } catch (e) {
        setState((s) => ({ ...s, [o.code]: `✗ ${(e as Error).message}` }));
      }
    }
    setBusy(""); onDone();
  };

  const toggle = (code: string) => setPicked((p) => { const n = new Set(p); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const ageDays = signal ? Math.floor((Date.now() - Date.parse(signal.date)) / 864e5) : 0;
  const chosen = plan?.orders.filter((o) => picked.has(o.code)) ?? [];
  const buy = chosen.filter((o) => o.side === "buy").reduce((s, o) => s + o.amount, 0);
  const sell = chosen.filter((o) => o.side === "sell").reduce((s, o) => s + o.amount, 0);

  return (
    <div className="card" id="plan">
      <h2>전략대로 맞추기</h2>
      {!signal ? (
        <p className="help">아직 받은 추천 종목이 없습니다. <a href="/">백테스트</a>를 실행한 뒤 결과의 <b>추천 종목</b> 탭에서 &quot;이 비중으로 주문 목록 만들기&quot;를 누르세요.</p>
      ) : (
        <>
          <p className="help" style={{ marginTop: -6 }}>
            <b>{signal.label}</b> · {signal.date} 종가 기준 · {signal.picks.length ? `${signal.picks.length}종목` : "전량 현금"}
            {signal.picks.length > 0 && <> ({signal.picks.slice(0, 5).map((p) => p.name || p.ticker).join(", ")}{signal.picks.length > 5 ? " 외" : ""})</>}
          </p>
          {ageDays > 4 && <div className="error" style={{ margin: "8px 0" }}>{ageDays}일 전 신호입니다. 백테스트를 다시 실행해 최신 추천으로 바꾸세요.</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <label className="f">투자금(원)
              <input type="number" min={0} value={budget} placeholder="비우면 총평가의 98%" onChange={(e) => setBudget(e.target.value)} />
            </label>
            <label className="f">주문 방식
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as "limit" | "market")}>
                <option value="limit">지정가 (현재가)</option><option value="market">시장가</option>
              </select>
            </label>
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 8 }}>
            <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={sellOthers} onChange={(e) => {
              setSellOthers(e.target.checked);
              if (plan) setPicked((p) => { const n = new Set(p); for (const o of plan.orders) if (o.other) { if (e.target.checked) n.add(o.code); else n.delete(o.code); } return n; });
            }} />
            추천에 없는 보유 종목은 전량 매도
          </label>
          <div className="btns" style={{ marginTop: 10 }}>
            <button disabled={!!busy || !loggedIn} onClick={make}>{busy && !plan ? busy : "주문 목록 만들기"}</button>
          </div>
          {!loggedIn && <p className="help">로그인하면 쓸 수 있습니다.</p>}
          {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

          {plan && (
            <>
              {plan.skipped.length > 0 && <p className="help">가격을 몰라 건너뛴 종목: {plan.skipped.join(", ")}</p>}
              {plan.orders.length === 0 ? <p className="help" style={{ marginTop: 10 }}>이미 목표 비중과 같습니다. 낼 주문이 없습니다.</p> : (
                <>
                  <div className="tablewrap" style={{ marginTop: 12 }}>
                    <table>
                      <thead><tr><th></th><th className="l">종목</th><th>구분</th><th>수량</th><th>가격</th><th>금액</th><th>보유→목표</th><th>목표 비중</th><th className="l">결과</th></tr></thead>
                      <tbody>
                        {plan.orders.map((o) => (
                          <tr key={o.code}>
                            <td><input type="checkbox" checked={picked.has(o.code)} disabled={!!busy} onChange={() => toggle(o.code)} /></td>
                            <td className="l">{o.name} <span className="help">{o.code}</span></td>
                            <td style={{ color: o.side === "buy" ? "var(--bad)" : "var(--series-1)" }}>{o.side === "buy" ? "매수" : "매도"}</td>
                            <td>{won(o.qty)}</td><td>{won(o.price)}</td><td>{won(o.amount)}</td>
                            <td>{won(o.curQty)}→{won(o.targetQty)}</td>
                            <td>{o.other ? "추천 외" : pct(o.targetWeight)}</td>
                            <td className="l">{state[o.code] ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="help">선택 {chosen.length}건 · 매도 {won(sell)}원 · 매수 {won(buy)}원. 매도 주문을 먼저 냅니다.</p>
                  <div style={{ marginTop: 8 }}>
                    {!confirming ? (
                      <button className="primary" disabled={!!busy || chosen.length === 0} onClick={() => setConfirming(true)}>{busy || `선택한 ${chosen.length}건 주문`}</button>
                    ) : (
                      <div className="btns">
                        <button className="primary" onClick={run}>[{env === "real" ? "실전" : "모의"}] {chosen.length}건 {orderType === "market" ? "시장가" : "지정가"} 주문 실행</button>
                        <button onClick={() => setConfirming(false)}>취소</button>
                      </div>
                    )}
                  </div>
                  {env === "real" && <div className="error" style={{ marginTop: 8 }}>실전 계좌입니다. 실제 돈으로 체결됩니다. 설정의 주문 금액 상한을 넘는 주문은 거부됩니다.</div>}
                </>
              )}
            </>
          )}
          <p className="help" style={{ marginTop: 10 }}>
            지정가는 조회한 현재가로 주문하므로 가격이 움직이면 체결되지 않을 수 있습니다. 시장가 매수는 증권사가 여유 증거금을 더 잡아서 현금을 거의 다 쓰는 주문은 거부될 수 있습니다.
            지정가 매도가 체결되기 전에는 매수할 현금이 모자랄 수 있으니, 거부된 주문은 잠시 뒤 목록을 다시 만들어 내세요.
            추천은 백테스트상의 보유를 기준으로 계산한 것이라, 보유 종목을 이어 가는 전략(이동평균·RSI)은 실제 잔고와 다를 수 있습니다.
          </p>
        </>
      )}
    </div>
  );
}
