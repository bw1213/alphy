"use client";

import { useCallback, useEffect, useState } from "react";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import { StockSearch } from "@/components/StockSearch";
import { STRATEGIES } from "@/lib/strategies";
import type { SavedStrategy } from "@/lib/strategies/library";
import type { EveningReport } from "@/lib/auto/evening";

interface PlanView {
  label: string; kind: "builtin" | "cycle" | "builder" | "custom"; strategyName: string | null; builtin: string | null;
  tickers: string[]; budget: number; startDate: string; enabled: boolean; updatedAt: string;
}
interface AutoState {
  plan: PlanView | null; log: EveningReport[]; eveningTime: string; owner: boolean; today: string;
  lastEvening: { date: string; attempts: number; done: boolean } | null;
}
interface TgState { botSet: boolean; bot: string | null; owner: boolean; linked: boolean; chatName: string | null; code: string | null }

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function Report({ r }: { r: EveningReport }) {
  if (r.status === "error") return <div className="error">계산하지 못했습니다: {r.error}</div>;
  if (r.status === "holiday") return <p className="help">{r.warnings[0] ?? "휴장일로 보고 건너뛰었습니다."}</p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="kpis">
        <div className="kpi"><div className="k">전략 평가액</div><div className="v">{won(r.equity ?? 0)}</div><div className="s">현금 {won(r.cash ?? 0)} · 시세 {r.dataDate}</div></div>
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
            <thead><tr><th>종목</th><th>기준 가격</th><th>오늘 종가</th><th>차이</th><th>규칙</th></tr></thead>
            <tbody>{r.sellLevels.map((s, i) => (
              <tr key={i}><td>{s.name}</td><td>{won(s.price)} {s.kind === "take_profit" ? "이상" : "이하"}</td><td>{won(s.close)}</td><td>{s.gap >= 0 ? "+" : ""}{s.gap.toFixed(1)}%</td><td>{s.label}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="help">장중에 이 가격에 닿으면 바로 파는 기능은 다음 단계에서 붙습니다. 지금은 알림으로만 알려 드립니다.</p>
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
  const [form, setForm] = useState({ strategy: "", tickers: "", budget: "1000000", startDate: "", enabled: true });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [token, setToken] = useState("");
  const [time, setTime] = useState("");
  const [sendTg, setSendTg] = useState(false);
  const [open, setOpen] = useState(0);

  const load = useCallback(async () => {
    const [a, t, l] = await Promise.all([
      fetch("/api/auto", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/telegram", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/strategies", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
    ]);
    if (a) {
      setSt(a); setTime(a.eveningTime);
      const p: PlanView | null = a.plan;
      if (p) setForm({ strategy: p.builtin ? `builtin:${p.builtin}` : `saved:${p.strategyName}`, tickers: p.tickers.join(", "), budget: String(p.budget), startDate: p.startDate, enabled: p.enabled });
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
        <p>운용 전략을 정해 두면 평일 저녁 {st?.eveningTime ?? "18:00"}에 오늘 종가로 계산해 내일 주문과 장중 매도 가격을 텔레그램으로 알려 드립니다.</p>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}><a href="/">백테스트</a><a href="/trade">주문·잔고</a><a href="/settings">설정</a></span>
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
            {isCustom && !auth?.user?.owner && <p className="help">직접 작성한 코드 전략은 서버에서 매일 실행되므로 관리자만 운용할 수 있습니다.</p>}
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
            <p className="help">시작일 저녁에 첫 계산을 하고, 다음 거래일 아침부터 운용 금액으로 이 전략을 돌린 것처럼 매일 다시 계산합니다. 적립·분할 매도의 최고가도 이때부터 잽니다.</p>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 8 }}>
              <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 매일 저녁 자동 계산·알림 켜기
            </label>
            <div className="btns" style={{ marginTop: 12 }}>
              <button className="primary" disabled={!!busy || !form.strategy} onClick={() => act("save", () => post("/api/auto", { action: "save", ...form, budget: Number(form.budget) }), "저장했습니다. 보관함에서 전략을 고쳐도 여기서 다시 저장해야 운용에 반영됩니다.")}>{busy === "save" ? "저장 중…" : "저장"}</button>
              {st?.plan && <button disabled={!!busy} onClick={() => act("del", () => post("/api/auto", { action: "delete" }), "운용 전략을 지웠습니다.")}>운용 그만두기</button>}
            </div>
            {st?.plan && <p className="help">지금 운용: <b>{st.plan.label}</b> · {won(st.plan.budget)} · {st.plan.startDate}부터 · {st.plan.enabled ? "켜짐" : "꺼짐"}</p>}
          </div>

          <div className="card">
            <h2>텔레그램 알림</h2>
            {!tg ? <p className="help">확인 중…</p> : (
              <>
                {tg.owner && (
                  <div style={{ marginBottom: 12 }}>
                    <p className="help" style={{ marginTop: 0 }}>관리자: 봇을 한 번 연결해 두면 모든 사람이 이 봇으로 알림을 받습니다. {tg.botSet ? <span className="badge ok">@{tg.bot} 연결됨</span> : <span className="badge no">봇 없음</span>}</p>
                    {!tg.botSet && <p className="help">텔레그램에서 @BotFather 에게 /newbot 을 보내 봇을 만들고, 받은 토큰을 아래에 넣으세요.</p>}
                    <div className="row">
                      <input type="password" placeholder={tg.botSet ? "새 토큰으로 바꾸기 (비우고 저장하면 해제)" : "봇 토큰 (123456:ABC…)"} value={token} onChange={(e) => setToken(e.target.value)} />
                      <button disabled={!!busy} onClick={() => act("token", () => post("/api/telegram", { action: "token", token }), token ? "봇을 연결했습니다." : "봇 연결을 해제했습니다.").then(() => setToken(""))}>{busy === "token" ? "확인 중…" : "봇 저장"}</button>
                    </div>
                  </div>
                )}
                {!tg.botSet ? <p className="help">관리자가 봇을 연결하면 여기서 내 텔레그램을 연결할 수 있습니다.</p> : tg.linked ? (
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
              <h2>저녁 계산 시각</h2>
              <div className="row">
                <input value={time} placeholder="18:00" onChange={(e) => setTime(e.target.value)} />
                <button disabled={!!busy} onClick={() => act("time", () => post("/api/auto", { action: "time", eveningTime: time }), "계산 시각을 바꿨습니다.")}>저장</button>
              </div>
              <p className="help">평일 이 시각 이후 하루 한 번 모든 사람의 운용 전략을 계산합니다. 시세가 확정되도록 16:00 이후로 정하세요. NAS 가 꺼져 있었다면 켜진 뒤 그날 자정 전까지 계산합니다.</p>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {msg && <p className="help" style={{ color: "var(--good)" }}>{msg}</p>}
        </section>

        <section className="stack">
          <div className="card">
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>저녁 계산 결과
              <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", fontSize: 12, fontWeight: 400 }}>
                {tg?.linked && <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" style={{ width: "auto", flex: "none" }} checked={sendTg} onChange={(e) => setSendTg(e.target.checked)} />텔레그램으로도</label>}
                <button disabled={!!busy || !st?.plan} onClick={() => act("run", () => post("/api/auto", { action: "run", notify: sendTg })).then(() => setOpen(0))}>{busy === "run" ? "계산 중…" : "지금 계산해 보기"}</button>
              </span>
            </h2>
            {st?.lastEvening && <p className="help" style={{ marginTop: 0 }}>마지막 자동 계산: {st.lastEvening.date} ({st.lastEvening.done ? "완료" : `시도 ${st.lastEvening.attempts}번`})</p>}
            {!st?.log.length ? <p className="help">아직 계산 기록이 없습니다. 운용 전략을 저장하고 "지금 계산해 보기"를 눌러 보세요.</p> : (
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
            <h2>지금 되는 것과 다음 단계</h2>
            <ul style={{ fontSize: 13, paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
              <li>지금: 저녁 계산, 내일 주문 목록, 장중 매도 기준 가격, 텔레그램 알림. <b>주문은 아직 내지 않습니다.</b></li>
              <li>다음: 아침 8~10시 자동 매수(모의투자부터), 체결 확인·미체결 취소</li>
              <li>그다음: 장중 실시간 매도, 성과 기록, 실전 전환</li>
            </ul>
          </div>
        </section>
      </main>
    </>
  );
}
