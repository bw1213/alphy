"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Results from "@/components/Results";
import StrategyBuilder from "@/components/StrategyBuilder";
import { defaultSpec, generate, normalizeSpec, type BuilderSpec } from "@/lib/strategies/builder";
import { runBacktest } from "@/lib/engine/engine";
import { summarize, type Summary } from "@/lib/engine/metrics";
import type { BacktestResult, Rebalance } from "@/lib/engine/types";
import type { DataResponse, Source } from "@/lib/data/server";
import { paramVariants, summarizeSensitivity, type SensitivityResult, type SensitivityRow } from "@/lib/engine/validate";
import { compileStrategy, CUSTOM_PARAMS, CUSTOM_TEMPLATE, STRATEGIES, type Params } from "@/lib/strategies";

import type { SavedStrategy } from "@/lib/strategies/library";
const LS_KEY = "kbt.custom-strategies";

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
  /** 내 전략을 만드는 방법: 조건 고르기(코드 없이) 또는 코드 작성 */
  const [mode, setMode] = useState<"builder" | "code">("builder");
  const [spec, setSpec] = useState<BuilderSpec>(defaultSpec);
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
  const [commission, setCommission] = useState("0.015");
  const [slippage, setSlippage] = useState("0.1");
  const [sellTax, setSellTax] = useState("");

  // 결과
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [out, setOut] = useState<{ res: BacktestResult; s: Summary; names: Record<string, string>; label: string; title: string } | null>(null);
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
    } else if (id === "custom") {
      setMode("code");
    } else if (id.startsWith("saved:")) {
      const s = saved.find((x) => `saved:${x.name}` === id);
      if (s) {
        setMode(s.builder ? "builder" : "code");
        if (s.builder) setSpec(normalizeSpec(s.builder));
        setCode(s.code); setCustomParams(s.params); setCustomName(s.name); setRebalance(s.rebalance);
        setStopLoss(s.stopLoss); setTakeProfit(s.takeProfit); setCustomWarmup(s.warmup);
      }
    }
  };
  useEffect(() => selectStrategy(STRATEGIES[0].id), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 설정 화면(/settings)에서 정한 기본값 불러오기
  useEffect(() => {
    fetch("/api/settings/defaults", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      setSource(d.source); setCash(d.cash); setUniverseSize(d.universeSize);
      setCommission(String(d.commission)); setSlippage(String(d.slippage)); setSellTax(d.sellTax == null ? "" : String(d.sellTax));
      if (d.targetCagr > 0 && d.maxDrawdown > 0) setTarget({ cagr: d.targetCagr, mdd: d.maxDrawdown });
    }).catch(() => { /* 기본값 그대로 */ });
  }, []);

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
    const item: SavedStrategy = g
      ? { name: customName.trim() || "내 전략", code: g.code, params: JSON.stringify(g.params), rebalance, stopLoss, takeProfit, warmup: g.warmup, builder: normalizeSpec(spec) }
      : { name: customName.trim() || "내 전략", code, params: customParams, rebalance, stopLoss, takeProfit, warmup: customWarmup };
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
      setWarnings(data.warnings);
      // 3) 백테스트
      setBusy("백테스트 계산 중");
      await new Promise((r) => setTimeout(r, 30));
      let errInStrategy: Error | null = null;
      const exec = (pp: Params, w: number) => runBacktest({
        data: data!.data, benchmark: data!.benchmark, names: data!.names, universe: data!.universe, startDate: start, initialCash: cash,
        settings: { rebalance, stopLoss: toFrac(stopLoss), takeProfit: toFrac(takeProfit), rebalanceBand: 0.02, warmup: w },
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
      setOut({ res, s: summarize(res, target.cagr / 100, target.mdd / 100), names: data.names, label, title: builtin?.name ?? (customName.trim() || "내 전략") });
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
                  <option value="custom">+ 새 전략 만들기 (코드 작성)</option>
                  {saved.map((s) => <option key={s.name} value={`saved:${s.name}`}>{s.name}{isLocalOnly(s.name) ? " (이 브라우저만)" : ""}</option>)}
                </optgroup>
              </select>
            </label>
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
                  <button className={mode === "builder" ? "on" : ""} onClick={() => setMode("builder")}>조건 고르기</button>
                  <button className={mode === "code" ? "on" : ""} onClick={() => {
                    if (mode === "builder") { // 지금 조건을 코드로 옮겨서 이어서 고칠 수 있게
                      const g = generate(spec);
                      setCode(g.code); setCustomParams(JSON.stringify(g.params, null, 1).replace(/\n\s*/g, " ")); setCustomWarmup(g.warmup);
                    }
                    setMode("code");
                  }}>코드 작성</button>
                </div>
                {mode === "builder" ? (
                  <>
                    <StrategyBuilder spec={spec} onChange={setSpec} />
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
            <div className="row3">
              <label className="f">리밸런싱
                <select value={String(rebalance)} onChange={(e) => setRebalance(/^\d+$/.test(e.target.value) ? Number(e.target.value) : (e.target.value as Rebalance))}>
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
              <label className="f">수수료 % (매수·매도)<input value={commission} onChange={(e) => setCommission(e.target.value)} /></label>
              <label className="f">슬리피지 %<input value={slippage} onChange={(e) => setSlippage(e.target.value)} /></label>
              <label className="f">매도세 %<input placeholder="연도별 자동" value={sellTax} onChange={(e) => setSellTax(e.target.value)} /></label>
            </div>
            <p className="help">매도세 비우면 연도별 법정세율(2024 0.18%, 2025 0.15%, 2026 0.20%) 적용. 신호는 당일 종가, 체결은 다음 날 시가.</p>
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
