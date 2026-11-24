"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import { fetchJob } from "@/lib/client/fetchData";
import type { AutoOrder } from "@/lib/auto/evening";
import type { ManualPosition, ManualTrade } from "@/lib/manual/store";
import type { KisView, PriceBook, Snapshot } from "@/lib/manual/value";
import type { Fill } from "@/lib/accounts/fills";
import { accountReturns, combinedReturns, since, type Flow, type ReturnPoint } from "@/lib/manual/returns";
import { withCode } from "@/lib/strategies/universe";
import Info from "@/components/Info";
import AppNav from "@/components/AppNav";
import FlowEditor from "@/components/accounts/FlowEditor";

interface Last { runDate: string; orders: AutoOrder[]; equity: number | null; label: string }
interface DashState {
  today: string;
  prices: PriceBook | null;
  points: Record<string, Snapshot[]>;
  flows: Record<string, Flow[]>;
  retFlows?: Record<string, Flow[]>;
  kis: { view: KisView | null; plan: { label: string; budget: number; enabled: boolean; market: "KR" | "US" } | null; last: Last | null } | null;
  kisId: string;
  manual: { id: string; name: string; broker: string; cash: number; positions: ManualPosition[]; plan: { label: string; budget: number; enabled: boolean } | null; last: Last | null }[];
  trades: ManualTrade[];
  fills?: Fill[];
}

/** 화면에서 쓰는 계좌 하나 (한국투자증권·수동 모두 같은 모양) */
interface Acct {
  id: string; name: string; broker: string; kind: "auto" | "manual";
  total: number; cash: number; cost: number;
  holdings: { ticker: string; name: string; qty: number; avgPrice: number; price: number | null; value: number }[];
  plan: string | null; last: Last | null; slot: number;
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
/** 큰 금액을 짧게: 1.2억, 3,400만 */
const short = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1)}억`;
  if (a >= 1e4) return `${s}${Math.round(a / 1e4).toLocaleString("ko-KR")}만`;
  return `${s}${Math.round(a).toLocaleString("ko-KR")}`;
};
const signed = (n: number) => `${n >= 0 ? "+" : "-"}${won(Math.abs(n))}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

const SLOTS = 8;
const PICK_KEY = "alphy.dashboard.accounts";

function useColors() {
  const read = () => {
    const fallback = { s: ["#2a78d6", "#eb6834", "#1f9e89", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"], grid: "#ecebe7", t2: "#52514e", t3: "#8a8984", up: "#c62828", down: "#2a78d6", surface: "#fcfcfb" };
    if (typeof window === "undefined") return fallback;
    const cs = getComputedStyle(document.documentElement);
    const g = (k: string) => cs.getPropertyValue(k).trim();
    return { s: Array.from({ length: SLOTS }, (_, i) => g(`--series-${i + 1}`) || fallback.s[i]), grid: g("--grid"), t2: g("--text-2"), t3: g("--text-3"), up: g("--bad"), down: g("--accent"), surface: g("--surface") };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const f = () => setC(read());
    f();
    m.addEventListener("change", f);
    const mo = new MutationObserver(f);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { m.removeEventListener("change", f); mo.disconnect(); };
  }, []);
  return c;
}

function Tip({ active, payload, label, fmt = won, total }: any) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p: any) => p.value != null);
  return (
    <div className="chart-tip">
      {label != null && <div className="d">{label}</div>}
      {rows.map((p: any) => (
        <div className="r" key={p.dataKey + p.name}>
          <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: p.color ?? p.payload?.fill, marginRight: 6 }} />{p.name}</span>
          <b>{fmt(p.value)}</b>
        </div>
      ))}
      {total && rows.length > 1 && <div className="r" style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4 }}><span>합계</span><b>{fmt(rows.reduce((s: number, p: any) => s + p.value, 0))}</b></div>}
    </div>
  );
}

/** 막대 하나에 이름·값 툴팁 */
function BarTip({ active, payload, fmt = won }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="d">{d.name}</div>
      <div className="r"><span>{payload[0].name}</span><b>{fmt(payload[0].value)}</b></div>
      {d.note && <div className="r"><span>{d.note}</span></div>}
    </div>
  );
}

/** 계좌 고르기 버튼 모양 */
const chip = (on: boolean): React.CSSProperties => ({
  width: "auto", whiteSpace: "nowrap", padding: "4px 10px", fontSize: 12, borderRadius: 999, display: "inline-flex", alignItems: "center",
  ...(on ? { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 600 } : {}),
});

export default function DashboardPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [st, setSt] = useState<DashState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warn, setWarn] = useState<string[]>([]);
  const [range, setRange] = useState<"1M" | "3M" | "1Y" | "ALL">("3M");
  const [table, setTable] = useState(false);
  // 고른 계좌 (null = 전체). 이 브라우저에만 기억
  const [pick, setPick] = useState<string[] | null>(null);
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(PICK_KEY) ?? "null"); if (Array.isArray(v)) setPick(v); } catch { /* 없음 */ } }, []);
  const savePick = (v: string[] | null) => { setPick(v); try { if (v) localStorage.setItem(PICK_KEY, JSON.stringify(v)); else localStorage.removeItem(PICK_KEY); } catch { /* 저장 못 함 */ } };
  const c = useColors();

  const load = useCallback(async () => {
    const r = await fetch("/api/dashboard", { cache: "no-store" });
    if (r.ok) setSt(await r.json()); else setError("대시보드를 읽지 못했습니다.");
  }, []);
  useEffect(() => { fetchAuth().then((a) => { setAuth(a); if (a.loggedIn) load(); }).catch(() => setError("로그인 상태를 읽지 못했습니다")); }, [load]);

  const refresh = async () => {
    setBusy(true); setError(""); setWarn([]);
    try {
      const r: any = await fetchJob("/api/dashboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refresh" }) }, undefined, undefined, 720, 2000, "새로 고침");
      setWarn(r?.warnings ?? []);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const all = useMemo<Acct[]>(() => {
    if (!st) return [];
    const out: Acct[] = [];
    if (st.kis) {
      const v = st.kis.view;
      out.push({
        id: st.kisId, name: `한국투자증권${v?.env === "mock" ? " (모의)" : ""}`, broker: "한국투자증권", kind: "auto",
        total: v?.total ?? 0, cash: v?.cash ?? 0, cost: v ? v.positions.reduce((s, p) => s + p.qty * p.avgPrice, 0) : 0,
        holdings: (v?.positions ?? []).map((p) => ({ ticker: p.ticker, name: p.name, qty: p.qty, avgPrice: p.avgPrice, price: p.price || null, value: p.value })),
        plan: st.kis.plan ? `${st.kis.plan.label} (자동${st.kis.plan.enabled ? "" : ", 꺼짐"})` : null, last: st.kis.last, slot: 0,
      });
    }
    for (const a of st.manual) {
      const hs = a.positions.map((p) => {
        const px = st.prices?.map[p.ticker]?.close ?? null;
        return { ticker: p.ticker, name: p.name ?? st.prices?.map[p.ticker]?.name ?? p.ticker, qty: p.qty, avgPrice: p.avgPrice, price: px, value: p.qty * (px ?? p.avgPrice) };
      });
      out.push({
        id: a.id, name: a.name, broker: a.broker, kind: "manual", cash: a.cash, total: a.cash + hs.reduce((s, h) => s + h.value, 0),
        cost: hs.reduce((s, h) => s + h.qty * h.avgPrice, 0), holdings: hs,
        plan: a.plan ? `${a.plan.label}${a.plan.enabled ? "" : " (꺼짐)"}` : null, last: a.last, slot: 0,
      });
    }
    // 색은 계좌 순서로 고정 (8개 넘으면 9번째부터 "기타"로 묶음)
    out.forEach((a, i) => { a.slot = Math.min(i, SLOTS - 1); });
    return out;
  }, [st]);

  // 지운 계좌는 고른 목록에서 빼고, 남는 게 없으면 전체
  const picked = useMemo(() => {
    if (!pick) return null;
    const ids = pick.filter((id) => all.some((a) => a.id === id));
    return ids.length || !all.length ? ids : null;
  }, [pick, all]);
  const accts = useMemo(() => (picked ? all.filter((a) => picked.includes(a.id)) : all), [all, picked]);
  const toggle = (id: string) => {
    // 전체 보기에서 누르면 그 계좌만, 그다음부터는 더하고 빼기
    if (!picked) return savePick([id]);
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    savePick(next.length === all.length ? null : next);
  };

  const many = all.length > SLOTS;
  const seriesOf = (a: Acct) => (many && a.slot === SLOTS - 1 ? "other" : a.id);
  const seriesName = (k: string) => (k === "other" ? "기타 계좌" : accts.find((a) => a.id === k)?.name ?? k);
  const seriesKeys = [...new Set(accts.map(seriesOf))];
  const slotOf = (k: string) => (k === "other" ? SLOTS - 1 : accts.find((a) => a.id === k)?.slot ?? 0);

  const total = accts.reduce((s, a) => s + a.total, 0);
  const cash = accts.reduce((s, a) => s + a.cash, 0);
  const priced = accts.flatMap((a) => a.holdings.filter((h) => h.price != null));
  const pnl = priced.reduce((s, h) => s + h.value - h.qty * h.avgPrice, 0);
  const pnlBase = priced.reduce((s, h) => s + h.qty * h.avgPrice, 0);
  const todo = accts.flatMap((a) => (a.last?.orders ?? []).map((o) => ({ a, o, runDate: a.last!.runDate })));

  // 1) 평가액 추이: 계좌별로 쌓기. 기록이 없는 날은 그 전 값으로 이어 감
  const trend = useMemo(() => {
    if (!st) return [];
    const ids = accts.map((a) => a.id);
    const dates = [...new Set(ids.flatMap((id) => (st.points[id] ?? []).map((p) => p.date)))].sort();
    const from = range === "ALL" ? "" : (() => { const d = new Date(`${st.today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (range === "1M" ? 1 : range === "3M" ? 3 : 12)); return d.toISOString().slice(0, 10); })();
    const lastVal: Record<string, number> = {};
    const rows: Record<string, number | string>[] = [];
    const byDate = Object.fromEntries(ids.map((id) => [id, new Map((st.points[id] ?? []).map((p) => [p.date, p.total]))]));
    for (const date of dates) {
      for (const id of ids) { const v = byDate[id].get(date); if (v != null) lastVal[id] = v; }
      if (date < from) continue;
      const row: Record<string, number | string> = { date };
      for (const a of accts) { const k = seriesOf(a); row[k] = ((row[k] as number) ?? 0) + (lastVal[a.id] ?? 0); }
      rows.push(row);
    }
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, accts, range]);

  const rets = useMemo(() => {
    const m: Record<string, ReturnPoint[]> = {};
    if (st) for (const a of all) m[a.id] = accountReturns(st.points[a.id] ?? [], (st.retFlows ?? st.flows)?.[a.id] ?? []);
    return m;
  }, [st, all]);
  const combined = useMemo(() => (st ? combinedReturns(accts.map((a) => ({ points: st.points[a.id] ?? [], flows: (st.retFlows ?? st.flows)?.[a.id] ?? [] }))) : []), [st, accts]);
  const fromDate = useMemo(() => {
    if (!st || range === "ALL") return "";
    const d = new Date(`${st.today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - (range === "1M" ? 1 : range === "3M" ? 3 : 12));
    return d.toISOString().slice(0, 10);
  }, [st, range]);
  const retChart = useMemo(() => {
    const cut = (l: ReturnPoint[]) => (fromDate ? since(l, fromDate) : l);
    const rows = new Map<string, Record<string, number | string>>();
    const put = (key: string, l: ReturnPoint[]) => { for (const p of cut(l)) { const r = rows.get(p.date) ?? { date: p.date }; r[key] = p.ret; rows.set(p.date, r); } };
    put("_all", combined);
    if (accts.length > 1) for (const a of accts) put(a.id, rets[a.id] ?? []);
    return [...rows.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
  }, [combined, rets, accts, fromDate]);
  const lastRet = combined.at(-1);
  const retColor = (v: number) => (v >= 0 ? "var(--bad)" : "var(--accent)");

  // 2) 종목별 비중 (모든 계좌 합침, 상위 10 + 기타 + 현금)
  const weights = useMemo(() => {
    const m = new Map<string, { name: string; value: number; where: Set<string> }>();
    for (const a of accts) for (const h of a.holdings) {
      const x = m.get(h.ticker) ?? { name: h.name, value: 0, where: new Set<string>() };
      x.value += h.value; x.where.add(a.name); m.set(h.ticker, x);
    }
    const list = [...m.entries()].map(([t, x]) => ({ ticker: t, name: x.name, value: x.value, note: [...x.where].join(", ") })).sort((a, b) => b.value - a.value);
    const top = list.slice(0, 10);
    const rest = list.slice(10).reduce((s, x) => s + x.value, 0);
    const rows = [...top, ...(rest > 0 ? [{ ticker: "_rest", name: `그 밖 ${list.length - 10}종목`, value: rest, note: "" }] : []), ...(cash > 0 ? [{ ticker: "_cash", name: "현금(예수금)", value: cash, note: "모든 계좌 합" }] : [])];
    return rows.map((r) => ({ ...r, pct: total > 0 ? (r.value / total) * 100 : 0 }));
  }, [accts, cash, total]);

  // 3) 종목별 평가 손익 (시세를 아는 종목만)
  const pnls = useMemo(() => {
    const m = new Map<string, { name: string; pnl: number; cost: number }>();
    for (const a of accts) for (const h of a.holdings) {
      if (h.price == null) continue;
      const x = m.get(h.ticker) ?? { name: h.name, pnl: 0, cost: 0 };
      x.pnl += h.value - h.qty * h.avgPrice; x.cost += h.qty * h.avgPrice; m.set(h.ticker, x);
    }
    return [...m.values()].map((x) => ({ name: x.name, pnl: Math.round(x.pnl), note: x.cost > 0 ? `수익률 ${pct((x.pnl / x.cost) * 100)}` : "" }))
      .sort((a, b) => b.pnl - a.pnl).slice(0, 12);
  }, [accts]);

  const byAccount = accts.map((a) => ({ name: a.name, value: Math.round(a.total), id: a.id, slot: a.slot, note: total > 0 ? `전체의 ${((a.total / total) * 100).toFixed(1)}%` : "" })).sort((x, y) => y.value - x.value);

  if (auth && !auth.loggedIn) return <main className="app"><Login auth={auth} title="로그인" onDone={() => fetchAuth().then((a) => { setAuth(a); load(); })} /></main>;

  const axis = { tick: { fill: c.t2, fontSize: 11 }, stroke: c.grid };
  const lastDate = st ? Object.values(st.points).flatMap((l) => l.map((p) => p.date)).sort().at(-1) : undefined;

  return (
    <>
      <AppNav title="전체 계좌" sub="자동·수동 계좌 한눈에 보기" />
      <main className="page">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="primary" style={{ width: "auto" }} disabled={busy || !st} onClick={refresh}>{busy ? "받는 중…" : "시세·잔고 새로 받기"}</button>
          <span className="help" style={{ margin: 0 }}>
            {st?.kis?.view ? `한국투자증권 잔고 ${st.kis.view.at.slice(0, 16).replace("T", " ")} 기준(UTC)` : st?.kis ? "한국투자증권 잔고를 아직 읽지 않았습니다." : "한국투자증권 계좌가 설정되지 않았습니다."}
            {st?.prices ? ` · 시세 ${st.prices.at.slice(0, 10)}` : ""}
          </span>
        </div>
        {error && <div className="error">{error}</div>}
        {warn.map((w, i) => <p key={i} className="help" style={{ margin: 0 }}>※ {w}</p>)}
        {st?.kis?.view?.note && <p className="help" style={{ margin: 0 }}>※ {st.kis.view.note}</p>}

        {st && all.length > 1 && (
          <div role="group" aria-label="볼 계좌" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button aria-pressed={!picked} onClick={() => savePick(null)} style={chip(!picked)}>전체</button>
            {all.map((a) => {
              const on = !!picked && picked.includes(a.id);
              return (
                <button key={a.id} aria-pressed={on} onClick={() => toggle(a.id)} style={chip(on)}>
                  <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: on || !picked ? c.s[a.slot] : "var(--border)", marginRight: 6 }} />
                  <span style={{ opacity: on || !picked ? 1 : 0.55 }}>{a.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {!st ? <div className="card"><p className="help">불러오는 중…</p></div> : !all.length ? (
          <div className="card"><p className="help">계좌가 없습니다. <a href="/settings">설정</a>이나 <a href="/accounts">계좌</a>에서 추가하세요.</p></div>
        ) : !accts.length ? (
          <div className="card"><p className="help">볼 계좌를 하나 이상 고르세요.</p></div>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi"><div className="k">전체 평가액</div><div className="v">{won(total)}</div><div className="s">계좌 {accts.length}개{picked ? ` (전체 ${all.length}개 중)` : ""}</div></div>
              <div className="kpi"><div className="k">누적 수익률<Info>입금·출금을 뺀 시간가중 수익률입니다. 첫 기록일의 평가액에서 출발해 매일 평가액 변화를 이어 곱합니다. 수동 계좌의 예수금·보유를 고치면 그 차이가 입출금으로 저절로 기록되고, 한국투자증권 계좌의 입출금은 아래 &quot;입금·출금 기록&quot;에 직접 넣으세요.</Info></div>
                <div className="v" style={{ color: lastRet && combined.length > 1 ? retColor(lastRet.ret) : undefined }}>{lastRet && combined.length > 1 ? pct(lastRet.ret) : "–"}</div>
                <div className="s">{combined.length > 1 ? `${combined[0].date}부터` : "기록이 이틀 이상 쌓이면 계산"}</div></div>
              <div className="kpi"><div className="k">보유 종목 평가 손익</div><div className="v" style={{ color: pnl >= 0 ? "var(--bad)" : "var(--accent)" }}>{signed(pnl)}</div><div className="s">{pnlBase > 0 ? `매입 원가 대비 ${pct((pnl / pnlBase) * 100)}` : "시세를 아는 종목이 없음"}</div></div>
              <div className="kpi"><div className="k">현금(예수금)</div><div className="v">{won(cash)}</div><div className="s">{total > 0 ? `현금 비중 ${((cash / total) * 100).toFixed(1)}%` : ""}</div></div>
              <div className="kpi"><div className="k">다음 거래일 할 일</div><div className="v">{todo.length}건</div><div className="s">자동 {todo.filter((x) => x.a.kind === "auto").length} · 직접 {todo.filter((x) => x.a.kind === "manual").length}</div></div>
            </div>

            <div className="card">
              <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>평가액 추이
                <span role="group" aria-label="기간" style={{ marginLeft: "auto", display: "flex", gap: 4, fontWeight: 400 }}>
                  {(["1M", "3M", "1Y", "ALL"] as const).map((r) => (
                    <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}
                      style={{ width: "auto", whiteSpace: "nowrap", padding: "4px 10px", fontSize: 12, ...(range === r ? { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 600 } : {}) }}>
                      {({ "1M": "1개월", "3M": "3개월", "1Y": "1년", ALL: "전체" } as const)[r]}
                    </button>
                  ))}
                </span>
              </h2>
              <div className="legend">{seriesKeys.map((k) => <span key={k}><i style={{ background: c.s[slotOf(k)], height: 8, width: 8, borderRadius: 2 }} />{seriesName(k)}</span>)}</div>
              {trend.length < 2 ? <p className="help">기록이 쌓이면 그려집니다{lastDate ? ` (마지막 ${lastDate})` : ""}.</p> : (
                <div style={{ height: 300 }}>
                  <ResponsiveContainer>
                    <AreaChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke={c.grid} vertical={false} />
                      <XAxis dataKey="date" {...axis} minTickGap={50} tickFormatter={(d: string) => d.slice(5)} />
                      <YAxis {...axis} width={56} tickFormatter={short} />
                      <Tooltip content={<Tip total />} />
                      {seriesKeys.map((k) => (
                        <Area key={k} dataKey={k} name={seriesName(k)} stackId="1" type="linear" stroke={c.surface} strokeWidth={2} fill={c.s[slotOf(k)]} fillOpacity={0.85} isAnimationActive={false} />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="card">
              <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>누적 수익률
                <Info>입금·출금 효과를 뺀 수익률입니다. 기간을 바꾸면 그 기간 첫날을 0%로 다시 맞춥니다.</Info>
                <span role="group" aria-label="기간" style={{ marginLeft: "auto", display: "flex", gap: 4, fontWeight: 400 }}>
                  {(["1M", "3M", "1Y", "ALL"] as const).map((r) => (
                    <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}
                      style={{ width: "auto", whiteSpace: "nowrap", padding: "4px 10px", fontSize: 12, ...(range === r ? { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 600 } : {}) }}>
                      {({ "1M": "1개월", "3M": "3개월", "1Y": "1년", ALL: "전체" } as const)[r]}
                    </button>
                  ))}
                </span>
              </h2>
              <div className="legend">
                <span><i style={{ background: "var(--text)", height: 3, width: 14, borderRadius: 2 }} />{accts.length > 1 ? "고른 계좌 합계" : accts[0]?.name}</span>
                {accts.length > 1 && accts.map((a) => <span key={a.id}><i style={{ background: c.s[a.slot], height: 8, width: 8, borderRadius: 2 }} />{a.name}</span>)}
              </div>
              {retChart.length < 2 ? <p className="help">기록이 쌓이면 그려집니다.</p> : (
                <div style={{ height: 280 }}>
                  <ResponsiveContainer>
                    <LineChart data={retChart} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke={c.grid} vertical={false} />
                      <XAxis dataKey="date" {...axis} minTickGap={50} tickFormatter={(d: string) => d.slice(5)} />
                      <YAxis {...axis} width={52} domain={["auto", "auto"]} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                      <ReferenceLine y={0} stroke={c.t3} />
                      <Tooltip content={<Tip fmt={pct} />} />
                      {accts.length > 1 && accts.map((a) => (
                        <Line key={a.id} dataKey={a.id} name={a.name} stroke={c.s[a.slot]} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
                      ))}
                      <Line dataKey="_all" name={accts.length > 1 ? "합계" : accts[0]?.name} stroke={c.t2} strokeWidth={2.5} dot={retChart.length < 3 ? { r: 4 } : false} connectNulls isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16 }}>
              <div className="card">
                <h2>계좌별 평가액</h2>
                <div style={{ height: Math.max(120, byAccount.length * 40 + 20) }}>
                  <ResponsiveContainer>
                    <BarChart data={byAccount} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }} barCategoryGap={8}>
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" {...axis} width={120} tickLine={false} />
                      <Tooltip content={<BarTip />} cursor={{ fill: c.grid }} />
                      <Bar dataKey="value" name="평가액" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                        {byAccount.map((a) => <Cell key={a.id} fill={c.s[a.slot]} />)}
                        <LabelList dataKey="value" position="right" formatter={(v: any) => short(Number(v))} style={{ fill: c.t2, fontSize: 11 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="card">
                <h2>자산 구성 (종목별 비중)<Info>회색은 현금입니다.</Info></h2>
                {!weights.length ? <p className="help">보유 종목이 없습니다.</p> : (
                  <div style={{ height: Math.max(120, weights.length * 28 + 20) }}>
                    <ResponsiveContainer>
                      <BarChart data={weights} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={6}>
                        <XAxis type="number" hide domain={[0, "dataMax"]} />
                        <YAxis type="category" dataKey="name" {...axis} width={120} tickLine={false} />
                        <Tooltip content={<BarTip fmt={(v: number) => `${v.toFixed(1)}%`} />} cursor={{ fill: c.grid }} />
                        <Bar dataKey="pct" name="비중" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                          {weights.map((w) => <Cell key={w.ticker} fill={w.ticker === "_cash" ? c.t3 : c.s[0]} />)}
                          <LabelList dataKey="pct" position="right" formatter={(v: any) => `${Number(v).toFixed(1)}%`} style={{ fill: c.t2, fontSize: 11 }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              <div className="card">
                <h2>종목별 평가 손익</h2>
                {!pnls.length ? <p className="help">시세를 아는 보유 종목이 없습니다.</p> : (
                  <div style={{ height: Math.max(120, pnls.length * 28 + 20) }}>
                    <ResponsiveContainer>
                      <BarChart data={pnls} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }} barCategoryGap={6}>
                        <XAxis type="number" hide domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
                        <YAxis type="category" dataKey="name" {...axis} width={120} tickLine={false} />
                        <ReferenceLine x={0} stroke={c.t3} />
                        <Tooltip content={<BarTip fmt={signed} />} cursor={{ fill: c.grid }} />
                        <Bar dataKey="pnl" name="평가 손익" radius={4} isAnimationActive={false}>
                          {pnls.map((p, i) => <Cell key={i} fill={p.pnl >= 0 ? c.up : c.down} />)}
                          <LabelList dataKey="pnl" content={(p: any) => {
                            const v = Number(p.value), r = Math.max(p.x, p.x + p.width);
                            // 손실 막대는 0 선 왼쪽으로 짧게 그려지므로 글자는 0 선 오른쪽에 (종목 이름과 겹치지 않게)
                            return <text x={r + 4} y={p.y + p.height / 2} dy={4} textAnchor="start" fontSize={11} fill={c.t2}>{short(v)}</text>;
                          }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                
              </div>
            </div>

            <div className="card">
              <h2>계좌별 전략 대비</h2>
              <p className="help" style={{ marginTop: 0 }}>실선 계좌 · 점선 전략</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16, marginTop: 8 }}>
                {accts.filter((a) => (st.points[a.id] ?? []).some((p) => p.strategy != null)).map((a) => {
                  const pts = (st.points[a.id] ?? []).map((p) => ({ date: p.date, account: p.total, strategy: p.strategy ?? null }));
                  return (
                    <div key={a.id}>
                      <b style={{ fontSize: 13 }}>{a.name}</b> <span className="help">{a.plan}</span>
                      <div style={{ height: 150 }}>
                        <ResponsiveContainer>
                          <LineChart data={pts} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                            <CartesianGrid stroke={c.grid} vertical={false} />
                            <XAxis dataKey="date" {...axis} minTickGap={40} tickFormatter={(d: string) => d.slice(5)} />
                            <YAxis {...axis} width={52} domain={["auto", "auto"]} tickFormatter={short} />
                            <Tooltip content={<Tip />} />
                            <Line dataKey="strategy" name="전략 계산" stroke={c.s[a.slot]} strokeDasharray="4 3" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                            <Line dataKey="account" name="계좌" stroke={c.s[a.slot]} strokeWidth={2} dot={pts.length < 3 ? { r: 4 } : false} isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!accts.some((a) => (st.points[a.id] ?? []).some((p) => p.strategy != null)) && <p className="help">기록이 쌓이면 그려집니다.</p>}
            </div>

            <div className="card">
              <h2>다음 거래일 할 일</h2>
              {!todo.length ? <p className="help">모든 계좌가 보유 유지입니다.</p> : (
                <div className="tablewrap"><table>
                  <thead><tr><th>계좌</th><th>방식</th><th>구분</th><th>종목</th><th>수량</th><th>금액(종가)</th><th>이유</th><th>계산일</th></tr></thead>
                  <tbody>{todo.map(({ a, o, runDate }, i) => (
                    <tr key={i}>
                      <td><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c.s[a.slot], marginRight: 6 }} />{a.name}</td>
                      <td><a href={`/accounts?id=${a.id}`}>{a.kind === "auto" ? "자동 주문" : "직접 주문"}</a></td>
                      <td style={{ color: o.side === "buy" ? "var(--bad)" : "var(--accent)", fontWeight: 600 }}>{o.side === "buy" ? "매수" : "매도"}</td>
                      <td>{o.name} <span className="help">{o.ticker}</span></td><td>{o.qty.toLocaleString("ko-KR")}주</td><td>{won(o.amount)}</td><td>{o.note ?? ""}</td><td>{runDate}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>

            <div className="card">
              <h2 style={{ display: "flex", alignItems: "center" }}>계좌 표
                <button style={{ marginLeft: "auto", fontWeight: 400 }} onClick={() => setTable(!table)}>{table ? "종목까지 접기" : "종목까지 펼치기"}</button>
              </h2>
              <div className="tablewrap"><table>
                <thead><tr><th>계좌</th><th>증권사</th><th>전략</th><th>평가액</th><th>예수금</th><th>평가 손익</th><th>누적 수익률</th><th>비중</th></tr></thead>
                <tbody>{accts.map((a) => {
                  const known = a.holdings.filter((h) => h.price != null);
                  const p = known.reduce((s, h) => s + h.value - h.qty * h.avgPrice, 0);
                  return [
                    <tr key={a.id}>
                      <td><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c.s[a.slot], marginRight: 6 }} /><a href={`/accounts?id=${a.id}`}><b>{a.name}</b></a></td>
                      <td>{a.broker}</td><td>{a.plan ?? "–"}</td><td>{won(a.total)}</td><td>{won(a.cash)}</td>
                      <td style={{ color: p >= 0 ? "var(--bad)" : "var(--accent)" }}>{known.length ? signed(p) : "–"}</td>
                      {(() => { const r = rets[a.id] ?? []; const l = r.at(-1); return <td style={{ color: l && r.length > 1 ? retColor(l.ret) : undefined }}>{l && r.length > 1 ? <>{pct(l.ret)} <span className="help">{r[0].date.slice(2)}~</span></> : "–"}</td>; })()}
                      <td>{total > 0 ? `${((a.total / total) * 100).toFixed(1)}%` : "–"}</td>
                    </tr>,
                    ...(table ? a.holdings.map((h) => (
                      <tr key={a.id + h.ticker} style={{ fontSize: 12, color: "var(--text-2)" }}>
                        <td style={{ paddingLeft: 24 }}>{h.name} <span className="help">{h.ticker}</span></td><td>{h.qty.toLocaleString("ko-KR")}주</td><td>평균 {won(h.avgPrice)}</td>
                        <td>{won(h.value)}</td><td>{h.price != null ? `종가 ${won(h.price)}` : "시세 없음"}</td>
                        <td>{h.price != null ? `${signed(h.value - h.qty * h.avgPrice)} (${pct((h.price / h.avgPrice - 1) * 100)})` : "–"}</td>
                        <td></td>
                        <td>{total > 0 ? `${((h.value / total) * 100).toFixed(1)}%` : ""}</td>
                      </tr>
                    )) : []),
                  ];
                })}</tbody>
              </table></div>
            </div>
            <div className="card">
              <h2>체결 기록<Info>자동: 한국투자증권 아침 주문·장중 매도에서 체결된 것(미국 종목은 달러). 직접: 계좌 화면에 기록한 것.</Info></h2>
              {(() => {
                const list = (st.fills ?? []).filter((f) => accts.some((a) => a.id === f.accountId)).slice(0, 30);
                if (!list.length) return <p className="help">체결 기록이 없습니다.</p>;
                return (
                  <div className="tablewrap"><table>
                    <thead><tr><th>날짜</th><th>계좌</th><th>방식</th><th>구분</th><th>종목</th><th>수량</th><th>체결가</th></tr></thead>
                    <tbody>{list.map((f, i) => {
                      const a = accts.find((x) => x.id === f.accountId)!;
                      return (
                        <tr key={i}>
                          <td>{f.date}</td>
                          <td><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c.s[a.slot], marginRight: 6 }} />{a.name}</td>
                          <td>{f.source === "manual" ? "직접" : f.source === "morning" ? "자동 (아침)" : "자동 (장중)"}</td>
                          <td style={{ color: f.side === "buy" ? "var(--bad)" : "var(--accent)", fontWeight: 600 }}>{f.side === "buy" ? "매수" : "매도"}</td>
                          <td>{withCode(f.name, f.ticker)}</td>
                          <td>{f.qty.toLocaleString("ko-KR")}주</td>
                          <td>{f.market === "US" ? `$${f.price.toFixed(2)}` : won(f.price)}</td>
                        </tr>
                      );
                    })}</tbody>
                  </table></div>
                );
              })()}
            </div>

            <div className="card">
              <h2>입금·출금 기록<Info>누적 수익률에서 빼는 돈입니다. 수동 계좌에 넣으면 그 계좌 예수금도 함께 늘거나 줄고, 고치거나 지우면 예수금도 되돌립니다. 한국투자증권 계좌는 기록만 합니다(잔고는 증권사에서 읽음). 지난 날짜로 넣으면 그날 기록 전에 들어온 돈으로 봅니다. 수동 계좌 예수금·보유를 직접 고친 차이는 &quot;계좌 고침&quot;(자동)으로 들어갑니다.</Info></h2>
              <FlowEditor accounts={all.map((a) => ({ id: a.id, name: a.name, color: c.s[a.slot] }))} flows={Object.fromEntries(accts.map((a) => [a.id, st.flows?.[a.id] ?? []]))} today={st.today} onChanged={load} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
