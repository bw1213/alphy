"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import { StockSearch } from "@/components/StockSearch";
import { STRATEGIES } from "@/lib/strategies";
import type { SavedStrategy } from "@/lib/strategies/library";
import type { EveningReport, AutoOrder } from "@/lib/auto/evening";
import type { ManualPosition, ManualTrade, FeeRates } from "@/lib/manual/store";
import type { PriceBook } from "@/lib/manual/value";
import { fetchJob } from "@/lib/client/fetchData";

interface PlanView { label: string; kind: string; strategyName: string | null; builtin: string | null; tickers: string[]; budget: number; startDate: string; enabled: boolean; updatedAt: string }
interface AccountView { id: string; name: string; broker: string; cash: number; positions: ManualPosition[]; plan: PlanView | null; log: EveningReport[]; updatedAt: string }
interface ManualState { accounts: AccountView[]; prices: PriceBook | null; trades: ManualTrade[]; brokers: string[]; rates: FeeRates; today: string }

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const post = (body: unknown) => fetchJob("/api/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface PosRow { ticker: string; name: string; qty: string; avgPrice: string }
interface Form {
  id: string; name: string; broker: string; cash: string; positions: PosRow[];
  strategy: string; tickers: string; budget: string; startDate: string; enabled: boolean;
}
const emptyForm = (today: string): Form => ({ id: "", name: "", broker: "토스증권", cash: "0", positions: [], strategy: "", tickers: "", budget: "", startDate: today, enabled: true });

const formOf = (a: AccountView, today: string): Form => ({
  id: a.id, name: a.name, broker: a.broker, cash: String(a.cash),
  positions: a.positions.map((p) => ({ ticker: p.ticker, name: p.name ?? "", qty: String(p.qty), avgPrice: String(Math.round(p.avgPrice * 100) / 100) })),
  strategy: a.plan ? (a.plan.builtin ? `builtin:${a.plan.builtin}` : `saved:${a.plan.strategyName}`) : "",
  tickers: a.plan?.tickers.join(", ") ?? "", budget: a.plan ? String(a.plan.budget) : "", startDate: a.plan?.startDate ?? today, enabled: a.plan?.enabled ?? true,
});

interface TradeForm { ticker: string; name: string; side: "buy" | "sell"; qty: string; price: string; fee: string; date: string }

function Guide({ r, onRecord, done }: { r: EveningReport; onRecord: (o: AutoOrder) => void; done: (o: AutoOrder) => boolean }) {
  if (r.status === "error") return <div className="error">계산하지 못했습니다: {r.error}</div>;
  if (r.status === "holiday") return <p className="help">{r.warnings[0] ?? "휴장일로 보고 건너뛰었습니다."}</p>;
  const buy = r.orders.filter((o) => o.side === "buy").reduce((s, o) => s + o.amount, 0);
  const sell = r.orders.filter((o) => o.side === "sell").reduce((s, o) => s + o.amount, 0);
  const short = buy > (r.accountCash ?? 0) + sell;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="kpis">
        <div className="kpi"><div className="k">기록한 계좌 평가액</div><div className="v">{won(r.accountTotal ?? 0)}</div><div className="s">예수금 {won(r.accountCash ?? 0)} · 시세 {r.dataDate}</div></div>
        <div className="kpi"><div className="k">전략 평가액</div><div className="v">{won(r.equity ?? 0)}</div><div className="s">운용 금액에서 출발한 계산</div></div>
        <div className="kpi"><div className="k">할 일</div><div className="v">{r.orders.length}건</div><div className="s">{r.kept ? "전략 신호 없음 (보유 유지)" : "직접 주문할 것"}</div></div>
      </div>
      {r.orders.length > 0 && (
        <div className="tablewrap"><table>
          <thead><tr><th>구분</th><th>종목</th><th>수량</th><th>지금 → 목표</th><th>오늘 종가</th><th>금액</th><th>이유</th><th></th></tr></thead>
          <tbody>{r.orders.map((o) => (
            <tr key={o.ticker + o.side}>
              <td style={{ color: o.side === "buy" ? "var(--bad)" : "var(--accent)", fontWeight: 600 }}>{o.side === "buy" ? "매수" : "매도"}</td>
              <td>{o.name} <span className="help">{o.ticker}</span></td>
              <td><b>{o.qty.toLocaleString("ko-KR")}주</b></td><td>{o.curQty} → {o.targetQty}</td><td>{won(o.price)}</td><td>{won(o.amount)}</td><td>{o.note ?? ""}</td>
              <td>{done(o) ? <span className="badge ok">기록함</span> : <button onClick={() => onRecord(o)}>체결 기록</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {short && <p className="help" style={{ color: "var(--bad)" }}>매수에 약 {won(buy)}이 필요한데 예수금과 매도 대금을 합쳐 약 {won((r.accountCash ?? 0) + sell)}입니다. 입금하거나 수량을 줄이세요.</p>}
      {r.sellLevels.length > 0 && (
        <>
          <b style={{ fontSize: 13 }}>매도 기준 가격 (종가로 확인)</b>
          <div className="tablewrap"><table>
            <thead><tr><th>종목</th><th>기준 가격</th><th>오늘 종가</th><th>차이</th><th>규칙</th></tr></thead>
            <tbody>{r.sellLevels.map((s, i) => (
              <tr key={i}><td>{s.name}</td><td>{won(s.price)} {s.kind === "take_profit" ? "이상" : "이하"}</td><td>{won(s.close)}</td><td>{s.gap >= 0 ? "+" : ""}{s.gap.toFixed(1)}%</td><td>{s.label}</td></tr>
            ))}</tbody>
          </table></div>
          
        </>
      )}
      {r.warnings.map((w, i) => <p key={i} className="help">※ {w}</p>)}
    </div>
  );
}

export default function ManualPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [st, setSt] = useState<ManualState | null>(null);
  const [lib, setLib] = useState<SavedStrategy[]>([]);
  const [sel, setSel] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [trade, setTrade] = useState<TradeForm | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [sendTg, setSendTg] = useState(false);
  const [delAsk, setDelAsk] = useState(false);
  const [open, setOpen] = useState(0);

  const load = useCallback(async () => {
    const [m, l] = await Promise.all([
      fetch("/api/manual", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/strategies", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
    ]);
    if (m) { setSt(m); setSel((s) => (m.accounts.some((a: AccountView) => a.id === s) ? s : m.accounts[0]?.id ?? "")); }
    if (Array.isArray(l)) setLib(l);
  }, []);

  useEffect(() => { fetchAuth().then((a) => { setAuth(a); if (a.loggedIn) load(); }).catch(() => setError("로그인 상태를 읽지 못했습니다")); }, [load]);

  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name); setError(""); setMsg("");
    try { await fn(); if (done) setMsg(done); await load(); return true; }
    catch (e) { setError((e as Error).message); return false; } finally { setBusy(""); }
  };

  const acc = st?.accounts.find((a) => a.id === sel) ?? null;
  const price = (t: string) => st?.prices?.map[t]?.close;
  const value = acc ? acc.cash + acc.positions.reduce((s, p) => s + p.qty * (price(p.ticker) ?? p.avgPrice), 0) : 0;
  const trades = useMemo(() => (st?.trades ?? []).filter((t) => t.accountId === sel), [st, sel]);
  const last = acc?.log.find((r) => r.status === "ok") ?? acc?.log[0];
  // 그 안내 뒤에 같은 종목·방향으로 기록한 체결이 있으면 "기록함"
  const recorded = (o: AutoOrder) => !!last && trades.some((t) => t.ticker === o.ticker && t.side === o.side && t.at > last.ranAt);

  const picked = form?.strategy.startsWith("saved:") ? lib.find((s) => `saved:${s.name}` === form.strategy) : null;
  const isCustom = !!picked && !picked.cycle && !picked.builder;

  const saveForm = () => form && act("save", async () => {
    const r: any = await post({
      action: "save",
      account: {
        id: form.id || undefined, name: form.name, broker: form.broker, cash: form.cash,
        positions: form.positions.filter((p) => p.ticker.trim()).map((p) => ({ ticker: p.ticker, name: p.name, qty: p.qty, avgPrice: p.avgPrice })),
        plan: form.strategy ? { strategy: form.strategy, tickers: form.tickers, budget: Number(form.budget || 0), startDate: form.startDate, enabled: form.enabled } : null,
      },
    });
    if (r?.id) setSel(r.id);
    setForm(null);
  }, "계좌를 저장했습니다.");

  const startTrade = (o?: AutoOrder) => setTrade(o
    ? { ticker: o.ticker, name: o.name, side: o.side, qty: String(o.qty), price: String(Math.round(o.price)), fee: "", date: st?.today ?? "" }
    : { ticker: "", name: "", side: "buy", qty: "", price: "", fee: "", date: st?.today ?? "" });

  if (auth && !auth.loggedIn) return <main className="app"><Login auth={auth} title="로그인" onDone={() => fetchAuth().then((a) => { setAuth(a); load(); })} /></main>;

  const setPos = (i: number, patch: Partial<PosRow>) => form && setForm({ ...form, positions: form.positions.map((p, k) => (k === i ? { ...p, ...patch } : p)) });

  return (
    <>
      <header className="top">
        <h1>수동 매매</h1>
        <p>토스·미래에셋 등 계좌별 전략 · 평일 저녁 매매 안내</p>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}><a href="/dashboard">전체 계좌</a><a href="/">백테스트</a><a href="/auto">자동 매매</a><a href="/settings">설정</a></span>
      </header>
      <main className="app">
        <section className="stack">
          <div className="card">
            <h2 style={{ display: "flex", alignItems: "center" }}>내 수동 계좌
              <button style={{ marginLeft: "auto", fontWeight: 400 }} disabled={!!busy || !st} onClick={() => { setForm(emptyForm(st!.today)); setDelAsk(false); }}>+ 계좌 추가</button>
            </h2>
            {!st ? <p className="help">불러오는 중…</p> : !st.accounts.length ? <p className="help">아직 계좌가 없습니다.</p> : (
              <div style={{ display: "grid", gap: 6 }}>
                {st.accounts.map((a) => {
                  const v = a.cash + a.positions.reduce((s, p) => s + p.qty * (price(p.ticker) ?? p.avgPrice), 0);
                  const todo = a.log.find((r) => r.status === "ok")?.orders.length ?? 0;
                  return (
                    <button key={a.id} onClick={() => { setSel(a.id); setForm(null); setTrade(null); setOpen(0); }}
                      style={{ textAlign: "left", display: "grid", gap: 2, borderColor: a.id === sel ? "var(--accent)" : undefined }}>
                      <span><b>{a.name}</b> <span className="help">{a.broker}</span></span>
                      <span style={{ fontSize: 12, color: "var(--text-2)" }}>{won(v)} · {a.plan ? `${a.plan.label}${a.plan.enabled ? "" : " (꺼짐)"}` : "전략 없음"}{todo ? ` · 할 일 ${todo}건` : ""}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {form && (
            <div className="card">
              <h2>{form.id ? "계좌 고치기" : "새 계좌"}</h2>
              <div className="row">
                <label className="f">계좌 이름<input value={form.name} placeholder="예: 토스 미국 주식" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                <label className="f">증권사
                  <select value={st?.brokers.includes(form.broker) ? form.broker : "기타"} onChange={(e) => setForm({ ...form, broker: e.target.value })}>
                    {st?.brokers.map((b) => <option key={b}>{b}</option>)}
                  </select>
                </label>
              </div>
              <label className="f" style={{ marginTop: 10 }}>예수금(원)<input type="number" min={0} value={form.cash} onChange={(e) => setForm({ ...form, cash: e.target.value })} /></label>
              <h3>보유 종목</h3>
              {form.positions.length > 0 && (
                <div className="tablewrap"><table>
                  <thead><tr><th>종목</th><th>수량</th><th>평균단가(원)</th><th></th></tr></thead>
                  <tbody>{form.positions.map((p, i) => (
                    <tr key={i}>
                      <td>{p.name || p.ticker} <span className="help">{p.ticker}</span></td>
                      <td><input type="number" min={0} style={{ width: 80 }} value={p.qty} onChange={(e) => setPos(i, { qty: e.target.value })} /></td>
                      <td><input type="number" min={0} style={{ width: 110 }} value={p.avgPrice} onChange={(e) => setPos(i, { avgPrice: e.target.value })} /></td>
                      <td><button onClick={() => setForm({ ...form, positions: form.positions.filter((_, k) => k !== i) })}>빼기</button></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
              <div style={{ marginTop: 6 }}>
                <StockSearch placeholder="보유 종목 이름으로 찾아 추가" exclude={form.positions.map((p) => p.ticker)} onPick={(s) => setForm((f) => f && ({ ...f, positions: [...f.positions, { ticker: s.code, name: s.name, qty: "", avgPrice: "" }] }))} />
              </div>
              <p className="help">미국 종목 평균단가는 원화로 넣으세요.</p>

              <h3>전략</h3>
              <label className="f">적용할 전략
                <select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
                  <option value="">없음 (계좌만 기록)</option>
                  {lib.length > 0 && <optgroup label="내 전략 보관함">{lib.map((s) => <option key={s.name} value={`saved:${s.name}`}>{s.name}{s.cycle ? " (적립·분할 매도)" : s.builder ? " (조건 고르기)" : " (코드)"}</option>)}</optgroup>}
                  <optgroup label="기본 전략">{STRATEGIES.map((s) => <option key={s.id} value={`builtin:${s.id}`}>{s.name}</option>)}</optgroup>
                </select>
              </label>
              {isCustom && !auth?.user?.owner && <p className="help">코드 전략은 관리자만 쓸 수 있습니다.</p>}
              {form.strategy && (
                <>
                  <label className="f" style={{ marginTop: 10 }}>대상 종목 {picked?.cycle ? "(필수)" : "(비우면 전략 기본: 시총 상위 종목)"}
                    <input value={form.tickers} placeholder="예: 069500, QQQ" onChange={(e) => setForm({ ...form, tickers: e.target.value })} />
                  </label>
                  <div style={{ marginTop: 6 }}>
                    <StockSearch placeholder="종목 이름으로 찾아 추가" onPick={(s) => setForm((f) => f && ({ ...f, tickers: [...new Set([...f.tickers.split(/[\s,]+/).filter(Boolean), s.code])].join(", ") }))} />
                  </div>
                  <div className="btns" style={{ marginTop: 6 }}>
                    {form.positions.length > 0 && <button onClick={() => setForm({ ...form, tickers: [...new Set([...form.tickers.split(/[\s,]+/).filter(Boolean), ...form.positions.map((p) => p.ticker)])].join(", ") })}>보유 종목 넣기</button>}
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <label className="f">운용 금액(원)<input type="number" min={100000} step={100000} value={form.budget}
                      placeholder={String(Math.round(Number(form.cash || 0) + form.positions.reduce((s, p) => s + Number(p.qty || 0) * (price(p.ticker) ?? Number(p.avgPrice || 0)), 0)))}
                      onChange={(e) => setForm({ ...form, budget: e.target.value })} /></label>
                    <label className="f">운용 시작일<input type="date" value={form.startDate} max={st?.today} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
                  </div>
                  <p className="help">운용 금액은 보통 계좌 평가액(흐린 값)을 넣습니다.</p>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 8 }}>
                    <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 매일 저녁 계산·텔레그램 안내 켜기
                  </label>
                </>
              )}
              <div className="btns" style={{ marginTop: 12 }}>
                <button className="primary" disabled={!!busy || !form.name.trim() || (!!form.strategy && !form.budget)} onClick={saveForm}>{busy === "save" ? "저장 중…" : "저장"}</button>
                <button disabled={!!busy} onClick={() => setForm(null)}>닫기</button>
                {form.id && (!delAsk ? <button disabled={!!busy} onClick={() => setDelAsk(true)}>계좌 지우기</button> : (
                  <button className="primary" disabled={!!busy} onClick={() => act("del", () => post({ action: "delete", id: form.id }), "계좌를 지웠습니다.").then(() => { setForm(null); setDelAsk(false); })}>정말 지우기 (기록도 사라짐)</button>
                ))}
              </div>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {msg && <p className="help" style={{ color: "var(--good)" }}>{msg}</p>}
        </section>

        <section className="stack">
          {!acc ? (
            <div className="card"><p className="help">계좌를 고르거나 추가하세요.</p></div>
          ) : (
            <>
              <div className="card">
                <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>{acc.name} <span className="help" style={{ margin: 0 }}>{acc.broker}</span>
                  <button style={{ marginLeft: "auto", fontWeight: 400 }} disabled={!!busy} onClick={() => { setForm(formOf(acc, st!.today)); setDelAsk(false); }}>계좌·전략 고치기</button>
                </h2>
                <div className="kpis">
                  <div className="kpi"><div className="k">평가액 (어림)</div><div className="v">{won(value)}</div><div className="s">{st?.prices ? `시세 ${st.prices.at.slice(0, 10)}` : "시세 없음: 평균단가로 계산"}</div></div>
                  <div className="kpi"><div className="k">예수금</div><div className="v">{won(acc.cash)}</div></div>
                  <div className="kpi"><div className="k">전략</div><div className="v" style={{ fontSize: 15 }}>{acc.plan ? acc.plan.label : "없음"}</div><div className="s">{acc.plan ? `${won(acc.plan.budget)} · ${acc.plan.startDate}부터 · ${acc.plan.enabled ? "켜짐" : "꺼짐"}` : "고치기에서 전략을 정하면 매일 안내"}</div></div>
                </div>
                {acc.positions.length > 0 && (
                  <div className="tablewrap" style={{ marginTop: 10 }}><table>
                    <thead><tr><th>종목</th><th>수량</th><th>평균단가</th><th>종가</th><th>평가액</th><th>손익</th></tr></thead>
                    <tbody>{acc.positions.map((p) => {
                      const px = price(p.ticker);
                      const pnl = px ? (px - p.avgPrice) * p.qty : null;
                      return (
                        <tr key={p.ticker}>
                          <td>{p.name ?? p.ticker} <span className="help">{p.ticker}</span></td><td>{p.qty.toLocaleString("ko-KR")}주</td><td>{won(p.avgPrice)}</td>
                          <td>{px ? won(px) : "–"}</td><td>{won(p.qty * (px ?? p.avgPrice))}</td>
                          <td style={{ color: pnl == null ? undefined : pnl >= 0 ? "var(--bad)" : "var(--accent)" }}>{pnl == null ? "–" : `${pnl >= 0 ? "+" : ""}${won(pnl)} (${((px! / p.avgPrice - 1) * 100).toFixed(1)}%)`}</td>
                        </tr>
                      );
                    })}</tbody>
                  </table></div>
                )}
              </div>

              <div className="card">
                <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>다음 거래일 할 일
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", fontSize: 12, fontWeight: 400 }}>
                    <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" style={{ width: "auto", flex: "none" }} checked={sendTg} onChange={(e) => setSendTg(e.target.checked)} />텔레그램으로도</label>
                    <button disabled={!!busy || !acc.plan} onClick={() => act("run", () => post({ action: "run", accountId: acc.id, notify: sendTg })).then(() => setOpen(0))}>{busy === "run" ? "계산 중…" : "지금 계산해 보기"}</button>
                  </span>
                </h2>
                {!acc.plan ? <p className="help">전략이 없습니다. "계좌·전략 고치기"에서 정하세요.</p>
                  : !acc.log.length ? <p className="help">아직 계산 기록이 없습니다.</p> : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {acc.log.map((r, i) => (
                        <div key={r.runDate + r.trigger + i} style={{ borderTop: i ? "1px solid var(--border)" : "none", paddingTop: i ? 8 : 0 }}>
                          <button style={{ width: "100%", textAlign: "left" }} onClick={() => setOpen(open === i ? -1 : i)}>
                            <b>{r.runDate}</b> {r.trigger === "manual" ? "직접" : "자동"} · {r.label} · {r.status === "ok" ? `할 일 ${r.orders.length}건` : r.status === "holiday" ? "휴장" : "오류"}
                          </button>
                          {open === i && <div style={{ marginTop: 8 }}><Guide r={r} onRecord={startTrade} done={(o) => r === last && recorded(o)} /></div>}
                        </div>
                      ))}
                    </div>
                  )}
                <p className="help">증권사 앱에서 주문한 뒤 "체결 기록"으로 넣으세요.</p>
              </div>

              <div className="card">
                <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>체결 기록
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button disabled={!!busy} style={{ fontWeight: 400 }} onClick={() => startTrade()}>+ 직접 기록</button>
                    {trades.length > 0 && <button disabled={!!busy} style={{ fontWeight: 400 }} onClick={() => act("undo", () => post({ action: "undo", accountId: acc.id }), "마지막 체결 기록을 되돌렸습니다.")}>마지막 기록 되돌리기</button>}
                  </span>
                </h2>
                {trade && (
                  <div style={{ display: "grid", gap: 8, marginBottom: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
                    {!trade.ticker ? <StockSearch placeholder="체결한 종목 찾기" onPick={(s) => setTrade({ ...trade, ticker: s.code, name: s.name })} /> : (
                      <p style={{ margin: 0, fontSize: 13 }}><b>{trade.name || trade.ticker}</b> <span className="help">{trade.ticker}</span> <button style={{ marginLeft: 6 }} onClick={() => setTrade({ ...trade, ticker: "", name: "" })}>바꾸기</button></p>
                    )}
                    <div className="row3">
                      <label className="f">구분<select value={trade.side} onChange={(e) => setTrade({ ...trade, side: e.target.value as "buy" | "sell" })}><option value="buy">매수</option><option value="sell">매도</option></select></label>
                      <label className="f">체결 수량<input type="number" min={1} value={trade.qty} onChange={(e) => setTrade({ ...trade, qty: e.target.value })} /></label>
                      <label className="f">체결 가격(원)<input type="number" min={0} value={trade.price} onChange={(e) => setTrade({ ...trade, price: e.target.value })} /></label>
                    </div>
                    <div className="row">
                      <label className="f">수수료·세금(원, 비우면 어림)<input type="number" min={0} value={trade.fee} onChange={(e) => setTrade({ ...trade, fee: e.target.value })} /></label>
                      <label className="f">체결일<input type="date" value={trade.date} max={st?.today} onChange={(e) => setTrade({ ...trade, date: e.target.value })} /></label>
                    </div>
                    <p className="help" style={{ margin: 0 }}>실제 체결 가격(미국은 원화)으로 넣으세요. 수수료는 비우면 어림합니다.</p>
                    <div className="btns">
                      <button className="primary" disabled={!!busy || !trade.ticker || !trade.qty || !trade.price}
                        onClick={() => act("trade", () => post({ action: "trade", accountId: acc.id, ...trade }), "체결을 기록하고 계좌 잔고를 바꿨습니다.").then((ok) => { if (ok) setTrade(null); })}>{busy === "trade" ? "기록 중…" : "기록"}</button>
                      <button onClick={() => setTrade(null)}>닫기</button>
                    </div>
                  </div>
                )}
                {!trades.length ? <p className="help">아직 체결 기록이 없습니다.</p> : (
                  <div className="tablewrap"><table>
                    <thead><tr><th>체결일</th><th>구분</th><th>종목</th><th>수량</th><th>가격</th><th>금액</th><th>수수료·세금</th></tr></thead>
                    <tbody>{trades.slice(0, 50).map((t) => (
                      <tr key={t.id}><td>{t.date}</td><td style={{ color: t.side === "buy" ? "var(--bad)" : "var(--accent)" }}>{t.side === "buy" ? "매수" : "매도"}</td><td>{t.name ?? t.ticker}</td><td>{t.qty.toLocaleString("ko-KR")}주</td><td>{won(t.price)}</td><td>{won(t.qty * t.price)}</td><td>{won(t.fee)}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </>
  );
}
