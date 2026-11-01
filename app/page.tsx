"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Results from "@/components/Results";
import { runBacktest } from "@/lib/engine/engine";
import { summarize, type Summary } from "@/lib/engine/metrics";
import type { BacktestResult, Rebalance } from "@/lib/engine/types";
import type { DataResponse, Source } from "@/lib/data/server";
import { compileStrategy, CUSTOM_PARAMS, CUSTOM_TEMPLATE, STRATEGIES, type Params } from "@/lib/strategies";

interface SavedStrategy { name: string; code: string; params: string; rebalance: Rebalance; stopLoss: string; takeProfit: string; warmup: number }
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
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  useEffect(() => setSaved(loadSaved()), []);

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
  const [out, setOut] = useState<{ res: BacktestResult; s: Summary; names: Record<string, string>; label: string } | null>(null);
  const dataCache = useRef<Map<string, DataResponse>>(new Map());

  const selectStrategy = (id: string) => {
    setSid(id);
    const b = STRATEGIES.find((s) => s.id === id);
    if (b) {
      setRebalance(b.rebalance);
      setStopLoss(b.stopLoss ? String(b.stopLoss * 100) : "");
      setTakeProfit(b.takeProfit ? String(b.takeProfit * 100) : "");
    } else if (id.startsWith("saved:")) {
      const s = saved.find((x) => `saved:${x.name}` === id);
      if (s) {
        setCode(s.code); setCustomParams(s.params); setCustomName(s.name); setRebalance(s.rebalance);
        setStopLoss(s.stopLoss); setTakeProfit(s.takeProfit); setCustomWarmup(s.warmup);
      }
    }
  };
  useEffect(() => selectStrategy(STRATEGIES[0].id), []); // eslint-disable-line react-hooks/exhaustive-deps

  const editAsCustom = () => {
    if (!builtin) return;
    setCode(builtin.code);
    setCustomParams(JSON.stringify(params[builtin.id], null, 1).replace(/\n\s*/g, " "));
    setCustomName(`${builtin.name} (수정)`);
    setCustomWarmup(builtin.warmup(params[builtin.id]));
    setSid("custom");
  };

  const saveCustom = () => {
    const item: SavedStrategy = { name: customName.trim() || "내 전략", code, params: customParams, rebalance, stopLoss, takeProfit, warmup: customWarmup };
    const list = [...saved.filter((s) => s.name !== item.name), item];
    setSaved(list); storeSaved(list); setSid(`saved:${item.name}`);
  };
  const deleteCustom = () => {
    const list = saved.filter((s) => `saved:${s.name}` !== sid);
    setSaved(list); storeSaved(list); setSid("custom");
  };

  const isCustom = !builtin;

  async function run() {
    setError(null); setWarnings([]);
    try {
      // 1) 전략 준비
      let fn: (ctx: any, p: Params) => any, p: Params, warmup: number, label: string;
      if (builtin) {
        p = params[builtin.id]; fn = builtin.targetWeights; warmup = builtin.warmup(p); label = builtin.id;
      } else {
        try { p = JSON.parse(customParams || "{}"); } catch { throw new Error("파라미터(JSON) 형식이 올바르지 않습니다."); }
        try { fn = compileStrategy(code); } catch (e) { throw new Error(`전략 코드 문법 오류: ${(e as Error).message}`); }
        warmup = customWarmup; label = customName.replace(/\s+/g, "_");
      }
      // 2) 데이터 (워밍업용으로 시작일보다 앞선 데이터까지)
      const loadStart = minusDays(start, Math.max(400, Math.ceil(warmup * 1.5) + 30));
      const list = universeMode === "list" ? tickers.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean) : undefined;
      const req = { source, start: loadStart, end, tickers: list, universeSize };
      const key = JSON.stringify(req);
      let data = dataCache.current.get(key);
      if (!data) {
        setBusy(source === "naver" ? "시세 데이터를 받는 중입니다 (처음 한 번은 1~2분 걸릴 수 있어요)" : "데이터 준비 중");
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
      const res = runBacktest({
        data: data.data, benchmark: data.benchmark, names: data.names, startDate: start, initialCash: cash,
        settings: { rebalance, stopLoss: toFrac(stopLoss), takeProfit: toFrac(takeProfit), rebalanceBand: 0.02, warmup },
        costs: { commission: Number(commission) / 100, slippage: Number(slippage) / 100, sellTax: sellTax.trim() === "" ? null : Number(sellTax) / 100 },
        strategy: (ctx) => {
          try { return fn(ctx, p); }
          catch (e) { errInStrategy = new Error(`${ctx.date} 전략 실행 오류: ${(e as Error).message}`); throw errInStrategy; }
        },
      });
      if (res.equity.length < 2) throw new Error("평가 구간 데이터가 부족합니다. 기간을 확인하세요.");
      setOut({ res, s: summarize(res), names: data.names, label });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const paramSpecs = builtin?.params ?? [];
  const sourceHelp = useMemo(() => ({
    naver: "네이버 증권 일봉(수정주가). 서버가 받아 .cache/ 에 하루 동안 저장합니다.",
    csv: "data/csv/{종목코드}.csv (Date,Open,High,Low,Close,Volume). 지수는 KOSPI.csv",
    synthetic: "랜덤 가짜 데이터. 전략 코드가 돌아가는지 확인할 때만 쓰세요.",
  }[source]), [source]);

  return (
    <>
      <header className="top">
        <h1>KOSPI 백테스트</h1>
        <p>전략을 고르거나 직접 작성해서 과거 성과를 확인하세요. 목표: 연 30%</p>
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
                  <option value="custom">+ 새 전략 직접 작성</option>
                  {saved.map((s) => <option key={s.name} value={`saved:${s.name}`}>{s.name}</option>)}
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
                <div className="btns" style={{ marginTop: 10 }}>
                  <button onClick={saveCustom}>이 브라우저에 저장</button>
                  {sid.startsWith("saved:") && <button onClick={deleteCustom}>삭제</button>}
                </div>
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
              <label className="f" style={{ marginTop: 8 }}>KOSPI 시가총액 상위 몇 종목
                <input type="number" min={5} max={300} value={universeSize} onChange={(e) => setUniverseSize(Number(e.target.value))} />
              </label>
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
          {out ? <Results {...out} /> : !busy && (
            <div className="card empty">
              <p><b>왼쪽에서 전략과 기간을 정하고 ‘백테스트 실행’을 누르세요.</b></p>
              <p>결과로 연평균 수익률, 최대 낙폭, KOSPI 대비 성과, 연도별 30% 달성 여부, 매매 내역을 보여드립니다.</p>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
