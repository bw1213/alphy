"use client";

import { useEffect, useState } from "react";
import Info from "@/components/Info";
import { fetchJob, type Progress } from "@/lib/client/fetchData";
import type { DayTradeReport } from "@/lib/intraday/daytrade";
import { DEFAULT_DAYTRADE, type DayTradeSpec } from "@/lib/intraday/screen";
import type { SavedDayTrade } from "@/lib/intraday/store";

const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "-" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const tone = (x: number) => (x > 0 ? "var(--bad)" : x < 0 ? "var(--accent)" : undefined);
const hm = (t: number) => `${String(Math.floor(t / 100)).padStart(2, "0")}:${String(t % 100).padStart(2, "0")}`;

const FIELDS: { key: keyof DayTradeSpec; label: string; step?: string }[] = [
  { key: "minValue", label: "20일 평균 거래대금 (억 원 이상)" },
  { key: "minPrice", label: "주가 (원 이상)" },
  { key: "belowMa", label: "전날 종가가 20일 평균보다 (% 넘게 낮음)" },
  { key: "gap", label: "시가가 전날 종가보다 (% 넘게 낮게 시작)", step: "0.5" },
  { key: "maxPicks", label: "하루 최대 종목 수" },
  { key: "weight", label: "종목당 자금 (%)" },
  { key: "takeProfit", label: "익절 (%, 0 = 없음)", step: "0.5" },
  { key: "stopLoss", label: "손절 (%, 0 = 없음)", step: "0.5" },
];

export default function DayTradePanel() {
  const [spec, setSpec] = useState<DayTradeSpec>(DEFAULT_DAYTRADE);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [rep, setRep] = useState<DayTradeReport | null>(null);
  const [saved, setSaved] = useState<SavedDayTrade[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");

  const loadSaved = () => fetch("/api/daytrade", { cache: "no-store" }).then((r) => r.json()).then((j) => setSaved(j.items ?? [])).catch(() => undefined);
  useEffect(() => { loadSaved(); }, []);

  const post = async (body: object) => {
    const r = await fetch("/api/daytrade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };

  const run = async () => {
    setBusy(true); setError(""); setProgress(null);
    try {
      setRep(await fetchJob<DayTradeReport>("/api/daytrade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run", spec }) }, setProgress, undefined, 3000, undefined, "단타 백테스트"));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setProgress(null); }
  };

  const save = async (overwrite = false) => {
    setMsg(""); setError("");
    try { const j = await post({ action: "save", name, spec, overwrite }); setSaved(j.items); setMsg(`'${name}' 저장했습니다.`); }
    catch (e) { setError((e as Error).message); }
  };

  const r = rep?.result;
  return (
    <>
      <section className="stack">
        <div className="card">
          <h2>종목 고르는 규칙</h2>
          <p className="desc">전날까지의 일봉과 오늘 시가로 종목을 고르고, 시가(장 시작 동시호가)에 사서 익절·손절·종가 중 먼저 닿는 때 팝니다.
            <Info>
              국내 주식(ETF 제외) 전체에서 매일 고릅니다. 시가는 장 시작 전 예상체결가로 미리 알 수 있는 값이라 그날 아침에 쓸 수 있습니다.
              1분봉으로 익절·손절이 먼저 닿는 순서를 따지고, 같은 1분 안에 둘 다 닿으면 손절로 봅니다.
              비용: 수수료 0.015%씩, 매도세(연도별), 손절은 1호가 불리 + 슬리피지 0.05%. 09:01 이후에 사면 결과가 크게 나빠지니 동시호가 매수가 전제입니다.
            </Info>
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            {FIELDS.map((f) => (
              <label key={f.key} className="f">{f.label}
                <input type="number" step={f.step ?? "1"} min="0" value={spec[f.key] as number} onChange={(e) => setSpec({ ...spec, [f.key]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 8 }}>
            <input type="checkbox" checked={spec.prevDown} onChange={(e) => setSpec({ ...spec, prevDown: e.target.checked })} /> 전날도 내린 종목만
          </label>
          <button className="primary" style={{ marginTop: 12 }} disabled={busy} onClick={run}>
            {busy ? <><span className="spin" />{progress ? `받는 중 ${progress.done}/${progress.total}` : "계산 중…"}</> : "최근 1년 백테스트"}
          </button>
          <p className="help">처음엔 전 종목 일봉과 고른 종목의 1분봉을 받느라 10분 넘게 걸릴 수 있어요. 받은 것은 저장돼 다음부터 빠릅니다.</p>
        </div>
        <div className="card">
          <h2>내 단타 전략</h2>
          {!saved.length && <p className="help">아직 없습니다.</p>}
          {saved.map((s) => (
            <div key={s.name} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "4px 0" }}>
              <button className="link" type="button" onClick={() => { setSpec(s.spec); setName(s.name); setRep(null); }}>{s.name}</button>
              <span className="help" style={{ margin: 0 }}>갭 −{s.spec.gap}% · 익절 {s.spec.takeProfit || "-"}% · 손절 {s.spec.stopLoss || "-"}%</span>
              <button className="link" type="button" style={{ marginLeft: "auto" }} onClick={() => post({ action: "delete", name: s.name }).then((j) => setSaved(j.items)).catch((e) => setError(e.message))}>지우기</button>
            </div>
          ))}
          {saved.find((s) => s.name === name)?.note && <p className="desc">{saved.find((s) => s.name === name)!.note}</p>}
          <div className="row" style={{ marginTop: 10, gridTemplateColumns: "1fr auto" }}>
            <input placeholder="전략 이름" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="button" disabled={!name.trim()} onClick={() => save(saved.some((s) => s.name === name.trim()))}>{saved.some((s) => s.name === name.trim()) ? "덮어쓰기" : "저장"}</button>
          </div>
          {msg && <p className="saved">{msg}</p>}
        </div>
      </section>
      <section className="stack">
        {error && <div className="error">{error}</div>}
        {rep?.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
        {!rep && !error && <div className="card empty">규칙을 정하고 백테스트를 실행하세요.</div>}
        {rep && r && (
          <>
            <div className="kpis">
              <div className="kpi"><div className="help">수익률 ({rep.from} ~ {rep.to})</div><b style={{ color: tone(r.totalReturn) }}>{pct(r.totalReturn)}</b></div>
              <div className="kpi"><div className="help">최대 낙폭</div><b>{pct(r.mdd)}</b></div>
              <div className="kpi"><div className="help">매매 · 승률</div><b>{r.trades}번 · {Math.round(r.winRate * 100)}%</b></div>
              <div className="kpi"><div className="help">1번 평균 (비용 뺀 것)</div><b style={{ color: tone(r.avgNet) }}>{pct(r.avgNet, 2)}</b></div>
            </div>
            <div className="card">
              <h2>비교</h2>
              <div className="tablewrap"><table>
                <thead><tr><th></th><th>수익률</th><th>최대 낙폭</th></tr></thead>
                <tbody>
                  <tr><td>이 단타 규칙</td><td>{pct(r.totalReturn)}</td><td>{pct(r.mdd)}</td></tr>
                  {rep.indices.map((ix) => <tr key={ix.name}><td>{ix.name}</td><td>{pct(ix.totalReturn)}</td><td>{pct(ix.mdd)}</td></tr>)}
                  {rep.halves.map((h, i) => <tr key={i}><td>{i ? "뒤 절반" : "앞 절반"} ({h.from} ~ {h.to})</td><td>{pct(h.totalReturn)}</td><td>{h.trades}번 · 평균 {pct(h.avgNet, 2)}</td></tr>)}
                </tbody>
              </table></div>
              <p className="help">팔린 방식: {Object.entries(r.exits).map(([k, v]) => `${k} ${v}번`).join(" · ")} · 매매한 날 {r.activeDays}일 / {rep.days}거래일 · 대상 {rep.stocks.toLocaleString("ko-KR")}종목</p>
            </div>
            <div className="card">
              <h2>달마다</h2>
              <div className="tablewrap"><table>
                <thead><tr>{rep.monthly.map((m) => <th key={m.month}>{m.month.slice(2)}</th>)}</tr></thead>
                <tbody>
                  <tr>{rep.monthly.map((m) => <td key={m.month} style={{ color: tone(m.ret) }}>{pct(m.ret)}</td>)}</tr>
                  <tr>{rep.monthly.map((m) => <td key={m.month} className="help">{m.trades}번</td>)}</tr>
                </tbody>
              </table></div>
            </div>
            <div className="card">
              <h2>최근 매매</h2>
              <div className="tablewrap"><table>
                <thead><tr><th>날짜</th><th>종목</th><th>시가 갭</th><th>매수</th><th>매도</th><th>방식</th><th>손익 (비용 뺀 것)</th></tr></thead>
                <tbody>
                  {rep.trades.slice(0, 60).map((t) => (
                    <tr key={`${t.date}-${t.code}`}>
                      <td>{t.date}</td><td>{t.name ? `${t.name} (${t.code})` : t.code}</td><td>{pct(t.gap)}</td>
                      <td>{t.buy.toLocaleString("ko-KR")}</td><td>{t.sell.toLocaleString("ko-KR")}</td>
                      <td>{t.exit} {hm(t.at)}</td><td style={{ color: tone(t.net) }}>{pct(t.net, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
