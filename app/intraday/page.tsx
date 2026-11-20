"use client";

import { useEffect, useState } from "react";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import Info from "@/components/Info";
import DayTradePanel from "@/components/DayTradePanel";
import { StockChips, StockSearch, appendCode } from "@/components/StockSearch";
import { fetchJob, type Progress } from "@/lib/client/fetchData";
import type { IntradayReport, Span, StrategyResult, Summary, TickerResult } from "@/lib/intraday/study";

const KEY = "alphy.intraday.form";
const yearAgo = () => new Date(Date.now() + 9 * 3600_000 - 365 * 864e5).toISOString().slice(0, 10);
const DEFAULT = { tickers: "", start: "", barMinutes: 5, commission: 0.015, slippage: 0.02 };

const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "-" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const tone = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? undefined : x > 0 ? "var(--bad)" : x < 0 ? "var(--accent)" : undefined);
const Ret = ({ x }: { x: number | null | undefined }) => <span style={{ color: tone(x) }}>{pct(x)}</span>;

function PeriodRow({ label, s }: { label: string; s: { pick: Span | Summary | null; check: Span | Summary | null; all: Span | Summary | null } }) {
  return (
    <tr>
      <td>{label}</td>
      <td><Ret x={s.pick?.totalReturn} /></td>
      <td><Ret x={s.check?.totalReturn} /></td>
      <td>{pct(s.check?.mdd)}</td>
      <td><Ret x={s.all?.totalReturn} /></td>
      <td>{pct(s.all?.mdd)}</td>
    </tr>
  );
}

function StrategyRow({ s }: { s: StrategyResult }) {
  return (
    <tr>
      <td>{s.name}<Info>{s.desc}</Info><div className="help">{s.label}</div></td>
      <td><Ret x={s.pick.totalReturn} /></td>
      <td><b><Ret x={s.check.totalReturn} /></b></td>
      <td>{pct(s.check.mdd)}</td>
      <td><Ret x={s.all.totalReturn} /></td>
      <td>{pct(s.all.mdd)}</td>
      <td>{s.all.trades}</td>
      <td>{s.all.trades ? `${Math.round(s.all.winRate * 100)}%` : "-"}</td>
      <td>{pct(s.all.avgGross, 2)} → {pct(s.all.avgNet, 2)}</td>
      <td>{s.positive.count}/{s.positive.of}</td>
    </tr>
  );
}

function verdict(t: TickerResult): string {
  const real = t.strategies.filter((s) => !s.baseline);
  if (!real.length) return "";
  const best = real.reduce((a, b) => (b.check.totalReturn > a.check.totalReturn ? b : a));
  const hold = t.hold.check.totalReturn;
  if (best.check.totalReturn <= 0) return `확인 구간에서 비용을 빼고 돈을 번 단타 전략이 없습니다 (가장 나은 것: ${best.name} ${pct(best.check.totalReturn)}).`;
  if (best.check.totalReturn <= hold) return `확인 구간에서 가장 나은 단타 전략(${best.name} ${pct(best.check.totalReturn)})도 그냥 들고 있기(${pct(hold)})보다 못했습니다.`;
  return `확인 구간에서 ${best.name}이(가) ${pct(best.check.totalReturn)}로 그냥 들고 있기(${pct(hold)})보다 나았습니다. 기간이 짧아 우연일 수 있으니 모의 계좌로 더 지켜봐야 합니다.`;
}

function TickerCard({ t, rep }: { t: TickerResult; rep: IntradayReport }) {
  return (
    <div className="card">
      <h2>{t.name} ({t.code})</h2>
      <p className="desc">{t.from} ~ {t.to} · {t.days}거래일 · {rep.barMinutes}분봉 · 비용: 수수료 {(t.costs.commission * 100).toFixed(3)}% ×2, 매도세 {(t.costs.sellTax * 100).toFixed(2)}%{t.etf ? " (ETF 면제)" : ""}, 시장가 1호가 ≈ {(t.costs.tickPct * 100).toFixed(3)}% + 슬리피지 {(t.costs.slippage * 100).toFixed(3)}%</p>
      <p style={{ fontSize: 14, margin: "10px 0" }}>{verdict(t)}</p>
      <div className="tablewrap"><table>
        <thead>
          <tr><th>전략 (고른 설정)</th><th>고르는 구간</th><th>확인 구간</th><th>확인 MDD</th><th>전체</th><th>전체 MDD</th><th>거래</th><th>승률</th><th>1회 평균 (비용 전→후)</th><th>플러스인 설정</th></tr>
        </thead>
        <tbody>
          {t.strategies.map((s) => <StrategyRow key={s.id} s={s} />)}
          <PeriodRow label="그냥 들고 있기" s={t.hold} />
          {rep.indices.map((ix) => <PeriodRow key={ix.name} label={ix.name} s={ix} />)}
        </tbody>
      </table></div>
    </div>
  );
}

export default function IntradayPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [form, setForm] = useState(DEFAULT);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [rep, setRep] = useState<IntradayReport | null>(null);
  const [tab, setTab] = useState<"pick" | "fixed">("pick");

  useEffect(() => {
    fetchAuth().then(setAuth).catch(() => setError("로그인 상태를 읽지 못했습니다"));
    try { const v = JSON.parse(localStorage.getItem(KEY) ?? "null"); if (v) setForm({ ...DEFAULT, ...v }); } catch { /* 없음 */ }
  }, []);
  const set = (p: Partial<typeof DEFAULT>) => setForm((f) => {
    const n = { ...f, ...p };
    try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* 저장 못 해도 됨 */ }
    return n;
  });

  const runIt = async () => {
    setBusy(true); setError(""); setProgress(null);
    try {
      const body = { tickers: form.tickers.split(/[\s,]+/).filter(Boolean), start: form.start || undefined, barMinutes: form.barMinutes, commission: form.commission, slippage: form.slippage };
      setRep(await fetchJob<IntradayReport>("/api/intraday", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, setProgress, undefined, 1500, undefined, "단타 전략 찾기"));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setProgress(null); }
  };

  return (
    <>
      <header className="top">
        <h1>단타 전략 찾기</h1>
        <p>하루 안에 사고파는 전략을 1분봉으로 시험합니다.</p>
        <div className="seg" style={{ marginLeft: 16 }}>
          <button className={tab === "pick" ? "on" : ""} onClick={() => setTab("pick")}>날마다 종목 고르기</button>
          <button className={tab === "fixed" ? "on" : ""} onClick={() => setTab("fixed")}>종목 정해서</button>
        </div>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}><a href="/">백테스트</a><a href="/auto">자동 매매</a><a href="/trade">주문·잔고</a><a href="/settings">설정</a></span>
      </header>
      {auth && !auth.loggedIn && <div style={{ padding: 16 }}><Login auth={auth} onDone={() => fetchAuth().then(setAuth)} /></div>}
      {tab === "pick" ? <main className="app"><DayTradePanel /></main> : <main className="app">
        <section className="stack">
          <div className="card">
            <h2>조건</h2>
            <label className="f">종목 (국내, 6개까지)
              <StockSearch keepOpen exclude={form.tickers.split(/[\s,]+/)} onPick={(s) => set({ tickers: appendCode(form.tickers, s.code) })} />
            </label>
            <StockChips value={form.tickers} onChange={(v) => set({ tickers: v })} />
            <div className="row" style={{ marginTop: 10 }}>
              <label className="f">시작일
                <input type="date" value={form.start} min={yearAgo()} placeholder={yearAgo()} onChange={(e) => set({ start: e.target.value })} />
              </label>
              <label className="f">봉
                <select value={form.barMinutes} onChange={(e) => set({ barMinutes: Number(e.target.value) })}>
                  {[1, 3, 5, 10].map((m) => <option key={m} value={m}>{m}분</option>)}
                </select>
              </label>
              <label className="f">수수료 (%, 한 번)
                <input type="number" step="0.001" min="0" value={form.commission} onChange={(e) => set({ commission: Number(e.target.value) })} />
              </label>
              <label className="f">슬리피지 (%, 한 번)
                <input type="number" step="0.01" min="0" value={form.slippage} onChange={(e) => set({ slippage: Number(e.target.value) })} />
              </label>
            </div>
            <p className="help">비우면 1년 전부터 (한국투자증권이 1분봉을 1년치만 보관). 처음엔 종목마다 1~3분 걸리고, 받은 분봉은 저장돼 다음부터 빠릅니다.
              <Info>
                신호는 봉이 끝날 때 보고 다음 봉 시가에 시장가로 산다고 봅니다. 시장가는 1호가 불리하게, 시가·종가 동시호가는 슬리피지만 붙입니다.
                주식은 매도 때 거래세가 붙고 ETF·ETN 은 없습니다. 모든 전략은 매수만 하고 그날 종가 전에 정리합니다.
                기간의 앞 2/3(고르는 구간)에서 가장 좋았던 설정을 뒤 1/3(확인 구간)에 그대로 써 본 결과가 &quot;확인 구간&quot;입니다. 확인 구간 숫자를 보세요.
              </Info>
            </p>
            <button className="primary" style={{ marginTop: 12 }} disabled={busy || !form.tickers.trim()} onClick={runIt}>
              {busy ? <><span className="spin" />{progress ? `분봉 받는 중 ${progress.done}/${progress.total}일` : "계산 중…"}</> : "실행"}
            </button>
          </div>
        </section>
        <section className="stack">
          {error && <div className="error">{error}</div>}
          {rep?.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
          {rep?.split && <p className="desc">고르는 구간 {rep.split.pickFrom} ~ {rep.split.pickTo} · 확인 구간 {rep.split.checkFrom} ~ {rep.split.checkTo}. 수익률은 그 구간 누적이고, 1년이 안 되니 연 환산하지 않았습니다.</p>}
          {rep?.tickers.map((t) => <TickerCard key={t.code} t={t} rep={rep} />)}
          {!rep && !error && <div className="card empty">종목을 고르고 실행하세요.</div>}
        </section>
      </main>}
    </>
  );
}
