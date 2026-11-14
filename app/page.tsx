"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Results, { type HoldCompare } from "@/components/Results";
import StrategyBuilder from "@/components/StrategyBuilder";
import CycleBuilder from "@/components/CycleBuilder";
import { CYCLE_CODE, cycleParams, cycleWarmup, defaultCycleSpec, normalizeCycleSpec, type CycleSpec } from "@/lib/strategies/cycle";
import { defaultSpec, generate, normalizeSpec, type BuilderSpec } from "@/lib/strategies/builder";
import { runBacktest } from "@/lib/engine/engine";
import { holdTickers, runBuyAndHold } from "@/lib/engine/buyhold";
import { staleWarnings } from "@/lib/data/stale";
import { summarize, type Summary } from "@/lib/engine/metrics";
import type { BacktestResult, Rebalance } from "@/lib/engine/types";
import type { DataResponse, Source } from "@/lib/data/server";
import { paramVariants, summarizeSensitivity, type SensitivityResult, type SensitivityRow } from "@/lib/engine/validate";
import { compileStrategy, CUSTOM_PARAMS, CUSTOM_TEMPLATE, STRATEGIES, type Params } from "@/lib/strategies";

import type { SavedStrategy } from "@/lib/strategies/library";
import type { LastState } from "@/lib/strategies/lastState";
const LS_KEY = "kbt.custom-strategies";
const LAST_KEY = "alphy.last-state";

const today = () => new Date().toISOString().slice(0, 10);
const minusDays = (d: string, n: number) => new Date(Date.parse(d) - n * 864e5).toISOString().slice(0, 10);
const toFrac = (s: string) => (s.trim() === "" ? null : Number(s) / 100);

function loadSaved(): SavedStrategy[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}
function storeSaved(list: SavedStrategy[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* 저장 불가 환경 */ }
}

export default function Page() {
  // 전략
  const [sid, setSid] = useState<string>(STRATEGIES[0].id);
  const builtin = STRATEGIES.find((s) => s.id === sid);
  const [params, setParams] = useState<Record<string, Params>>(
    () => Object.fromEntries(STRATEGIES.map((s) => [s.id, Object.fromEntries(s.params.map((p) => [p.key, p.default]))])));
  const [code, setCode] = useState(CUSTOM_TEMPLATE);
  const [customParams, setCustomParams] = useState(CUSTOM_PARAMS);
  const [customName, setCustomName] = useState("내 전략");
  /** 내 전략을 만드는 방법: 조건 고르기(코드 없이), 적립·분할 매도(숫자만 입력), 코드 작성 */
  const [mode, setMode] = useState<"builder" | "cycle" | "code">("builder");
  const [spec, setSpec] = useState<BuilderSpec>(defaultSpec);
  const [cycleSpec, setCycleSpec] = useState<CycleSpec>(defaultCycleSpec);
  // 내 전략: NAS 에 저장된 것(어느 기기에서나 보임) + 이 브라우저에만 있는 것
  const [onNas, setOnNas] = useState<SavedStrategy[]>([]);
  const [local, setLocal] = useState<SavedStrategy[]>([]);
  const [stratMsg, setStratMsg] = useState("");
  const saved = useMemo(() => [...onNas, ...local.filter((l) => !onNas.some((s) => s.name === l.name))], [onNas, local]);
  const isLocalOnly = (name: string) => !onNas.some((s) => s.name === name);
  useEffect(() => {
    setLocal(loadSaved());
    fetch("/api/strategies", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).then((l) => Array.isArray(l) && setOnNas(l)).catch(() => { /* 서버 목록 없이 계속 */ });
  }, []);
  const [target, setTarget] = useState({ cagr: 15, mdd: 25 });

  // 운용 규칙
  const [rebalance, setRebalance] = useState<Rebalance>(STRATEGIES[0].rebalance);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [customWarmup, setCustomWarmup] = useState(250);

  // 데이터·기간
  const [source, setSource] = useState<Source>("naver");
  const [start, setStart] = useState("2018-01-01");
  const [end, setEnd] = useState(today());
  const [universeMode, setUniverseMode] = useState<"top" | "list">("top");
  const [universeSize, setUniverseSize] = useState(100);
  const [pit, setPit] = useState(false);
  const [tickers, setTickers] = useState("005930, 000660, 005380, 035420, 051910");

  // 비용
  const [cash, setCash] = useState(10_000_000);
  const [monthly, setMonthly] = useState(0);
  const [commission, setCommission] = useState("0.015");
  const [slippage, setSlippage] = useState("0.1");
  const [sellTax, setSellTax] = useState("");

  // 결과
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [out, setOut] = useState<{ res: BacktestResult; s: Summary; names: Record<string, string>; label: string; title: string; hold: HoldCompare | null } | null>(null);
  const dataCache = useRef<Map<string, DataResponse>>(new Map());
  /** 마지막 실행을 파라미터만 바꿔 다시 돌리는 함수 (민감도 검사용) */
  const rerun = useRef<{ p: Params; run: (p: Params) => SensitivityRow } | null>(null);

  const selectStrategy = (id: string) => {
    setSid(id);
    const b = STRATEGIES.find((s) => s.id === id);
    if (b) {
      setRebalance(b.rebalance);
      setStopLoss(b.stopLoss ? String(b.stopLoss * 100) : "");
      setTakeProfit(b.takeProfit ? String(b.takeProfit * 100) : "");
    } else if (id === "builder") {
      setMode("builder"); setSpec(defaultSpec()); setCustomName("내 조건 전략"); setRebalance("M"); setStopLoss(""); setTakeProfit("");
    } else if (id === "cycle") {
      setMode("cycle"); setCycleSpec(defaultCycleSpec()); setCustomName("적립·분할 매도"); setRebalance("D"); setStopLoss(""); setTakeProfit("");
      // 이 전략은 정한 종목에만 쓰므로 종목 직접 입력으로 (기본: KODEX 200)
      if (universeMode !== "list") { setUniverseMode("list"); setTickers("069500"); }
    } else if (id === "custom") {
      setMode("code");
    } else if (id.startsWith("saved:")) {
      const s = saved.find((x) => `saved:${x.name}` === id);
      if (s) {
        setMode(s.cycle ? "cycle" : s.builder ? "builder" : "code");
        if (s.builder) setSpec(normalizeSpec(s.builder));
        if (s.cycle) { setCycleSpec(normalizeCycleSpec(s.cycle)); setUniverseMode("list"); }
        setCode(s.code); setCustomParams(s.params); setCustomName(s.name); setRebalance(s.rebalance);
        setStopLoss(s.stopLoss); setTakeProfit(s.takeProfit); setCustomWarmup(s.warmup);
      }
    }
  };
  useEffect(() => selectStrategy(STRATEGIES[0].id), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 1) 설정 화면(/settings)에서 정한 기본값 → 2) 마지막으로 쓴 설정(NAS, 없으면 이 브라우저) 순서로 덮어씀
  /** 복원이 끝나기 전에는 저장하지 않음 (기본값으로 마지막 설정을 덮어쓰지 않게) */
  const [restored, setRestored] = useState(false);
  const [lastMsg, setLastMsg] = useState("");
  useEffect(() => {
    const getJson = (url: string) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    (async () => {
      const d = await getJson("/api/settings/defaults");
      if (d) {
        setSource(d.source); setCash(d.cash); setUniverseSize(d.universeSize);
        setCommission(String(d.commission)); setSlippage(String(d.slippage)); setSellTax(d.sellTax == null ? "" : String(d.sellTax));
        if (d.targetCagr > 0 && d.maxDrawdown > 0) setTarget({ cagr: d.targetCagr, mdd: d.maxDrawdown });
      }
      let s: LastState | null = await getJson("/api/last-state");
      if (!s) { try { s = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null"); } catch { s = null; } }
      if (s && typeof s === "object" && s.sid) applyLast(s);
      setRestored(true);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyLast = (s: LastState) => {
    setSid(s.sid);
    setMode(s.mode);
    setParams((cur) => {
      const next = { ...cur };
      for (const b of STRATEGIES) if (s.params?.[b.id]) next[b.id] = { ...cur[b.id], ...s.params[b.id] };
      return next;
    });
    setCode(s.code || CUSTOM_TEMPLATE); setCustomParams(s.customParams || CUSTOM_PARAMS);
    setCustomName(s.customName || "내 전략"); setCustomWarmup(s.customWarmup ?? 250);
    if (s.spec) setSpec(normalizeSpec(s.spec));
    if (s.cycleSpec) setCycleSpec(normalizeCycleSpec(s.cycleSpec));
    setRebalance(s.rebalance); setStopLoss(s.stopLoss ?? ""); setTakeProfit(s.takeProfit ?? "");
    setSource(s.source); setStart(s.start); setEnd(s.end || today());
    setUniverseMode(s.universeMode); setUniverseSize(s.universeSize); setPit(!!s.pit); setTickers(s.tickers ?? "");
    setCash(s.cash); setMonthly(s.monthly ?? 0);
    setCommission(s.commission); setSlippage(s.slippage); setSellTax(s.sellTax ?? "");
    setLastMsg(s.savedAt ? `마지막 설정을 불러왔습니다 (${s.savedAt.slice(0, 16).replace("T", " ")} 저장).` : "마지막 설정을 불러왔습니다.");
  };

  // 바뀔 때마다(1초 쉬었다가) NAS 와 이 브라우저에 저장
  const snapshot = useMemo<LastState>(() => ({
    version: 1, sid, mode, params, code, customParams, customName, customWarmup, spec, cycleSpec,
    rebalance, stopLoss, takeProfit, source, start, end: end === today() ? "" : end,
    universeMode, universeSize, pit, tickers, cash, monthly, commission, slippage, sellTax,
  }), [sid, mode, params, code, customParams, customName, customWarmup, spec, cycleSpec, rebalance, stopLoss, takeProfit,
    source, start, end, universeMode, universeSize, pit, tickers, cash, monthly, commission, slippage, sellTax]);
  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => {
      const body = JSON.stringify(snapshot);
      try { localStorage.setItem(LAST_KEY, body); } catch { /* 저장 불가 환경 */ }
      fetch("/api/last-state", { method: "PUT", headers: { "Content-Type": "application/json" }, body }).catch(() => { /* 다음 변경 때 다시 */ });
    }, 1000);
    return () => clearTimeout(t);
  }, [snapshot, restored]);

  const resetLast = async () => {
    try { localStorage.removeItem(LAST_KEY); } catch { /* 무시 */ }
    setRestored(false); // 지우는 동안 다시 저장되지 않게
    await fetch("/api/last-state", { method: "DELETE" }).catch(() => null);
    location.reload();
  };

  const editAsCustom = () => {
    if (!builtin) return;
    setCode(builtin.code);
    setCustomParams(JSON.stringify(params[builtin.id], null, 1).replace(/\n\s*/g, " "));
    setCustomName(`${builtin.name} (수정)`);
    setCustomWarmup(builtin.warmup(params[builtin.id]));
    setMode("code");
    setSid("custom");
  };

  const saveCustom = async () => {
    const g = mode === "builder" ? generate(spec) : null;
    const name = customName.trim() || "내 전략";
    const item: SavedStrategy = mode === "cycle"
      ? { name, code: CYCLE_CODE, params: JSON.stringify(cycleParams(cycleSpec)), rebalance: "D", stopLoss, takeProfit, warmup: cycleWarmup(cycleSpec), cycle: normalizeCycleSpec(cycleSpec) }
      : g
      ? { name, code: g.code, params: JSON.stringify(g.params), rebalance, stopLoss, takeProfit, warmup: g.warmup, builder: normalizeSpec(spec) }
      : { name, code, params: customParams, rebalance, stopLoss, takeProfit, warmup: customWarmup };
    setStratMsg("");
    const keepLocal = (why: string) => {
      const list = [...local.filter((s) => s.name !== item.name), item];
      setLocal(list); storeSaved(list); setStratMsg(why);
    };
    try {
      const r = await fetch("/api/strategies", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
      const j = await r.json();
      if (r.ok) {
        setOnNas(j);
        const list = local.filter((s) => s.name !== item.name);
        setLocal(list); storeSaved(list);
        setStratMsg("NAS에 저장했습니다. 다른 기기에서도 보입니다.");
      } else if (r.status === 401 || r.status === 403) keepLocal("로그인하지 않아 이 브라우저에만 저장했습니다. 설정 화면에서 로그인한 뒤 다시 저장하면 NAS에 저장됩니다.");
      else { setStratMsg(j.error ?? `저장 실패 (HTTP ${r.status})`); return; }
    } catch { keepLocal("서버에 연결하지 못해 이 브라우저에만 저장했습니다."); }
    setSid(`saved:${item.name}`);
  };
  const deleteCustom = async () => {
    const name = sid.replace(/^saved:/, "");
    setStratMsg("");
    if (!isLocalOnly(name)) {
      const r = await fetch(`/api/strategies?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
      if (!r || !r.ok) { setStratMsg(r && (r.status === 401 || r.status === 403) ? "NAS에 저장된 전략은 설정 화면에서 로그인해야 지울 수 있습니다." : "삭제하지 못했습니다."); return; }
      setOnNas(await r.json());
    }
    const list = local.filter((s) => s.name !== name);
    setLocal(list); storeSaved(list); setSid("custom");
  };
  /** 이 브라우저에만 있는 전략을 모두 NAS 로 */
  const moveLocalToNas = async () => {
    setStratMsg("");
    let last: SavedStrategy[] | null = null;
    const left: SavedStrategy[] = [];
    for (const s of local) {
      const r = await fetch("/api/strategies", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }).catch(() => null);
      if (r?.ok) last = await r.json();
      else { left.push(s); if (r && (r.status === 401 || r.status === 403)) { setStratMsg("설정 화면에서 로그인한 뒤 다시 하세요."); left.push(...local.slice(local.indexOf(s) + 1)); break; } }
    }
    if (last) setOnNas(last);
    setLocal(left); storeSaved(left);
    if (!left.length) setStratMsg("모두 NAS로 옮겼습니다.");
  };

  const isCustom = !builtin;

  async function run() {
    setError(null); setWarnings([]);
    try {
      // 1) 전략 준비
      let fn: (ctx: any, p: Params) => any, p: Params, warmup: number, label: string;
      if (builtin) {
        p = params[builtin.id]; fn = builtin.targetWeights; warmup = builtin.warmup(p); label = builtin.id;
      } else if (mode === "builder") {
        const g = generate(spec);
        p = g.params; fn = compileStrategy(g.code); warmup = g.warmup; label = customName.replace(/\s+/g, "_");
      } else if (mode === "cycle") {
        if (universeMode !== "list") throw new Error("적립·분할 매도 전략은 '기간 · 종목'에서 '종목 직접 입력'으로 종목을 정해 주세요 (예: 069500).");
        p = cycleParams(cycleSpec); fn = compileStrategy(CYCLE_CODE); warmup = cycleWarmup(cycleSpec); label = customName.replace(/\s+/g, "_");
      } else {
        try { p = JSON.parse(customParams || "{}"); } catch { throw new Error("파라미터(JSON) 형식이 올바르지 않습니다."); }
        try { fn = compileStrategy(code); } catch (e) { throw new Error(`전략 코드 문법 오류: ${(e as Error).message}`); }
        warmup = customWarmup; label = customName.replace(/\s+/g, "_");
      }
      // 2) 데이터 (워밍업용으로 시작일보다 앞선 데이터까지)
      const loadStart = minusDays(start, Math.max(400, Math.ceil(warmup * 1.5) + 30));
      const list = universeMode === "list" ? tickers.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean) : undefined;
      const usePit = pit && !list && (source === "naver" || source === "kis");
      const req = { source, start: loadStart, end, tickers: list, universeSize, pit: usePit };
      const key = JSON.stringify(req);
      let data = dataCache.current.get(key);
      if (!data) {
        setBusy(source === "naver" || source === "kis" ? "시세 데이터를 받는 중입니다 (처음 한 번은 몇 분 걸릴 수 있어요)" : "데이터 준비 중");
        const r = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        data = j as DataResponse;
        dataCache.current.set(key, data);
      }
      setWarnings([...data.warnings, ...staleWarnings(data, end)]);
      // 3) 백테스트
      setBusy("백테스트 계산 중");
      await new Promise((r) => setTimeout(r, 30));
      let errInStrategy: Error | null = null;
      const exec = (pp: Params, w: number) => runBacktest({
        data: data!.data, benchmark: data!.benchmark, names: data!.names, universe: data!.universe, startDate: start, initialCash: cash, monthlyDeposit: monthly,
        settings: { rebalance: !builtin && mode === "cycle" ? "D" : rebalance, stopLoss: toFrac(stopLoss), takeProfit: toFrac(takeProfit), rebalanceBand: 0.02, warmup: w },
        costs: { commission: Number(commission) / 100, slippage: Number(slippage) / 100, sellTax: sellTax.trim() === "" ? null : Number(sellTax) / 100 },
        strategy: (ctx) => {
          try { return fn(ctx, pp); }
          catch (e) { errInStrategy = new Error(`${ctx.date} 전략 실행 오류: ${(e as Error).message}`); throw errInStrategy; }
        },
      });
      const res = exec(p, warmup);
      const warmupOf = builtin ? builtin.warmup : () => warmup;
      rerun.current = { p, run: (pp) => {
        try { const x = summarize(exec(pp, warmupOf(pp)), target.cagr / 100, target.mdd / 100); return { label: "", cagr: x.cagr, mdd: x.mdd }; }
        catch { return { label: "", cagr: NaN, mdd: NaN }; }
      } };
      if (res.equity.length < 2) throw new Error("평가 구간 데이터가 부족합니다. 기간을 확인하세요.");
      // 비교용: 같은 자금·기간·비용으로 같은 종목을 똑같이 나눠 사기만 했다면
      let hold: HoldCompare | null = null;
      const pick = holdTickers(res, list);
      if (pick) {
        const h = runBuyAndHold({
          data: data.data, benchmark: data.benchmark, names: data.names, startDate: start, initialCash: cash, monthlyDeposit: monthly, tickers: pick.tickers,
          costs: { commission: Number(commission) / 100, slippage: Number(slippage) / 100, sellTax: sellTax.trim() === "" ? null : Number(sellTax) / 100 },
        });
        if (h && h.equity.length >= 2) hold = { res: h, s: summarize(h, target.cagr / 100, target.mdd / 100), basis: pick.basis, tickers: pick.tickers.filter((t) => t in data!.data) };
      }
      setOut({ res, s: summarize(res, target.cagr / 100, target.mdd / 100), names: data.names, label, title: builtin?.name ?? (customName.trim() || "내 전략"), hold });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 파라미터를 하나씩 ±20% 바꿔 다시 돌려 본다 (화면이 멈추지 않게 한 번씩 쉬어 감) */
  const sensitivity = async (onProgress: (done: number, total: number) => void): Promise<SensitivityResult> => {
    const r = rerun.current;
    if (!r || !out) throw new Error("먼저 백테스트를 실행하세요.");
    const variants = paramVariants(r.p);
    if (!variants.length) throw new Error("바꿔 볼 숫자 파라미터가 없습니다.");
    const rows: SensitivityRow[] = [];
    for (const [k, v] of variants.entries()) {
      onProgress(k, variants.length);
      await new Promise((res) => setTimeout(res, 10));
      rows.push({ ...r.run({ ...r.p, [v.key]: v.value }), label: v.label });
    }
    return summarizeSensitivity({ label: "지금 설정", cagr: out.s.cagr, mdd: out.s.mdd }, rows, out.s.target);
  };

  const paramSpecs = builtin?.params ?? [];
  const sourceHelp = useMemo(() => ({
    naver: "네이버 증권 일봉(수정주가). 서버가 받아 .cache/ 에 저장하고 새 날짜만 이어 받습니다.",
    kis: "한국투자증권 Open API 일봉(수정주가). 설정 화면에서 앱키를 넣어야 합니다. 모의투자 키만 있으면 초당 2건 제한 때문에 느리니 종목 수를 줄이세요.",
    csv: "data/csv/{종목코드}.csv (Date,Open,High,Low,Close,Volume). 지수는 KOSPI.csv",
    synthetic: "랜덤 가짜 데이터. 전략 코드가 돌아가는지 확인할 때만 쓰세요.",
  }[source]), [source]);

  return (
    <>
      <header className="top">
        <h1>KOSPI 백테스트</h1>
        <p>전략을 고르거나 직접 작성해서 과거 성과를 확인하세요. 목표: 연 {target.cagr}%, 최대 낙폭 -{target.mdd}% 이내 (<a href="/settings">설정</a>에서 변경)</p>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}><a href="/trade">한국투자증권 주문·잔고</a><a href="/settings">설정</a></span>
      </header>
      <main className="app">
        <section className="stack">
          <div className="card">
            <h2>전략</h2>
            <label className="f">전략 선택
              <select value={sid} onChange={(e) => selectStrategy(e.target.value)}>
                <optgroup label="기본 제공">
                  {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </optgroup>
                <optgroup label="내 전략">
                  <option value="builder">+ 새 전략 만들기 (조건 고르기)</option>
                  <option value="cycle">+ 새 전략 만들기 (적립 매수·하락 시 분할 매도)</option>
                  <option value="custom">+ 새 전략 만들기 (코드 작성)</option>
                  {saved.map((s) => <option key={s.name} value={`saved:${s.name}`}>{s.name}{isLocalOnly(s.name) ? " (이 브라우저만)" : ""}</option>)}
                  {sid.startsWith("saved:") && !saved.some((s) => `saved:${s.name}` === sid) && <option value={sid}>{sid.slice(6)} (지난번 설정)</option>}
                </optgroup>
              </select>
            </label>
            <p className="help">마지막으로 쓴 전략·종목·기간·자금 설정은 NAS에 자동 저장되어, 어느 기기에서 다시 열어도 그대로 이어집니다.{lastMsg && <> {lastMsg}</>} <button className="link" onClick={resetLast}>처음 설정으로 되돌리기</button></p>
            {builtin && (
              <>
                <p className="desc">{builtin.description}</p>
                <h3>파라미터</h3>
                <div className="row">
                  {paramSpecs.map((ps) => (
                    <label className="f" key={ps.key}>{ps.label}
                      <input type="number" value={params[builtin.id][ps.key]} min={ps.min} max={ps.max} step={ps.step ?? 1}
                        onChange={(e) => setParams({ ...params, [builtin.id]: { ...params[builtin.id], [ps.key]: Number(e.target.value) } })} />
                    </label>
                  ))}
                </div>
                <p className="help"><button className="link" onClick={editAsCustom}>이 전략의 코드를 열어 직접 수정하기 →</button></p>
              </>
            )}
            {isCustom && (
              <>
                <label className="f" style={{ marginTop: 10 }}>전략 이름
                  <input value={customName} onChange={(e) => setCustomName(e.target.value)} />
                </label>
                <div className="seg" style={{ marginTop: 10 }}>
                  <button className={mode === "builder" ? "on" : ""} onClick={() => { if (mode === "cycle") setRebalance("M"); setMode("builder"); }}>조건 고르기</button>
                  <button className={mode === "cycle" ? "on" : ""} onClick={() => {
                    setMode("cycle"); setRebalance("D");
                    if (universeMode !== "list") { setUniverseMode("list"); setTickers("069500"); }
                  }}>적립·분할 매도</button>
                  <button className={mode === "code" ? "on" : ""} onClick={() => {
                    if (mode === "builder") { // 지금 조건을 코드로 옮겨서 이어서 고칠 수 있게
                      const g = generate(spec);
                      setCode(g.code); setCustomParams(JSON.stringify(g.params, null, 1).replace(/\n\s*/g, " ")); setCustomWarmup(g.warmup);
                    } else if (mode === "cycle") {
                      setCode(CYCLE_CODE); setCustomParams(JSON.stringify(cycleParams(cycleSpec))); setCustomWarmup(cycleWarmup(cycleSpec)); setRebalance("D");
                    }
                    setMode("code");
                  }}>코드 작성</button>
                </div>
                {mode === "cycle" ? (
                  <CycleBuilder spec={cycleSpec} onChange={setCycleSpec} />
                ) : mode === "builder" ? (
                  <>
                    <StrategyBuilder spec={spec} onChange={setSpec} rebalance={rebalance} onRebalance={setRebalance} />
                    <p className="help">더 복잡한 규칙이 필요하면 위의 &quot;코드 작성&quot;을 누르세요. 지금 조건이 코드로 바뀌어 이어서 고칠 수 있습니다(코드에서 고친 내용은 조건 화면으로 돌아오지 않습니다).</p>
                  </>
                ) : (
                  <>
                    <label className="f" style={{ marginTop: 10 }}>전략 코드 (JavaScript, ctx·p 사용)
                      <textarea rows={18} wrap="off" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
                    </label>
                    <div className="row" style={{ marginTop: 10 }}>
                      <label className="f">파라미터 (JSON)
                        <input value={customParams} onChange={(e) => setCustomParams(e.target.value)} spellCheck={false} />
                      </label>
                      <label className="f">워밍업(영업일)
                        <input type="number" value={customWarmup} onChange={(e) => setCustomWarmup(Number(e.target.value))} />
                      </label>
                    </div>
                  </>
                )}
                <div className="btns" style={{ marginTop: 10 }}>
                  <button onClick={saveCustom}>저장</button>
                  {sid.startsWith("saved:") && <button onClick={deleteCustom}>삭제</button>}
                  {local.some((l) => isLocalOnly(l.name)) && <button onClick={moveLocalToNas}>이 브라우저의 전략을 NAS로 옮기기</button>}
                </div>
                {stratMsg && <p className="help">{stratMsg}</p>}
                <p className="help">저장한 전략은 NAS에 보관되어 어느 기기에서나 고를 수 있습니다(저장·삭제는 로그인 필요). 같은 이름으로 저장하면 덮어쓰고, 이름을 바꿔 저장하면 사본이 생깁니다.</p>
              </>
            )}
            <h3>운용 규칙</h3>
            {isCustom && mode === "cycle" && <p className="help">이 전략은 매일 확인하므로 리밸런싱은 &quot;매일&quot;로 고정됩니다. 매수 주기와 비중 맞추는 주기는 위에서 정하세요.</p>}
            {isCustom && mode === "builder" && <p className="help">리밸런싱 주기는 위 &quot;4. 투자 비율과 리밸런싱&quot;에서 정합니다.</p>}
            <div className="row3">
              <label className="f">리밸런싱
                <select value={String(isCustom && mode === "cycle" ? "D" : rebalance)} disabled={isCustom && mode !== "code"} onChange={(e) => setRebalance(/^\d+$/.test(e.target.value) ? Number(e.target.value) : (e.target.value as Rebalance))}>
                  <option value="D">매일</option><option value="W">매주</option><option value="M">매월</option><option value="Q">분기</option>
                </select>
              </label>
              <label className="f">손절 %<input type="number" placeholder="없음" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} /></label>
              <label className="f">익절 %<input type="number" placeholder="없음" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} /></label>
            </div>
          </div>

          <div className="card">
            <h2>기간 · 종목</h2>
            <div className="row">
              <label className="f">시작일<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
              <label className="f">종료일<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            </div>
            <label className="f" style={{ marginTop: 10 }}>데이터
              <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
                <option value="naver">네이버 증권 (실제 시세)</option>
                <option value="kis">한국투자증권 API (실제 시세)</option>
                <option value="csv">내 CSV 파일</option>
                <option value="synthetic">가짜 데이터 (테스트용)</option>
              </select>
            </label>
            <p className="help">{sourceHelp}</p>
            <div className="seg" style={{ marginTop: 10 }}>
              <button className={universeMode === "top" ? "on" : ""} onClick={() => setUniverseMode("top")}>시총 상위 N</button>
              <button className={universeMode === "list" ? "on" : ""} onClick={() => setUniverseMode("list")}>종목 직접 입력</button>
            </div>
            {universeMode === "top" ? (
              <>
                <label className="f" style={{ marginTop: 8 }}>KOSPI 시가총액 상위 몇 종목
                  <input type="number" min={5} max={pit ? 200 : 300} value={universeSize} onChange={(e) => setUniverseSize(Number(e.target.value))} />
                </label>
                {(source === "naver" || source === "kis") && (
                  <>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 8 }}>
                      <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={pit} onChange={(e) => setPit(e.target.checked)} />
                      과거 시점의 시총 상위 종목 사용 (생존편향 제거)
                    </label>
                    <p className="help">켜면 분기마다 &quot;그때&quot; 시총 상위였던 종목으로 목록을 바꾸고, 그 뒤 상장폐지된 종목도 포함합니다. 끄면 &quot;지금&quot; 시총 상위 종목만 써서 수익률이 실제보다 좋게 나옵니다. 과거 목록은 KRX 정보데이터시스템에서 받으며 처음 한 번은 몇 분 걸립니다.</p>
                  </>
                )}
              </>
            ) : (
              <label className="f" style={{ marginTop: 8 }}>종목코드 (쉼표 구분)
                <input value={tickers} onChange={(e) => setTickers(e.target.value)} />
              </label>
            )}
          </div>

          <div className="card">
            <h2>자금 · 비용</h2>
            <div className="row">
              <label className="f">초기 자금(원)<input type="number" step={1_000_000} value={cash} onChange={(e) => setCash(Number(e.target.value))} /></label>
              <label className="f">매달 추가 입금(원)<input type="number" min={0} step={100_000} placeholder="0 = 없음" value={monthly || ""} onChange={(e) => setMonthly(Math.max(0, Number(e.target.value) || 0))} /></label>
              <label className="f">수수료 % (매수·매도)<input value={commission} onChange={(e) => setCommission(e.target.value)} /></label>
              <label className="f">슬리피지 %<input value={slippage} onChange={(e) => setSlippage(e.target.value)} /></label>
              <label className="f">매도세 %<input placeholder="연도별 자동" value={sellTax} onChange={(e) => setSellTax(e.target.value)} /></label>
            </div>
            <p className="help">추가 입금은 시작 다음 달부터 매월 첫 거래일 장 시작 전에 현금으로 들어오고, 전략이 다음 매매 때 씁니다. 수익률은 입금 효과를 뺀 값으로 계산합니다. 매도세 비우면 연도별 법정세율(2024 0.18%, 2025 0.15%, 2026 0.20%) 적용. 신호는 당일 종가, 체결은 다음 날 시가.</p>
          </div>

          <button className="primary" onClick={run} disabled={!!busy}>
            {busy ? <><span className="spin" />실행 중</> : "백테스트 실행"}
          </button>
        </section>

        <section className="stack">
          {busy && <div className="card"><span className="spin" />{busy}</div>}
          {error && <div className="error">{error}</div>}
          {warnings.length > 0 && (
            <div className="notice"><b>참고</b><ul>{warnings.slice(0, 8).map((w, k) => <li key={k}>{w}</li>)}</ul>
              {warnings.length > 8 && <span>외 {warnings.length - 8}건</span>}</div>
          )}
          {out ? <Results {...out} onSensitivity={sensitivity} /> : !busy && (
            <div className="card empty">
              <p><b>왼쪽에서 전략과 기간을 정하고 ‘백테스트 실행’을 누르세요.</b></p>
              <p>결과로 연평균 수익률, 최대 낙폭, KOSPI 대비 성과, 연도별 목표 달성 여부, 매매 내역을 보여드립니다.</p>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
