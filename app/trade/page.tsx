"use client";

import { useCallback, useEffect, useState } from "react";
import type { Balance, OrderResult, OrderType, Side } from "@/lib/kis/trading";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import RebalancePlan from "@/components/RebalancePlan";

interface Status {
  quotes: "real" | "mock" | null;
  real: { keys: boolean; account: boolean };
  mock: { keys: boolean; account: boolean };
  tradeEnv: "real" | "mock";
  realOrdersAllowed: boolean;
}

const won = (n: number) => Math.round(n).toLocaleString("ko-KR");

export default function TradePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState({ code: "005930", side: "buy" as Side, qty: 1, type: "market" as OrderType, price: "" });
  const [quote, setQuote] = useState<{ name?: string; price: number; changeRate: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    try { localStorage.removeItem("kbt.trade-token"); } catch { /* 예전 버전이 저장한 비밀번호 정리 */ }
    fetchAuth().then(setAuth).catch(() => setError("로그인 상태를 읽지 못했습니다"));
    fetch("/api/kis/status").then((r) => r.json()).then(setStatus).catch(() => setError("서버 상태를 읽지 못했습니다"));
  }, []);

  const loadBalance = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/kis/balance", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setBalance(j);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);

  const loadQuote = async () => {
    setQuote(null);
    const r = await fetch(`/api/kis/quote?code=${encodeURIComponent(order.code)}`);
    const j = await r.json();
    if (r.ok) setQuote(j); else setError(j.error ?? `HTTP ${r.status}`);
  };

  const submit = async () => {
    setBusy(true); setError(""); setConfirming(false);
    try {
      const body = { code: order.code, side: order.side, qty: order.qty, type: order.type, price: order.type === "limit" ? Number(order.price) : undefined };
      const r = await fetch("/api/kis/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const res = j as OrderResult;
      setLog((l) => [`${new Date().toLocaleTimeString("ko-KR")} ${res.env === "mock" ? "[모의]" : "[실전]"} ${order.side === "buy" ? "매수" : "매도"} ${order.code} ${order.qty}주 → 주문번호 ${res.orderNo} ${res.message}`, ...l]);
      loadBalance();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const env = status?.tradeEnv ?? "mock";
  const envLabel = env === "real" ? "실전 계좌" : "모의투자 계좌";
  const acctOk = status ? status[env].keys && status[env].account : false;

  return (
    <>
      <header className="top">
        <h1>한국투자증권 주문·잔고</h1>
        <p>{envLabel}로 주문합니다.</p>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}><a href="/">← 백테스트</a><a href="/settings">설정</a></span>
      </header>
      <main className="app">
        <section className="stack">
          <div className="card">
            <h2>연결 상태</h2>
            {!status ? <p className="help">확인 중…</p> : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
                <li>시세 조회: {status.quotes ? <span className="badge ok">{status.quotes === "real" ? "실전 키" : "모의 키"}</span> : <span className="badge no">앱키 없음</span>}</li>
                <li>모의투자: {status.mock.keys ? <span className="badge ok">앱키</span> : <span className="badge no">앱키 없음</span>} {status.mock.account ? <span className="badge ok">계좌</span> : <span className="badge no">계좌 없음</span>}</li>
                <li>실전: {status.real.keys ? <span className="badge ok">앱키</span> : <span className="badge no">앱키 없음</span>} {status.real.account ? <span className="badge ok">계좌</span> : <span className="badge no">계좌 없음</span>}</li>
                <li>주문 대상: <b>{envLabel}</b>{env === "real" && !status.realOrdersAllowed && " (잠김: NAS .env 에 KIS_ALLOW_REAL_ORDERS=yes 필요)"}</li>
                <li>로그인: {auth?.loggedIn ? <span className="badge ok">됨</span> : <span className="badge no">필요</span>}</li>
              </ul>
            )}
            {status && !acctOk && <p className="help">앱키·계좌번호는 <a href="/settings">설정</a> 화면에서 넣습니다.</p>}
          </div>
          {auth && !auth.loggedIn && <Login auth={auth} title="로그인 (관리자 비밀번호)" onDone={() => fetchAuth().then(setAuth)} />}

          <div className="card">
            <h2>주문</h2>
            {env === "real" && <div className="error" style={{ marginBottom: 10 }}>실전 계좌입니다. 실제 돈으로 체결됩니다.</div>}
            <div className="seg">
              <button className={order.side === "buy" ? "on" : ""} onClick={() => setOrder({ ...order, side: "buy" })}>매수</button>
              <button className={order.side === "sell" ? "on" : ""} onClick={() => setOrder({ ...order, side: "sell" })}>매도</button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="f">종목코드
                <input value={order.code} maxLength={6} onChange={(e) => { setOrder({ ...order, code: e.target.value.trim() }); setQuote(null); }} onBlur={loadQuote} />
              </label>
              <label className="f">수량(주)
                <input type="number" min={1} value={order.qty} onChange={(e) => setOrder({ ...order, qty: Math.max(1, Math.floor(Number(e.target.value))) })} />
              </label>
            </div>
            {quote && <p className="help">{quote.name ?? order.code} 현재가 {won(quote.price)}원 ({quote.changeRate > 0 ? "+" : ""}{quote.changeRate}%)</p>}
            <div className="row" style={{ marginTop: 10 }}>
              <label className="f">주문 방식
                <select value={order.type} onChange={(e) => setOrder({ ...order, type: e.target.value as OrderType })}>
                  <option value="market">시장가</option><option value="limit">지정가</option>
                </select>
              </label>
              {order.type === "limit" && (
                <label className="f">가격(원)<input type="number" value={order.price} onChange={(e) => setOrder({ ...order, price: e.target.value })} /></label>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              {!confirming ? (
                <button className="primary" disabled={busy || !auth?.loggedIn} onClick={() => setConfirming(true)}>주문 확인</button>
              ) : (
                <div className="btns">
                  <button className="primary" disabled={busy} onClick={submit}>
                    [{env === "real" ? "실전" : "모의"}] {order.code} {order.qty}주 {order.type === "market" ? "시장가" : `${order.price}원`} {order.side === "buy" ? "매수" : "매도"} 실행
                  </button>
                  <button onClick={() => setConfirming(false)}>취소</button>
                </div>
              )}
            </div>
            <p className="help">장 시간(평일 09:00~15:30)에만 체결됩니다. 모의투자는 실제 시세로 가상 체결됩니다.</p>
          </div>
          {error && <div className="error">{error}</div>}
        </section>

        <section className="stack">
          <div className="card">
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>잔고
              <button style={{ marginLeft: "auto" }} disabled={busy || !auth?.loggedIn} onClick={loadBalance}>{busy ? "조회 중…" : "조회"}</button>
            </h2>
            {!balance ? <p className="help">조회 버튼을 누르세요.</p> : (
              <>
                <div className="kpis">
                  <div className="kpi"><div className="k">총평가</div><div className="v">{won(balance.totalValue)}원</div></div>
                  <div className="kpi"><div className="k">예수금</div><div className="v">{won(balance.cash)}원</div></div>
                  <div className="kpi"><div className="k">주식평가</div><div className="v">{won(balance.stockValue)}원</div></div>
                  <div className="kpi"><div className="k">평가손익</div><div className="v" style={{ color: balance.pnl >= 0 ? "var(--good)" : "var(--bad)" }}>{won(balance.pnl)}원</div></div>
                </div>
                <div className="tablewrap" style={{ marginTop: 12 }}>
                  <table>
                    <thead><tr><th>종목</th><th>수량</th><th>평균단가</th><th>현재가</th><th>평가금액</th><th>손익</th><th>수익률</th></tr></thead>
                    <tbody>
                      {balance.holdings.length === 0 && <tr><td colSpan={7} className="empty">보유 종목이 없습니다</td></tr>}
                      {balance.holdings.map((h) => (
                        <tr key={h.code}>
                          <td>{h.name} <span className="help">{h.code}</span></td>
                          <td>{won(h.qty)}</td><td>{won(h.avgPrice)}</td><td>{won(h.price)}</td><td>{won(h.value)}</td>
                          <td style={{ color: h.pnl >= 0 ? "var(--good)" : "var(--bad)" }}>{won(h.pnl)}</td>
                          <td style={{ color: h.pnlRate >= 0 ? "var(--good)" : "var(--bad)" }}>{h.pnlRate.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
          <RebalancePlan env={env} loggedIn={!!auth?.loggedIn} onLog={(l) => setLog((x) => [l, ...x])} onDone={loadBalance} />
          {log.length > 0 && (
            <div className="card">
              <h2>이번 세션 주문 기록</h2>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
