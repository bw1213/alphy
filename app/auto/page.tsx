"use client";

import { useCallback, useEffect, useState } from "react";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import { StockSearch } from "@/components/StockSearch";
import { STRATEGIES } from "@/lib/strategies";
import type { SavedStrategy } from "@/lib/strategies/library";
import type { EveningReport } from "@/lib/auto/evening";
import type { MorningDay } from "@/lib/auto/morning";
import type { IntradayDay } from "@/lib/auto/intraday";
import { fetchJob } from "@/lib/client/fetchData";
import type { PerfPoint, PerfSummary } from "@/lib/auto/perf";
import type { KisView } from "@/lib/manual/value";
import type { DayOrder } from "@/lib/kis/orders";

interface PlanView {
  label: string; kind: "builtin" | "cycle" | "builder" | "custom"; strategyName: string | null; builtin: string | null;
  tickers: string[]; budget: number; startDate: string; enabled: boolean; intraday?: boolean; updatedAt: string;
}
interface AutoState {
  plan: PlanView | null; log: EveningReport[]; eveningTime: string; owner: boolean; today: string;
  lastEvening: { date: string; attempts: number; done: boolean } | null;
  limit: { realBudget: number; maxLoss: number }; account: "real" | "mock";
  times: { morning: string; cutoff: string }; days: MorningDay[]; intradayDays?: IntradayDay[]; market?: "KR" | "US";
  perf: { base: { date: string; total: number } | null; budget: number; env: "real" | "mock"; points: PerfPoint[]; summary: PerfSummary | null } | null;
  real: { confirmedAt: string | null; lock: string | null; mockDays: number; telegram: boolean };
  /** 마지막으로 읽은 실제 계좌 (대시보드와 같은 값). 계좌가 설정되지 않았으면 undefined */
  accountView?: KisView | null;
}
const ST = { waiting: "대기", placed: "주문됨", partial: "일부 체결", filled: "체결", cancelled: "취소", failed: "실패", skipped: "건너뜀" } as const;
interface TgState { botSet: boolean; bot: string | null; owner: boolean; linked: boolean; chatName: string | null; code: string | null }

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

async function post(url: string, body: unknown) {
  // 오래 걸리는 요청(지금 계산해 보기)은 서버가 작업 id 를 주고, 끝날 때까지 이어서 물어봄
  return fetchJob(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** 미국 기록은 달러 */
const money = (m: "KR" | "US" | undefined, n: number) => (m === "US" ? `$${n.toFixed(2)}` : won(n));
const signed = (n: number) => `${n >= 0 ? "+" : "-"}${won(Math.abs(n))}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

/** 계좌 손익과 전략 손익(운용 금액 대비 %)을 한 그림에 */
function PerfChart({ points, budget }: { points: PerfPoint[]; budget: number }) {
  if (points.length < 2) return null;
  const W = 640, H = 180, L = 44, R = 8, T = 8, B = 20;
  const a = points.map((p) => (p.pnl == null ? null : (p.pnl / budget) * 100));
  const s = points.map((p) => ((p.strategy - budget) / budget) * 100);
  const all = [...s, ...a.filter((x): x is number => x != null), 0];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = (vals: (number | null)[]) => vals.map((v, i) => (v == null ? "" : `${i === 0 || vals[i - 1] == null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="계좌 손익과 전략 손익 추이">
        {[lo, 0, hi].map((v, i) => (
          <g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--grid, #ddd)" strokeDasharray={v === 0 ? "" : "3 3"} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.6">{v.toFixed(1)}%</text></g>
        ))}
        <text x={L} y={H - 4} fontSize="11" fill="currentColor" opacity="0.6">{points[0].date}</text>
        <text x={W - R} y={H - 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.6">{points.at(-1)!.date}</text>
        <path d={line(s)} fill="none" stroke="var(--series-2, #d95926)" strokeWidth="2" />
        <path d={line(a)} fill="none" stroke="var(--series-1, #2a78d6)" strokeWidth="2" />
      </svg>
      <div className="help" style={{ display: "flex", gap: 14 }}>
        <span><span style={{ display: "inline-block", width: 14, height: 2, background: "var(--series-1, #2a78d6)", verticalAlign: "middle", marginRight: 4 }} />실제 계좌</span>
        <span><span style={{ display: "inline-block", width: 14, height: 2, background: "var(--series-2, #d95926)", verticalAlign: "middle", marginRight: 4 }} />전략 계산(백테스트)</span>
      </div>
    </div>
  );
}

const kstTime = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 지금 실제 계좌 (한국투자증권 잔고 그대로, 국내+미국·예수금 포함) */
function AccountCard({ v, busy, onRefresh }: { v: KisView | null; busy: boolean; onRefresh: () => void }) {
  const stock = v ? v.positions.reduce((a, p) => a + p.value, 0) : 0;
  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>지금 계좌{v ? ` (${v.env === "real" ? "실전" : "모의투자"})` : ""}
        <span style={{ marginLeft: "auto" }}><button disabled={busy} onClick={onRefresh}>{busy ? "읽는 중…" : "계좌 새로 읽기"}</button></span>
      </h2>
      {!v ? <p className="help">아직 계좌를 읽지 않았습니다. &quot;계좌 새로 읽기&quot;를 누르세요.</p> : (
        <div style={{ display: "grid", gap: 10 }}>
          <div className="kpis">
            <div className="kpi"><div className="k">계좌 평가액</div><div className="v">{won(v.total)}</div><div className="s">{kstTime(v.at)} 기준</div></div>
            <div className="kpi"><div className="k">예수금</div><div className="v">{won(v.cash)}</div><div className="s">원화·달러 합침</div></div>
            <div className="kpi"><div className="k">주식</div><div className="v">{won(stock)}</div><div className="s">{v.positions.length}종목</div></div>
          </div>
          {v.positions.length > 0 && (
            <div className="tablewrap"><table>
              <thead><tr><th>종목</th><th>수량</th><th>평균단가</th><th>현재가</th><th>평가액</th><th>손익</th></tr></thead>
              <tbody>{v.positions.map((p) => {
                const pnl = p.value - p.qty * p.avgPrice;
                return <tr key={p.ticker}><td>{p.name || p.ticker} <span className="help">{p.ticker}</span></td><td>{p.qty.toLocaleString("ko-KR")}주</td><td>{won(p.avgPrice)}</td><td>{won(p.price)}</td><td>{won(p.value)}</td>
                  <td style={{ color: pnl >= 0 ? "var(--bad)" : "var(--accent)" }}>{signed(pnl)}</td></tr>;
              })}</tbody>
            </table></div>
          )}
          {v.note && <p className="help">※ {v.note}</p>}
          <p className="help">증권사 잔고를 그대로 보여 줍니다 (국내·미국 주식, 원화·달러 예수금을 원화로). 저녁 계산 결과의 &quot;전략 계산 평가액&quot;은 운용 금액에서 출발해 전략대로 했다면 얼마인지 계산한 값이라 이 숫자와 다릅니다.</p>
        </div>
      )}
    </div>
  );
}

interface OrdersView { env: "real" | "mock"; market: "KR" | "US"; date: string; at: string; orders: DayOrder[] }
const hhmm = (t: string) => (t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t);

/** 주문 현황: 오늘 증권사에 들어간 주문(대기·체결)과 알피가 지켜보는 장중 매도 가격 */
function OrdersCard({ st }: { st: AutoState }) {
  const [v, setV] = useState<OrdersView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auto?orders=1", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setV(j);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    load();
    // 화면을 보고 있는 동안 1분마다 다시 읽음
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);
  const m = v?.market ?? st.market;
  const today = st.intradayDays?.find((d) => d.date === st.today);
  const watching = today && !today.done ? today.levels : null;
  const lastOk = st.log.find((r) => r.status === "ok");
  const next = !watching && lastOk?.intraday ? lastOk.sellLevels : [];
  const open = v?.orders.filter((o) => o.openQty > 0 && !o.cancelled).length ?? 0;
  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>주문 현황{v ? ` (${v.env === "real" ? "실전" : "모의투자"})` : ""}
        <span style={{ marginLeft: "auto" }}><button disabled={busy} onClick={load}>{busy ? "읽는 중…" : "새로 읽기"}</button></span>
      </h2>
      <b style={{ fontSize: 13 }}>오늘 증권사 주문{v ? ` · ${v.date}${open ? ` · 체결 기다리는 주문 ${open}건` : ""}` : ""}</b>
      {err && <div className="error" style={{ marginTop: 6 }}>{err}</div>}
      {!v ? (!err && <p className="help">읽는 중…</p>) : (
        <div className="tablewrap" style={{ marginTop: 6 }}><table>
          <thead><tr><th>시각</th><th>구분</th><th>종목</th><th>주문</th><th>체결</th><th>남은 수량</th><th>상태</th></tr></thead>
          <tbody>
            {v.orders.length === 0 && <tr><td colSpan={7} className="empty">오늘 낸 주문이 없습니다</td></tr>}
            {v.orders.map((o) => {
              const state = o.cancelled ? "취소" : o.openQty === 0 && o.filledQty > 0 ? "체결 완료" : o.filledQty > 0 ? "일부 체결" : "체결 대기";
              return (
                <tr key={o.orderNo}>
                  <td>{hhmm(o.time)}</td>
                  <td style={{ color: o.side === "buy" ? "var(--bad)" : "var(--accent)" }}>{o.side === "buy" ? "매수" : "매도"}</td>
                  <td>{o.name || o.code} <span className="help">{o.code}</span></td>
                  <td>{o.qty.toLocaleString("ko-KR")}주 · {o.price > 0 ? money(m, o.price) : "시장가"}</td>
                  <td>{o.filledQty > 0 ? `${o.filledQty.toLocaleString("ko-KR")}주 · 평균 ${money(m, o.avgPrice)}` : "-"}</td>
                  <td>{o.openQty > 0 && !o.cancelled ? `${o.openQty.toLocaleString("ko-KR")}주` : "-"}</td>
                  <td>{state}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {v && <p className="help">{kstTime(v.at)}에 한국투자증권에서 읽은 내역입니다 (화면을 보는 동안 1분마다 다시 읽음). 체결되면 텔레그램으로도 알려 드립니다.</p>}
      {(watching?.length || next.length) ? (
        <>
          <b style={{ fontSize: 13 }}>{watching ? "오늘 장중 매도 대기 가격 (지켜보는 중)" : "다음 거래일 장중 매도 대기 가격"}</b>
          <div className="tablewrap" style={{ marginTop: 6 }}><table>
            <thead><tr><th>종목</th><th>매도 가격</th><th>수량</th><th>지금 가격</th><th>규칙</th></tr></thead>
            <tbody>{(watching ?? next).map((l, i) => (
              <tr key={i}><td>{l.name}</td><td>{m === "US" && l.usd ? money("US", l.usd) : won(l.price)} {l.kind === "take_profit" ? "이상" : "이하"}</td><td>{l.qty ? `${l.qty.toLocaleString("ko-KR")}주` : "전부"}</td>
                <td>{watching && today?.last?.[l.ticker] ? `${money(m, today.last[l.ticker].price)} (${today.last[l.ticker].at})` : `${won(l.close)} (종가)`}</td><td>{l.label}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="help">이 가격들은 증권사에 미리 걸어 둔 주문이 아닙니다. 알피가 장중에 현재가를 지켜보다가 닿으면 그때 시장가로 팔고, 그 주문이 위 &quot;오늘 증권사 주문&quot;에 나타납니다.</p>
        </>
      ) : null}
    </div>
  );
}

function Report({ r }: { r: EveningReport }) {
  if (r.status === "error") return <div className="error">계산하지 못했습니다: {r.error}</div>;
  if (r.status === "holiday") return <p className="help">{r.warnings[0] ?? "휴장일로 보고 건너뛰었습니다."}</p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="kpis">
        {r.accountTotal != null && <div className="kpi"><div className="k">계좌 평가액 (계산 때)</div><div className="v">{won(r.accountTotal)}</div><div className="s">예수금 {won(r.accountCash ?? 0)} · 주식 {won(r.accountStock ?? 0)}</div></div>}
        <div className="kpi"><div className="k">전략 계산 평가액 (가상)</div><div className="v">{won(r.equity ?? 0)}</div><div className="s">운용 금액에서 출발한 백테스트 · 시세 {r.dataDate}</div></div>
        <div className="kpi"><div className="k">내일 주문</div><div className="v">{r.orders.length}건</div><div className="s">{r.kept ? "전략 신호 없음 (보유 유지)" : "전략이 사고팔기로 한 종목"}</div></div>
      </div>
      {r.orders.length > 0 && (
        <div className="tablewrap"><table>
          <thead><tr><th>구분</th><th>종목</th><th>수량</th><th>지금 → 목표</th><th>금액(오늘 종가)</th><th>이유</th></tr></thead>
          <tbody>{r.orders.map((o) => (
            <tr key={o.ticker + o.side}>
              <td style={{ color: o.side === "buy" ? "var(--bad)" : "var(--accent)" }}>{o.side === "buy" ? "매수" : "매도"}</td>
              <td>{o.name} <span className="help">{o.ticker}</span></td>
              <td>{o.qty.toLocaleString("ko-KR")}주</td><td>{o.curQty} → {o.targetQty}</td><td>{won(o.amount)}</td><td>{o.note ?? ""}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {r.sellLevels.length > 0 && (
        <>
          <b style={{ fontSize: 13 }}>장중 매도 기준 가격</b>
          <div className="tablewrap"><table>
            <thead><tr><th>종목</th><th>기준 가격</th>{r.intraday && <th>매도 수량</th>}<th>오늘 종가</th><th>차이</th><th>규칙</th></tr></thead>
            <tbody>{r.sellLevels.map((s, i) => (
              <tr key={i}><td>{s.name}</td><td>{won(s.price)}{s.usd ? ` ($${s.usd.toFixed(2)})` : ""} {s.kind === "take_profit" ? "이상" : "이하"}</td>{r.intraday && <td>{s.qty ? `${s.qty.toLocaleString("ko-KR")}주` : "전부"}</td>}<td>{won(s.close)}</td><td>{s.gap >= 0 ? "+" : ""}{s.gap.toFixed(1)}%</td><td>{s.label}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="help">{r.intraday
            ? "장중에 이 가격에 닿으면 바로 시장가로 팝니다."
            : "알림용 가격입니다. 종가로 확인해 다음 날 아침에 팝니다."} 주문 목록은 다음 거래일 아침에 냅니다.</p>
        </>
      )}
      <p className="help">보유 수량 기준: {r.holdingsFrom === "account" ? `실제 계좌 (${r.account === "real" ? "실전" : "모의투자"})` : "전략상 보유 (계좌를 읽지 못함)"}</p>
      {r.warnings.map((w, i) => <p key={i} className="help">※ {w}</p>)}
    </div>
  );
}

export default function AutoPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [st, setSt] = useState<AutoState | null>(null);
  const [tg, setTg] = useState<TgState | null>(null);
  const [lib, setLib] = useState<SavedStrategy[]>([]);
  const [form, setForm] = useState({ strategy: "", tickers: "", budget: "1000000", startDate: "", enabled: true, intraday: true });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [token, setToken] = useState("");
  const [time, setTime] = useState("");
  const [mt, setMt] = useState({ morning: "", cutoff: "" });
  const [stopAsk, setStopAsk] = useState(false);
  const [realPw, setRealPw] = useState("");
  const [sendTg, setSendTg] = useState(false);
  const [open, setOpen] = useState(0);

  const load = useCallback(async () => {
    const [a, t, l] = await Promise.all([
      fetch("/api/auto", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/telegram", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/strategies", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
    ]);
    if (a) {
      setSt(a); setTime(a.eveningTime); setMt(a.times);
      const p: PlanView | null = a.plan;
      if (p) setForm({ strategy: p.builtin ? `builtin:${p.builtin}` : `saved:${p.strategyName}`, tickers: p.tickers.join(", "), budget: String(p.budget), startDate: p.startDate, enabled: p.enabled, intraday: p.intraday !== false });
      else setForm((f) => ({ ...f, startDate: f.startDate || a.today }));
    }
    if (t) setTg(t);
    if (Array.isArray(l)) setLib(l);
  }, []);

  useEffect(() => { fetchAuth().then((a) => { setAuth(a); if (a.loggedIn) load(); }).catch(() => setError("로그인 상태를 읽지 못했습니다")); }, [load]);

  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name); setError(""); setMsg("");
    try { await fn(); if (done) setMsg(done); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };

  const picked = form.strategy.startsWith("saved:") ? lib.find((s) => `saved:${s.name}` === form.strategy) : null;
  const isCycle = !!picked?.cycle;
  const isCustom = !!picked && !picked.cycle && !picked.builder;

  if (auth && !auth.loggedIn) return <main className="app"><Login auth={auth} title="로그인" onDone={() => fetchAuth().then((a) => { setAuth(a); load(); })} /></main>;

  return (
    <>
      <header className="top">
        <h1>자동 매매</h1>
        <p>평일 {st?.eveningTime ?? "18:00"} 계산 · 텔레그램 알림</p>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}><a href="/dashboard">전체 계좌</a><a href="/manual">수동 매매</a><a href="/">백테스트</a><a href="/trade">주문·잔고</a><a href="/settings">설정</a></span>
      </header>
      <main className="app">
        <section className="stack">
          <div className="card">
            <h2>운용 전략</h2>
            <label className="f">전략
              <select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
                <option value="">고르세요</option>
                {lib.length > 0 && <optgroup label="내 전략 보관함">{lib.map((s) => <option key={s.name} value={`saved:${s.name}`}>{s.name}{s.cycle ? " (적립·분할 매도)" : s.builder ? " (조건 고르기)" : " (코드)"}</option>)}</optgroup>}
                <optgroup label="기본 전략">{STRATEGIES.map((s) => <option key={s.id} value={`builtin:${s.id}`}>{s.name}</option>)}</optgroup>
              </select>
            </label>
            {isCustom && !auth?.user?.owner && <p className="help">코드 전략은 관리자만 운용할 수 있습니다.</p>}
            <label className="f" style={{ marginTop: 10 }}>대상 종목 {isCycle ? "(필수)" : "(비우면 전략 기본: 시총 상위 종목)"}
              <input value={form.tickers} placeholder="예: 069500, 005930" onChange={(e) => setForm({ ...form, tickers: e.target.value })} />
            </label>
            <div style={{ marginTop: 6 }}>
              <StockSearch placeholder="종목 이름으로 찾아 추가" onPick={(s) => setForm((f) => ({ ...f, tickers: [...new Set([...f.tickers.split(/[\s,]+/).filter(Boolean), s.code])].join(", ") }))} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="f">운용 금액(원)<input type="number" min={100000} step={100000} value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} /></label>
              <label className="f">운용 시작일<input type="date" value={form.startDate} max={st?.today} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
            </div>
            
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 8 }}>
              <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 매일 저녁 자동 계산·알림 켜기
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 4 }}>
              <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={form.intraday} onChange={(e) => setForm({ ...form, intraday: e.target.checked })} /> 장중 실시간 매도 (손절·익절·하락 매도 가격에 장중에 닿으면 바로 팖)
            </label>
            <p className="help">끄면 종가 확인 후 다음 날 아침에 팝니다.</p>
            <div className="btns" style={{ marginTop: 12 }}>
              <button className="primary" disabled={!!busy || !form.strategy} onClick={() => act("save", () => post("/api/auto", { action: "save", ...form, budget: Number(form.budget) }), "저장했습니다. 보관함에서 전략을 고쳐도 여기서 다시 저장해야 운용에 반영됩니다.")}>{busy === "save" ? "저장 중…" : "저장"}</button>
              {st?.plan && <button disabled={!!busy} onClick={() => act("del", () => post("/api/auto", { action: "delete" }), "운용 전략을 지웠습니다.")}>운용 그만두기</button>}
            </div>
            {st && <p className="help">주문 계좌: {st.account === "real" ? "실전" : "모의투자"} · 손실 한도 {st.limit.maxLoss ? `-${st.limit.maxLoss}%` : "없음"}{st.account === "real" ? ` · 실전 운용 금액 상한 ${st.limit.realBudget ? won(st.limit.realBudget) : "없음"}` : ""} (<a href="/settings">설정</a>)</p>}
            {st?.plan && <p className="help">지금 운용: <b>{st.plan.label}</b> · {won(st.plan.budget)} · {st.plan.startDate}부터 · {st.plan.enabled ? "켜짐" : "꺼짐"} · 장중 매도 {st.plan.intraday !== false ? "켜짐" : "꺼짐"}</p>}
          </div>

          <div className="card">
            <h2>텔레그램 알림</h2>
            {!tg ? <p className="help">확인 중…</p> : (
              <>
                {tg.owner && (
                  <div style={{ marginBottom: 12 }}>
                    <p className="help" style={{ marginTop: 0 }}>관리자 봇: {tg.botSet ? <span className="badge ok">@{tg.bot} 연결됨</span> : <span className="badge no">봇 없음</span>}</p>
                    {!tg.botSet && <p className="help">@BotFather 에서 /newbot 으로 받은 토큰을 넣으세요.</p>}
                    <div className="row">
                      <input type="password" placeholder={tg.botSet ? "새 토큰으로 바꾸기 (비우고 저장하면 해제)" : "봇 토큰 (123456:ABC…)"} value={token} onChange={(e) => setToken(e.target.value)} />
                      <button disabled={!!busy} onClick={() => act("token", () => post("/api/telegram", { action: "token", token }), token ? "봇을 연결했습니다." : "봇 연결을 해제했습니다.").then(() => setToken(""))}>{busy === "token" ? "확인 중…" : "봇 저장"}</button>
                    </div>
                  </div>
                )}
                {!tg.botSet ? <p className="help">관리자가 봇을 연결해야 합니다.</p> : tg.linked ? (
                  <>
                    <p style={{ fontSize: 13, margin: 0 }}>내 알림: <span className="badge ok">연결됨</span> {tg.chatName}</p>
                    <div className="btns" style={{ marginTop: 8 }}>
                      <button disabled={!!busy} onClick={() => act("test", () => post("/api/telegram", { action: "test" }), "시험 알림을 보냈습니다.")}>시험 알림</button>
                      <button disabled={!!busy} onClick={() => act("unlink", () => post("/api/telegram", { action: "unlink" }), "연결을 끊었습니다.")}>연결 끊기</button>
                    </div>
                  </>
                ) : (
                  <>
                    <ol style={{ fontSize: 13, paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
                      <li><button disabled={!!busy} onClick={() => act("code", () => post("/api/telegram", { action: "code" }))}>연결 코드 만들기</button></li>
                      {tg.code && <li>텔레그램에서 <a href={`https://t.me/${tg.bot}?start=${tg.code}`} target="_blank" rel="noreferrer">@{tg.bot}</a> 을 열고 <b>시작(Start)</b>을 누르거나 <code>{tg.code}</code> 를 보내세요.</li>}
                      {tg.code && <li><button disabled={!!busy} onClick={() => act("verify", () => post("/api/telegram", { action: "verify" }), "텔레그램을 연결했습니다.")}>{busy === "verify" ? "확인 중…" : "보냈어요, 확인"}</button></li>}
                    </ol>
                    <p className="help">코드는 30분 동안 쓸 수 있습니다.</p>
                  </>
                )}
              </>
            )}
          </div>

          {st?.owner && (
            <div className="card">
              <h2>실행 시각 (관리자)</h2>
              <div className="row">
                <label className="f">저녁 계산<input value={time} placeholder="18:00" onChange={(e) => setTime(e.target.value)} /></label>
                <button style={{ alignSelf: "end" }} disabled={!!busy} onClick={() => act("time", () => post("/api/auto", { action: "time", eveningTime: time }), "계산 시각을 바꿨습니다.")}>저장</button>
              </div>
              <p className="help">16:00 이후로 정하세요.</p>
              <div className="row" style={{ marginTop: 10 }}>
                <label className="f">아침 주문<input value={mt.morning} placeholder="08:40" onChange={(e) => setMt({ ...mt, morning: e.target.value })} /></label>
                <label className="f">미체결 취소<input value={mt.cutoff} placeholder="10:00" onChange={(e) => setMt({ ...mt, cutoff: e.target.value })} /></label>
              </div>
              <button style={{ marginTop: 8 }} disabled={!!busy} onClick={() => act("times", () => post("/api/auto", { action: "times", morningTime: mt.morning, cutoffTime: mt.cutoff }), "아침 시각을 바꿨습니다.")}>저장</button>
              <p className="help">09:00 전에 내면 시가에 체결되어 백테스트와 같습니다.</p>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {msg && <p className="help" style={{ color: "var(--good)" }}>{msg}</p>}
        </section>

        <section className="stack">
          {st?.plan && <OrdersCard st={st} />}
          {st?.accountView !== undefined && <AccountCard v={st.accountView} busy={busy === "account"} onRefresh={() => act("account", () => post("/api/dashboard", { action: "refresh" }))} />}
          <div className="card">
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>저녁 계산 결과
              <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", fontSize: 12, fontWeight: 400 }}>
                {tg?.linked && <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" style={{ width: "auto", flex: "none" }} checked={sendTg} onChange={(e) => setSendTg(e.target.checked)} />텔레그램으로도</label>}
                <button disabled={!!busy || !st?.plan} onClick={() => act("run", () => post("/api/auto", { action: "run", notify: sendTg })).then(() => setOpen(0))}>{busy === "run" ? "계산 중…" : "지금 계산해 보기"}</button>
                <button disabled={!!busy || !st?.plan} title="지금 운용 전략을 저장하기 전의 저녁 계산 기록과 끝난 아침 주문·장중 감시 기록을 지웁니다 (진행 중인 주문은 남김)" onClick={() => { if (confirm("지금 운용 전략을 저장하기 전의 기록과 끝난 주문·감시 기록을 지울까요? 되돌릴 수 없습니다.")) act("clear", () => post("/api/auto", { action: "clear" }), "지난 기록을 지웠습니다."); }}>{busy === "clear" ? "지우는 중…" : "지난 기록 지우기"}</button>
              </span>
            </h2>
            {st?.lastEvening && <p className="help" style={{ marginTop: 0 }}>마지막 자동 계산: {st.lastEvening.date} ({st.lastEvening.done ? "완료" : `시도 ${st.lastEvening.attempts}번`})</p>}
            {!st?.log.length ? <p className="help">아직 계산 기록이 없습니다.</p> : (
              <div style={{ display: "grid", gap: 8 }}>
                {st.log.map((r, i) => (
                  <div key={r.runDate + r.trigger + i} style={{ borderTop: i ? "1px solid var(--border)" : "none", paddingTop: i ? 8 : 0 }}>
                    <button style={{ width: "100%", textAlign: "left", display: "flex", gap: 8 }} onClick={() => setOpen(open === i ? -1 : i)}>
                      <b>{r.runDate}</b> {r.trigger === "manual" ? "직접" : "자동"} · {r.label} ·{" "}
                      {r.status === "ok" ? `주문 ${r.orders.length}건, 매도 기준 ${r.sellLevels.length}개` : r.status === "holiday" ? "휴장" : "오류"}
                    </button>
                    {open === i && <div style={{ marginTop: 8 }}><Report r={r} /></div>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card">
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>아침 자동 주문
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                {!stopAsk ? <button disabled={!!busy || (!st?.plan?.enabled && !st?.days.some((d) => d.date === st.today && ["placed", "buying"].includes(d.phase)))} onClick={() => setStopAsk(true)}>긴급 정지</button> : (
                  <>
                    <button className="primary" disabled={!!busy} onClick={() => act("stop", () => post("/api/auto", { action: "stop" }), "자동 매매를 멈추고 오늘 남은 자동 주문을 취소했습니다.").then(() => setStopAsk(false))}>정말 멈추기</button>
                    <button onClick={() => setStopAsk(false)}>아니요</button>
                  </>
                )}
              </span>
            </h2>
            {st?.market === "US" && <p className="help" style={{ marginTop: 0 }}>미국 장 시작(뉴욕 09:32)에 현재가 ±1% 지정가로 내고 10:30에 미체결을 취소합니다. 시각·가격은 뉴욕·달러 기준.</p>}
            <p className="help" style={{ marginTop: 0, display: st?.market === "US" ? "none" : undefined }}>평일 {st?.times.morning ?? "08:40"} {st?.account === "real" ? "실전" : "모의투자"} 계좌로 주문, {st?.times.cutoff ?? "10:00"}에 미체결 취소.</p>
            {!st?.days.length ? <p className="help">아직 아침 주문 기록이 없습니다.</p> : st.days.slice(0, 5).map((d) => (
              <details key={d.date} open={d.date === st.today} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
                <summary style={{ cursor: "pointer", fontSize: 13 }}><b>{d.date}</b> · {d.env === "real" ? "실전" : "모의"} · {({ placed: "진행 중", buying: "매도 체결 기다림", done: "끝남", skipped: "주문 안 함", stopped: "긴급 정지" } as const)[d.phase]}{d.reason ? ` · ${d.reason}` : ""}</summary>
                {d.items.length > 0 && (
                  <div className="tablewrap" style={{ marginTop: 6 }}><table>
                    <thead><tr><th>구분</th><th>종목</th><th>수량</th><th>상태</th><th>체결</th></tr></thead>
                    <tbody>{d.items.map((it, i) => (
                      <tr key={i}>
                        <td style={{ color: it.side === "buy" ? "var(--bad)" : "var(--accent)" }}>{it.side === "buy" ? "매수" : "매도"}</td>
                        <td>{it.name} <span className="help">{it.ticker}</span>{it.note ? <div className="help">{it.note}</div> : null}</td>
                        <td>{it.qty}주</td>
                        <td>{ST[it.status]}{it.error ? <div className="help">{it.error}</div> : null}</td>
                        <td>{it.filledQty > 0 ? `${it.filledQty}주 · ${money(d.market, it.avgPrice)}` : ""}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
                {d.log.length > 0 && <ul className="help" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{d.log.slice(-8).map((l, i) => <li key={i}>{l}</li>)}</ul>}
              </details>
            ))}
          </div>
          <div className="card">
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>성과: 실제 계좌와 전략 비교
              {st?.perf?.base && <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button disabled={!!busy} title="입금·출금을 했을 때 누르세요" onClick={() => act("rebase", () => post("/api/auto", { action: "rebase" }), "지금 계좌 평가액에 맞춰 기준을 다시 잡았습니다. 지금까지의 손익은 그대로입니다.")}>기준 다시 잡기</button>
                <button disabled={!!busy} title="계좌 손익이 말이 안 되는 숫자일 때: 지금 평가액을 손익 0으로" onClick={() => { if (confirm("지금 계좌 평가액을 새 기준(손익 0)으로 잡고 예전 계좌 손익 기록을 지울까요?")) act("reset", () => post("/api/auto", { action: "rebase", reset: true }), "지금 계좌 평가액을 손익 0으로 다시 잡았습니다."); }}>손익 처음부터</button>
              </span>}
            </h2>
            {!st?.perf?.summary ? <p className="help">아직 기록이 없습니다.</p> : (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="kpis">
                  <div className="kpi"><div className="k">실제 계좌 손익</div><div className="v">{st.perf.summary.pnl != null ? signed(st.perf.summary.pnl) : "기록 없음"}</div><div className="s">{st.perf.summary.pnlPct != null ? `운용 금액 대비 ${pct(st.perf.summary.pnlPct)}` : "계좌를 읽지 못했습니다"}</div></div>
                  <div className="kpi"><div className="k">전략 계산 손익</div><div className="v">{signed(st.perf.summary.strategyPnl)}</div><div className="s">운용 금액 대비 {pct(st.perf.summary.strategyPct)}</div></div>
                  <div className="kpi"><div className="k">차이 (계좌 − 전략)</div><div className="v">{st.perf.summary.gap != null ? `${st.perf.summary.gap >= 0 ? "+" : ""}${st.perf.summary.gap.toFixed(2)}%p` : "-"}</div><div className="s">{st.perf.summary.days}일 기록 · {st.perf.env === "real" ? "실전" : "모의투자"}</div></div>
                </div>
                <PerfChart points={st.perf.points} budget={st.perf.budget} />
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 13 }}>날짜별 기록</summary>
                  <div className="tablewrap" style={{ marginTop: 6 }}><table>
                    <thead><tr><th>날짜</th><th>계좌 총평가액</th><th>계좌 손익</th><th>전략 평가액</th><th>전략 손익</th></tr></thead>
                    <tbody>{st.perf.points.slice(-20).reverse().map((p) => (
                      <tr key={p.date}><td>{p.date}</td><td>{p.total != null ? won(p.total) : "못 읽음"}</td><td>{p.pnl != null ? signed(p.pnl) : ""}</td><td>{won(p.strategy)}</td><td>{signed(p.strategy - st.perf!.budget)}</td></tr>
                    ))}</tbody>
                  </table></div>
                </details>
                <p className="help">기준: {st.perf.base ? `${st.perf.base.date} ${won(st.perf.base.total)}` : "아직 없음"} · 입출금 뒤에는 &quot;기준 다시 잡기&quot;(지금까지 손익 유지), 손익이 말이 안 되면 &quot;손익 처음부터&quot;(지금을 0으로)를 누르세요.</p>
              </div>
            )}
          </div>
          <div className="card">
            <h2>실전 전환</h2>
            {!st ? <p className="help">확인 중…</p> : (
              <>
                <p className="help" style={{ marginTop: 0 }}>여기서 확인하기 전에는 실전 계좌로 자동 주문하지 않습니다. 전략·금액을 바꾸면 다시 확인합니다.</p>
                <ul style={{ fontSize: 13, paddingLeft: 18, margin: "0 0 10px", lineHeight: 1.8 }}>
                  <li>{st.account === "real" ? "✓" : "○"} 주문 계좌: {st.account === "real" ? "실전" : <>모의투자 (<a href="/settings">설정</a>에서 주문 대상을 실전으로)</>}</li>
                  <li>{st.account === "real" && !st.real.lock ? "✓" : "○"} 실전 주문 잠금: {st.account !== "real" ? "주문 계좌를 실전으로 바꾸면 확인합니다" : st.real.lock ?? "풀려 있음"}</li>
                  <li>{st.real.mockDays >= 5 ? "✓" : "○"} 모의투자로 자동 주문이 체결된 날: {st.real.mockDays}일 (5일 이상 권장)</li>
                  <li>{st.real.telegram ? "✓" : "○"} 텔레그램 알림: {st.real.telegram ? "연결됨" : "연결 안 됨 (권장)"}</li>
                  <li>{st.limit.realBudget > 0 && st.limit.maxLoss > 0 ? "✓" : "○"} 한도: 실전 운용 금액 상한 {st.limit.realBudget ? won(st.limit.realBudget) : "없음"}, 손실 한도 {st.limit.maxLoss ? `-${st.limit.maxLoss}%` : "없음"}</li>
                </ul>
                {st.real.confirmedAt ? (
                  <div className="btns">
                    <span style={{ fontSize: 13 }}>확인됨 ({new Date(st.real.confirmedAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}){st.account === "real" ? " · 실전 계좌로 자동 주문합니다" : ""}</span>
                    <button disabled={!!busy} onClick={() => act("real", () => post("/api/auto", { action: "real", on: false }), "실전 전환 확인을 취소했습니다. 실전 계좌로는 자동 주문하지 않습니다.")}>확인 취소</button>
                  </div>
                ) : (
                  <div className="row">
                    <label className="f">로그인 비밀번호<input type="password" autoComplete="current-password" value={realPw} onChange={(e) => setRealPw(e.target.value)} /></label>
                    <label className="f">&nbsp;<button disabled={!!busy || !realPw || !st.plan || st.account !== "real" || !!st.real.lock} onClick={() => act("real", () => post("/api/auto", { action: "real", on: true, password: realPw }), "실전 전환을 확인했습니다. 다음 거래일 아침부터 실전 계좌로 자동 주문합니다.").then(() => setRealPw(""))}>실전 자동 매매 확인</button></label>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="card">
            <h2>장중 실시간 매도</h2>
            <p className="help" style={{ marginTop: 0 }}>{st?.market === "US" ? "뉴욕 09:35~15:50" : "평일 09:00~15:20"} 동안 매도 가격에 닿으면 바로 팝니다.</p>
            {!st?.intradayDays?.length ? <p className="help">아직 장중 감시 기록이 없습니다.</p> : st.intradayDays.slice(0, 5).map((d) => (
              <details key={d.date} open={d.date === st.today} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
                <summary style={{ cursor: "pointer", fontSize: 13 }}><b>{d.date}</b> · {d.env === "real" ? "실전" : "모의"} · {d.done ? (d.reason ?? "끝남") : `감시 중 (가격 ${d.levels.length}개, 매도 ${d.sells.length}건)`}</summary>
                {d.levels.length > 0 && (
                  <div className="tablewrap" style={{ marginTop: 6 }}><table>
                    <thead><tr><th>종목</th><th>매도 가격</th><th>수량</th><th>마지막 현재가</th><th>규칙</th></tr></thead>
                    <tbody>{d.levels.map((l, i) => (
                      <tr key={i}><td>{l.name}</td><td>{money(d.market, l.usd ?? l.price)} {l.kind === "take_profit" ? "이상" : "이하"}</td><td>{l.qty ? `${l.qty}주` : "전부"}</td>
                        <td>{d.last?.[l.ticker] ? `${money(d.market, d.last[l.ticker].price)} (${d.last[l.ticker].at})` : ""}</td><td>{l.label}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
                {d.sells.length > 0 && (
                  <div className="tablewrap" style={{ marginTop: 6 }}><table>
                    <thead><tr><th>시각</th><th>종목</th><th>닿은 가격</th><th>수량</th><th>상태</th><th>체결</th></tr></thead>
                    <tbody>{d.sells.map((s, i) => (
                      <tr key={i}><td>{s.at}</td><td>{s.name}<div className="help">{s.label}</div></td><td>{money(d.market, s.level)} (현재가 {money(d.market, s.seen)})</td><td>{s.qty}주</td>
                        <td>{ST[s.status]}{s.error ? <div className="help">{s.error}</div> : null}</td><td>{s.filledQty > 0 ? `${s.filledQty}주 · ${money(d.market, s.avgPrice)}` : ""}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
                {d.log.length > 0 && <ul className="help" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{d.log.slice(-8).map((l, i) => <li key={i}>{l}</li>)}</ul>}
              </details>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
