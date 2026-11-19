"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Results, { type HoldCompare } from "@/components/Results";
import StrategyBuilder from "@/components/StrategyBuilder";
import CycleBuilder from "@/components/CycleBuilder";
import { CYCLE_CODE, cycleParams, cycleWarmup, defaultCycleSpec, normalizeCycleSpec, type CycleSpec } from "@/lib/strategies/cycle";
import { defaultSpec, generate, normalizeSpec, type BuilderSpec } from "@/lib/strategies/builder";
import { runBacktest } from "@/lib/engine/engine";
import { dividendTaxFn, KR_DIVIDEND_TAX } from "@/lib/engine/dividends";
import { holdTickers, runBuyAndHold } from "@/lib/engine/buyhold";
import { StockChips, StockSearch, appendCode, cachedStockName, splitCodes } from "@/components/StockSearch";
import { staleWarnings } from "@/lib/data/stale";
import { summarize, type IndexBars, type Summary } from "@/lib/engine/metrics";
import type { BacktestResult, CostSettings, Rebalance } from "@/lib/engine/types";
import { isUsTicker, parseTickers } from "@/lib/data/market";
import type { DataResponse, Source } from "@/lib/data/server";
import { paramVariants, summarizeSensitivity, type SensitivityResult, type SensitivityRow } from "@/lib/engine/validate";
import { compileStrategy, CUSTOM_PARAMS, CUSTOM_TEMPLATE, FIXED_MIX_CODE, STRATEGIES, type Params } from "@/lib/strategies";
import { WeightInputs } from "@/components/WeightInputs";

import type { SavedStrategy } from "@/lib/strategies/library";
import { cleanUniverse, universeLabel, withCode } from "@/lib/strategies/universe";
import type { LastState } from "@/lib/strategies/lastState";
import FinderResults from "@/components/FinderResults";
import { buildCandidates, maxWarmup, type Candidate } from "@/lib/finder/candidates";
import { evaluate, OBJECTIVES, type FinderReport, type Objective } from "@/lib/finder/search";
import { userKey } from "@/lib/client/userStorage";
import { fetchData } from "@/lib/client/fetchData";
import type { BackfillNote } from "@/lib/data/backfillApply";
import BackfillPicker from "@/components/BackfillPicker";
import { backfillRequest, cleanBackfillState, DEFAULT_BACKFILL, type BackfillState } from "@/lib/data/backfillPick";
import Info from "@/components/Info";
import CompareResults from "@/components/CompareResults";
import { buildCompare, MAX_COMPARE, mergeIndices, prepareCompare, savedId, type CompareReport, type CompareRun, type CompareStrategy } from "@/lib/compare/compare";
// 브라우저 저장 이름은 사람마다 다름 (같은 기기를 여럿이 써도 섞이지 않게)
const lsKey = () => userKey("kbt.custom-strategies");
const lastKey = () => userKey("alphy.last-state");

const today = () => new Date().toISOString().slice(0, 10);
const minusDays = (d: string, n: number) => new Date(Date.parse(d) - n * 864e5).toISOString().slice(0, 10);
const toFrac = (s: string) => (s.trim() === "" ? null : Number(s) / 100);

function loadSaved(): SavedStrategy[] {
  try { return JSON.parse(localStorage.getItem(lsKey()) ?? "[]"); } catch { return []; }
}
function storeSaved(list: SavedStrategy[]) {
  try { localStorage.setItem(lsKey(), JSON.stringify(list)); } catch { /* 저장 불가 환경 */ }
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
  const [saveName, setSaveName] = useState("");
  const saved = useMemo(() => [...onNas, ...local.filter((l) => !onNas.some((s) => s.name === l.name))], [onNas, local]);
  const isLocalOnly = (name: string) => !onNas.some((s) => s.name === name);
  useEffect(() => {
    setLocal(loadSaved());
    fetch("/api/strategies", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).then((l) => Array.isArray(l) && setOnNas(l)).catch(() => { /* 서버 목록 없이 계속 */ });
  }, []);
  const [target, setTarget] = useState({ cagr: 15, mdd: 25 });
  // 전략 비교: 고른 전략 (기본 전략 id, "saved:이름")
  const [compareIds, setCompareIds] = useState<string[]>([]);

  // 운용 규칙
  const [rebalance, setRebalance] = useState<Rebalance>(STRATEGIES[0].rebalance);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [intraday, setIntraday] = useState(false);
  const [customWarmup, setCustomWarmup] = useState(250);

  // 데이터·기간
  const [source, setSource] = useState<Source>("naver");
  const [start, setStart] = useState("2018-01-01");
  const [end, setEnd] = useState(today());
  const [universeMode, setUniverseMode] = useState<"top" | "list">("top");
  const [universeSize, setUniverseSize] = useState(100);
  const [pit, setPit] = useState(false);
  const [tickers, setTickers] = useState("005930, 000660, 005380, 035420, 051910");
  const [backfill, setBackfill] = useState<BackfillState>(DEFAULT_BACKFILL);

  // 비용
  const [cash, setCash] = useState(10_000_000);
  const [monthly, setMonthly] = useState(0);
  const [commission, setCommission] = useState("0.015");
  const [slippage, setSlippage] = useState("0.1");
  const [sellTax, setSellTax] = useState("");
  const [usCommission, setUsCommission] = useState("0.25");
  const [usFx, setUsFx] = useState("0.1");
  const [useDiv, setUseDiv] = useState(true);
  const [divTax, setDivTax] = useState("15.4");

  // 결과
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [out, setOut] = useState<{ res: BacktestResult; s: Summary; names: Record<string, string>; label: string; title: string; hold: HoldCompare | null; benchName: string; backfilled?: BackfillNote[]; indices?: IndexBars[] } | null>(null);
  const dataCache = useRef<Map<string, DataResponse>>(new Map());
  /** 마지막 실행을 파라미터만 바꿔 다시 돌리는 함수 (민감도 검사용) */
  const rerun = useRef<{ p: Params; run: (p: Params) => SensitivityRow } | null>(null);

  const selectStrategy = (id: string) => {
    setSid(id);
    const b = STRATEGIES.find((s) => s.id === id);
    if (b) {
      setSaveName("");
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
        const u = s.universe;
        if (u) {
          setUniverseMode(u.mode); setUniverseSize(u.size); setPit(u.pit);
          if (u.mode === "list") setTickers(u.tickers);
          setBackfill(cleanBackfillState(u.backfill));
        }
        setStratMsg(u ? `저장된 종목도 불러왔습니다: ${universeLabel(u, cachedStockName)}` : "");
      }
    }
  };
  useEffect(() => selectStrategy(STRATEGIES[0].id), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 1) 설정 화면(/settings)에서 정한 기본값 → 2) 마지막으로 쓴 설정(NAS 와 이 브라우저 중 더 최근 것) 순서로 덮어씀
  /** 복원이 끝나기 전에는 저장하지 않음 (기본값으로 마지막 설정을 덮어쓰지 않게) */
  const [restored, setRestored] = useState(false);
  const [lastMsg, setLastMsg] = useState("");
  /** 이 화면이 마지막으로 불러오거나 저장한 시각 (다른 기기에서 더 최근에 저장했는지 비교) */
  const lastSavedAt = useRef("");
  /** 마지막으로 저장(또는 불러온) 내용. 같으면 다시 저장하지 않음 */
  const lastBody = useRef("");
  /** 불러온 직후 한 번은 저장하지 않음 (불러온 값을 그대로 다시 쓰지 않게) */
  const skipSave = useRef(false);
  const getJson = (url: string) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const readLocal = (): LastState | null => { try { return JSON.parse(localStorage.getItem(lastKey()) ?? "null"); } catch { return null; } };
  const newer = (a: LastState | null, b: LastState | null) => {
    const ok = (x: LastState | null) => (x && typeof x === "object" && x.sid ? x : null);
    const x = ok(a), y = ok(b);
    if (!x || !y) return x ?? y;
    return (y.savedAt ?? "") > (x.savedAt ?? "") ? y : x;
  };
  useEffect(() => {
    (async () => {
      const d = await getJson("/api/settings/defaults");
      if (d) {
        setSource(d.source); setCash(d.cash); setUniverseSize(d.universeSize);
        setCommission(String(d.commission)); setSlippage(String(d.slippage)); setSellTax(d.sellTax == null ? "" : String(d.sellTax));
        if (d.usCommission != null) setUsCommission(String(d.usCommission));
        if (d.usFx != null) setUsFx(String(d.usFx));
        if (d.targetCagr > 0 && d.maxDrawdown > 0) setTarget({ cagr: d.targetCagr, mdd: d.maxDrawdown });
      }
      // 서버 저장이 실패했던 경우를 위해 이 브라우저에 남은 것과 비교해 더 최근 것을 씀
      const s = newer(await getJson("/api/last-state"), readLocal());
      if (s) applyLast(s);
      setRestored(true);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyLast = (s: LastState) => {
    skipSave.current = true;
    lastSavedAt.current = s.savedAt ?? "";
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
    setRebalance(s.rebalance); setStopLoss(s.stopLoss ?? ""); setTakeProfit(s.takeProfit ?? ""); setIntraday(!!s.intraday);
    setSource(s.source); setStart(s.start); setEnd(s.end || today());
    setUniverseMode(s.universeMode); setUniverseSize(s.universeSize); setPit(!!s.pit); setTickers(s.tickers ?? ""); setBackfill(cleanBackfillState(s.backfill));
    setCash(s.cash); setMonthly(s.monthly ?? 0);
    setCommission(s.commission); setSlippage(s.slippage); setSellTax(s.sellTax ?? "");
    if (s.usCommission) setUsCommission(s.usCommission);
    if (s.usFx) setUsFx(s.usFx);
    setUseDiv(s.dividends !== false); setDivTax(s.divTax ?? "15.4");
    setCompareIds(Array.isArray(s.compare) ? s.compare.slice(0, MAX_COMPARE) : []);
    setLastMsg(s.savedAt ? `마지막 설정을 불러왔습니다 (${new Date(s.savedAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })} 저장).` : "마지막 설정을 불러왔습니다.");
  };

  // 바뀔 때마다(1초 쉬었다가) NAS 와 이 브라우저에 저장. 실행·화면 전환 때는 바로 저장
  const snapshot = useMemo<LastState>(() => ({
    version: 1, sid, mode, params, code, customParams, customName, customWarmup, spec, cycleSpec,
    rebalance, stopLoss, takeProfit, intraday, source, start, end: end === today() ? "" : end,
    universeMode, universeSize, pit, tickers, cash, monthly, commission, slippage, sellTax, dividends: useDiv, divTax, usCommission, usFx, backfill, compare: compareIds,
  }), [sid, mode, params, code, customParams, customName, customWarmup, spec, cycleSpec, rebalance, stopLoss, takeProfit, intraday,
    source, start, end, universeMode, universeSize, pit, tickers, cash, monthly, commission, slippage, sellTax, useDiv, divTax, usCommission, usFx, backfill, compareIds]);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const saveNow = (keepalive = false) => {
    const plain = JSON.stringify(snapRef.current);
    if (plain === lastBody.current) return;
    lastBody.current = plain;
    const savedAt = new Date().toISOString();
    lastSavedAt.current = savedAt;
    const body = JSON.stringify({ ...snapRef.current, savedAt });
    try { localStorage.setItem(lastKey(), body); } catch { /* 저장 불가 환경 */ }
    fetch("/api/last-state", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: keepalive && body.length < 60_000 })
      .then((r) => (r.ok ? r.json() : null)).then((j) => {
        // 서버 시각으로 맞춰 둠 (기기마다 시계가 조금씩 달라도 비교가 맞게)
        if (!j?.savedAt || lastSavedAt.current !== savedAt) return;
        lastSavedAt.current = j.savedAt;
        try { localStorage.setItem(lastKey(), JSON.stringify({ ...JSON.parse(body), savedAt: j.savedAt })); } catch { /* 무시 */ }
      })
      .catch(() => { lastBody.current = ""; /* 다음 변경 때 다시 */ });
  };
  useEffect(() => {
    if (!restored) return;
    if (skipSave.current) { skipSave.current = false; lastBody.current = JSON.stringify(snapshot); return; }
    const t = setTimeout(() => saveNow(), 1000);
    return () => clearTimeout(t);
  }, [snapshot, restored]); // eslint-disable-line react-hooks/exhaustive-deps

  // 휴대폰에서 앱을 바꾸거나 탭을 오래 열어 둔 경우:
  // 화면을 떠날 때 바로 저장하고, 돌아오면 다른 기기에서 더 최근에 저장한 설정이 있는지 확인해 불러옴
  useEffect(() => {
    if (!restored) return;
    const onVis = async () => {
      if (document.visibilityState === "hidden") { saveNow(true); return; }
      const s: LastState | null = await getJson("/api/last-state");
      if (s?.sid && s.savedAt && s.savedAt > lastSavedAt.current && JSON.stringify(snapRef.current) === lastBody.current) applyLast(s);
    };
    const onHide = () => saveNow(true);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pagehide", onHide); };
  }, [restored]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetLast = async () => {
    try { localStorage.removeItem(lastKey()); } catch { /* 무시 */ }
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

  /** 기본 전략을 지금 파라미터·종목 그대로 내 전략으로 저장 (이후엔 코드 전략으로 열림) */
  const saveBuiltin = () => {
    if (!builtin) return;
    const p = params[builtin.id];
    const name = saveName.trim() || builtin.name;
    const pj = JSON.stringify(p);
    setCode(builtin.code); setCustomParams(pj); setCustomName(name); setCustomWarmup(builtin.warmup(p)); setMode("code");
    return saveCustom({ name, code: builtin.code, params: pj, rebalance, stopLoss, takeProfit, warmup: builtin.warmup(p) });
  };

  const saveCustom = async (given?: SavedStrategy) => {
    const g = !given && mode === "builder" ? generate(spec) : null;
    const name = customName.trim() || "내 전략";
    const item: SavedStrategy = given ?? (mode === "cycle"
      ? { name, code: CYCLE_CODE, params: JSON.stringify(cycleParams(cycleSpec)), rebalance: "D", stopLoss, takeProfit, warmup: cycleWarmup(cycleSpec), cycle: normalizeCycleSpec(cycleSpec) }
      : g
      ? { name, code: g.code, params: JSON.stringify(g.params), rebalance, stopLoss, takeProfit, warmup: g.warmup, builder: normalizeSpec(spec) }
      : { name, code, params: customParams, rebalance, stopLoss, takeProfit, warmup: customWarmup });
    // 이 백테스트에 쓴 종목도 함께 저장
    const universe = cleanUniverse({ mode: universeMode, size: universeSize, pit, tickers, backfill });
    if (universe) item.universe = universe;
    item.intraday = intraday; // 장중 실시간 매도도 매매에 그대로
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
        setStratMsg(`NAS에 저장했습니다 (종목: ${universe ? universeLabel(universe, cachedStockName) : "없음"}).`);
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

  /** 시세 받기 (같은 조건이면 이 화면에서 받아 둔 것을 다시 씀) */
  async function loadData(warmup: number, list: string[] | undefined, u?: { size: number; pit: boolean; backfill?: BackfillState }): Promise<DataResponse> {
    const loadStart = minusDays(start, Math.max(400, Math.ceil(warmup * 1.5) + 30));
    const usePit = (u ? u.pit : pit) && !list && (source === "naver" || source === "kis");
    const bf = list && (source === "naver" || source === "kis") ? backfillRequest(u ? u.backfill ?? DEFAULT_BACKFILL : backfill, list) : undefined;
    const req = { source, start: loadStart, end, tickers: list, universeSize: u ? u.size : universeSize, pit: usePit, dividends: useDiv, ...(bf ? { backfill: bf } : {}) };
    const key = JSON.stringify(req);
    let data = dataCache.current.get(key);
    if (!data) {
      setBusy(source === "naver" || source === "kis" ? "시세 데이터를 받는 중입니다 (처음 한 번은 몇 분 걸릴 수 있어요)" : "데이터 준비 중");
      const label = source === "naver" || source === "kis" ? "시세 데이터를 받는 중입니다" : "데이터 준비 중";
      data = await fetchData(req, (p) => setBusy(`${label} (${p.done}/${p.total}종목, 처음 한 번은 몇 분 걸릴 수 있어요)`));
      dataCache.current.set(key, data);
    }
    return data;
  }

  /** 화면의 비용·배당 설정 → 엔진 옵션 */
  function runCosts(data: DataResponse) {
    // 미국 종목 비용은 서버가 미국 시세를 원화로 바꿔 준 경우(fx 있음)에만
    const costs: CostSettings = {
      commission: Number(commission) / 100, slippage: Number(slippage) / 100, sellTax: sellTax.trim() === "" ? null : Number(sellTax) / 100,
      ...(data.fx ? { us: { commission: (Number(usCommission) || 0) / 100, fx: (Number(usFx) || 0) / 100 } } : {}),
    };
    const krTax = divTax.trim() === "" ? KR_DIVIDEND_TAX : Number(divTax) / 100;
    if (useDiv && !(krTax >= 0 && krTax <= 1)) throw new Error("배당소득세는 0~100 사이 숫자(%)로 넣어 주세요. 비우면 15.4%.");
    const div = useDiv ? { dividends: data.dividends, dividendTax: dividendTaxFn(krTax) } : {};
    return { costs, div };
  }

  async function run() {
    setError(null); setWarnings([]);
    setCmpFirst(false);
    if (restored) saveNow();
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
      const list = universeMode === "list" ? parseTickers(tickers) : undefined;
      if (list && !list.length) throw new Error("종목코드를 넣어 주세요. 한국은 6자리(005930), 미국은 티커(AAPL, SPY)입니다.");
      const data = await loadData(warmup, list);
      setWarnings([...data.warnings, ...staleWarnings(data, end)]);
      const { costs, div } = runCosts(data);
      // 3) 백테스트
      setBusy("백테스트 계산 중");
      await new Promise((r) => setTimeout(r, 30));
      let errInStrategy: Error | null = null;
      const exec = (pp: Params, w: number) => runBacktest({
        data: data!.data, benchmark: data!.benchmark, names: data!.names, universe: data!.universe, startDate: start, initialCash: cash, monthlyDeposit: monthly, ...div,
        settings: { rebalance: !builtin && mode === "cycle" ? "D" : rebalance, stopLoss: toFrac(stopLoss), takeProfit: toFrac(takeProfit), rebalanceBand: 0.02, warmup: w, intraday },
        costs,
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
          data: data.data, benchmark: data.benchmark, names: data.names, startDate: start, initialCash: cash, monthlyDeposit: monthly, tickers: pick.tickers, ...div,
          costs,
        });
        if (h && h.equity.length >= 2) hold = { res: h, s: summarize(h, target.cagr / 100, target.mdd / 100), basis: pick.basis, tickers: pick.tickers.filter((t) => t in data!.data) };
      }
      setOut({ res, s: summarize(res, target.cagr / 100, target.mdd / 100), names: data.names, label, title: builtin?.name ?? (customName.trim() || "내 전략"), hold, benchName: data.benchmarkName ?? "KOSPI", backfilled: data.backfilled, indices: data.indices });
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

  // ---------- 전략 비교 ----------
  const [cmp, setCmp] = useState<CompareReport | null>(null);
  /** 비교한 직후엔 비교 결과를 위에, 전략을 열어 백테스트를 돌린 뒤엔 아래에 */
  const [cmpFirst, setCmpFirst] = useState(true);
  const compareOptions = useMemo(() => [
    ...saved.map((x) => ({ id: savedId(x.name), name: x.name, mine: true })),
    ...STRATEGIES.map((b) => ({ id: b.id, name: b.name, mine: false })),
  ], [saved]);
  /** 지워진 전략은 빼고 */
  const picked = compareIds.filter((id) => compareOptions.some((o) => o.id === id));
  const togglePick = (id: string) => setCompareIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_COMPARE ? cur : [...cur, id]));

  async function runCompare() {
    setError(null); setWarnings([]);
    if (restored) saveNow();
    try {
      if (picked.length < 2) throw new Error("비교할 전략을 2개 이상 고르세요.");
      const runs: CompareRun[] = [];
      const ixs: DataResponse["indices"][] = [];
      const warns = new Set<string>();
      for (const [k, id] of picked.entries()) {
        let st: CompareStrategy | null = null;
        let uLabel = "";
        try {
          st = prepareCompare(id, saved, params);
          // 내 전략은 저장된 종목, 기본 전략(또는 종목 없이 저장된 전략)은 지금 화면의 종목
          const u = st.universe ?? cleanUniverse({ mode: universeMode, size: universeSize, pit, tickers, backfill });
          if (!u) throw new Error("종목코드를 넣어 주세요 ('기간 · 종목'의 종목 직접 입력이 비어 있음).");
          const list = u.mode === "list" ? parseTickers(u.tickers) : undefined;
          if (st.needsList && !list) throw new Error("적립·분할 매도 전략은 종목을 직접 입력해야 합니다.");
          uLabel = universeLabel(u, cachedStockName);
          const tag = `전략 비교 ${k + 1}/${picked.length} · ${st.name}`;
          setBusy(`${tag}: 시세 준비 중`);
          const data = await loadData(st.warmup, list, { size: u.size, pit: u.pit, backfill: u.backfill });
          for (const w of [...data.warnings, ...staleWarnings(data, end)]) warns.add(w);
          ixs.push(data.indices);
          const { costs, div } = runCosts(data);
          setBusy(`${tag}: 계산 중`);
          await new Promise((r) => setTimeout(r, 30));
          const s0 = st;
          const res = runBacktest({
            data: data.data, benchmark: data.benchmark, names: data.names, universe: data.universe, startDate: start, initialCash: cash, monthlyDeposit: monthly, ...div,
            settings: { rebalance: s0.rebalance, stopLoss: s0.stopLoss, takeProfit: s0.takeProfit, rebalanceBand: 0.02, warmup: s0.warmup, intraday: id.startsWith("saved:") ? s0.intraday : intraday },
            costs,
            strategy: (ctx) => {
              try { return s0.fn(ctx, s0.p); }
              catch (e) { throw new Error(`${ctx.date} 전략 실행 오류: ${(e as Error).message}`); }
            },
          });
          runs.push({ id, name: st.name, universe: uLabel, res });
        } catch (e) {
          runs.push({ id, name: st?.name ?? id.replace(/^saved:/, ""), universe: uLabel, error: (e as Error).message });
        }
      }
      const report = buildCompare(runs, mergeIndices(ixs));
      if (!report || !report.rows.length) throw new Error(`비교하지 못했습니다. ${runs.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`).join(" / ")}`);
      setWarnings([...warns]);
      setCmp(report);
      setCmpFirst(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const openFromCompare = (id: string) => {
    selectStrategy(id);
    setCmpFirst(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ---------- 전략 찾기 (종목 1~3개) ----------
  const [objective, setObjective] = useState<Objective>("cagr");
  const [testRatio, setTestRatio] = useState(0.3);
  const [finder, setFinder] = useState<{ report: FinderReport; holdName: string } | null>(null);
  /** 찾은 직후엔 찾기 결과를 위에, 전략을 열어 백테스트를 돌린 뒤엔 백테스트 결과를 위에 */
  const [finderFirst, setFinderFirst] = useState(true);
  /** 찾은 전략을 화면에 넣은 뒤 상태가 반영되면 바로 실행 */
  const [runAfterApply, setRunAfterApply] = useState(false);
  const finderList = universeMode === "list" ? parseTickers(tickers) : [];
  const finderReady = finderList.length >= 1 && finderList.length <= 3;

  async function findStrategy() {
    setError(null); setWarnings([]);
    if (restored) saveNow();
    try {
      if (!finderReady) throw new Error("전략 찾기는 '기간 · 종목'에서 '종목 직접 입력'으로 종목을 1~3개 넣어야 합니다.");
      const list = finderList;
      const data = await loadData(maxWarmup(buildCandidates(list)), list);
      setWarnings([...data.warnings, ...staleWarnings(data, end)]);
      const all = buildCandidates(list, data.names);
      const missing = list.filter((t) => !data.data[t]?.length);
      if (missing.length) throw new Error(`시세를 받지 못한 종목이 있습니다: ${missing.map((t) => withCode(cachedStockName(t), t)).join(", ")}`);
      const { costs, div } = runCosts(data);
      const runs: { c: Candidate; res: BacktestResult }[] = [];
      for (const [k, c] of all.entries()) {
        if (k % 4 === 0) { setBusy(`전략 찾는 중… ${k + 1}/${all.length}`); await new Promise((r) => setTimeout(r, 0)); }
        const fn = compileStrategy(c.code);
        try {
          runs.push({ c, res: runBacktest({
            data: data.data, benchmark: data.benchmark, names: data.names, startDate: start, initialCash: cash, monthlyDeposit: monthly, ...div,
            settings: { rebalance: c.rebalance, stopLoss: null, takeProfit: null, rebalanceBand: 0.02, warmup: c.warmup },
            costs, strategy: (ctx) => fn(ctx, c.params),
          }) });
        } catch { /* 이 후보는 건너뜀 */ }
      }
      const hold = runBuyAndHold({ data: data.data, benchmark: data.benchmark, names: data.names, startDate: start, initialCash: cash, monthlyDeposit: monthly, tickers: list, ...div, costs });
      const report = evaluate(runs, hold, { objective, testRatio, maxDrawdown: target.mdd / 100 });
      setFinderFirst(true);
      setFinder({ report, holdName: list.length === 1 ? (data.names[list[0]] ?? list[0]) : `${list.length}종목` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const applyCandidate = (c: Candidate) => {
    const name = `찾은 전략 · ${c.name.split(" · ")[0]}`;
    setStopLoss(""); setTakeProfit("");
    if (c.cycle) {
      setSid("cycle"); setMode("cycle"); setCycleSpec(normalizeCycleSpec(c.cycle)); setRebalance("D");
    } else {
      setSid("custom"); setMode("code"); setCode(c.code); setCustomParams(JSON.stringify(c.params)); setCustomWarmup(c.warmup); setRebalance(c.rebalance);
    }
    setCustomName(name);
    setFinderFirst(false);
    setRunAfterApply(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  useEffect(() => {
    if (!runAfterApply) return;
    setRunAfterApply(false);
    run();
  }, [runAfterApply]); // eslint-disable-line react-hooks/exhaustive-deps

  const paramSpecs = builtin?.params ?? [];
  const hasUs = universeMode === "list" && parseTickers(tickers).some(isUsTicker);
  const sourceHelp = useMemo(() => ({
    naver: "",
    kis: "설정에서 앱키가 필요합니다. 모의 키는 느리니 종목 수를 줄이세요.",
    csv: "data/csv/{종목코드}.csv (Date,Open,High,Low,Close,Volume). 지수는 KOSPI.csv",
    synthetic: "코드 동작 확인용 가짜 데이터입니다.",
  }[source]), [source]);

  return (
    <>
      <header className="top">
        <h1>백테스트 (한국·미국)</h1>
        <p>목표 연 {target.cagr}% · 최대 낙폭 -{target.mdd}%</p>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}><a href="/trade">한국투자증권 주문·잔고</a><a href="/dashboard">전체 계좌</a><a href="/auto">자동 매매</a><a href="/manual">수동 매매</a><a href="/settings">설정</a></span>
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
            <p className="help">{lastMsg && <>{lastMsg} </>}<button className="link" onClick={resetLast}>처음 설정으로 되돌리기</button><Info>마지막 설정은 NAS에 자동 저장되어 어느 기기에서나 이어집니다.</Info></p>
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
                {builtin.code === FIXED_MIX_CODE && (
                  <WeightInputs tickers={universeMode === "list" ? parseTickers(tickers) : []} value={params[builtin.id]}
                    onChange={(v) => setParams({ ...params, [builtin.id]: v as Params })} />
                )}
                <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
                  <label className="f">내 전략 이름<input value={saveName} placeholder={builtin.name} onChange={(e) => setSaveName(e.target.value)} /></label>
                  <div className="btns"><button onClick={saveBuiltin}>내 전략으로 저장</button></div>
                </div>
                {stratMsg && <p className="help">{stratMsg}</p>}
                <p className="help">파라미터·종목도 함께 저장됩니다. <button className="link" onClick={editAsCustom}>코드 직접 수정하기 →</button></p>
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
                    <p className="help">더 복잡한 규칙은 위 &quot;코드 작성&quot;으로 이어서 고칠 수 있습니다.</p>
                  </>
                ) : (
                  <>
                    <label className="f" style={{ marginTop: 10 }}>전략 코드 (JavaScript, ctx·p 사용)
                      <textarea rows={18} wrap="off" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
                    </label>
                    {code === FIXED_MIX_CODE && (() => {
                      let cur: Record<string, number> = {};
                      try { cur = JSON.parse(customParams) ?? {}; } catch { /* 고치는 중 */ }
                      return <WeightInputs tickers={universeMode === "list" ? parseTickers(tickers) : []} value={cur}
                        onChange={(v) => setCustomParams(JSON.stringify(v))} />;
                    })()}
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
                  <button onClick={() => saveCustom()}>저장</button>
                  {sid.startsWith("saved:") && <button onClick={deleteCustom}>삭제</button>}
                  {local.some((l) => isLocalOnly(l.name)) && <button onClick={moveLocalToNas}>이 브라우저의 전략을 NAS로 옮기기</button>}
                </div>
                {stratMsg && <p className="help">{stratMsg}</p>}
                <p className="help">지금 종목도 함께 저장됩니다. 같은 이름이면 덮어씁니다.</p>
              </>
            )}
            <h3>운용 규칙</h3>
            {isCustom && mode === "cycle" && <p className="help">리밸런싱은 &quot;매일&quot; 고정입니다.</p>}
            {isCustom && mode === "builder" && <p className="help">리밸런싱 주기는 위 4번에서 정합니다.</p>}
            <div className="row3">
              <label className="f">리밸런싱
                <select value={String(isCustom && mode === "cycle" ? "D" : rebalance)} disabled={isCustom && mode !== "code"} onChange={(e) => setRebalance(/^\d+$/.test(e.target.value) ? Number(e.target.value) : (e.target.value as Rebalance))}>
                  <option value="D">매일</option><option value="W">매주</option><option value="M">매월</option><option value="Q">분기</option>
                </select>
              </label>
              <label className="f">손절 %<input type="number" placeholder="없음" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} /></label>
              <label className="f">익절 %<input type="number" placeholder="없음" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} /></label>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={intraday} onChange={(e) => setIntraday(e.target.checked)} />
              장중 매도: 손절·익절{isCustom && mode === "cycle" ? "·하락 매도" : ""} 가격에 장중에 닿으면 그날 그 가격에 판 것으로 계산
            </label>
            <p className="help">끄면 종가 확인 후 다음 날 시가에 팝니다.</p>
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
            {sourceHelp && <p className="help">{sourceHelp}</p>}
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
                    <p className="help">끄면 수익률이 실제보다 좋게 나옵니다.<Info>켜면 분기마다 그때의 시총 상위 종목(이후 상장폐지 포함)으로 바꿉니다. 과거 목록은 KRX에서 받으며 처음 한 번은 몇 분 걸립니다.</Info></p>
                  </>
                )}
              </>
            ) : (
              <>
                <label className="f" style={{ marginTop: 8 }}>종목 이름으로 찾아 넣기
                  <StockSearch keepOpen exclude={splitCodes(tickers)} onPick={(s) => setTickers((t) => appendCode(t, s.code))} />
                </label>
                <label className="f" style={{ marginTop: 8 }}>종목코드 (쉼표 구분)
                  <input value={tickers} onChange={(e) => setTickers(e.target.value)} />
                </label>
                <StockChips value={tickers} onChange={setTickers} />
                <p className="help">한국 005930, 미국 AAPL·SPY 처럼 넣고 섞어도 됩니다.</p>
                {(source === "naver" || source === "kis") && <BackfillPicker tickers={parseTickers(tickers)} value={backfill} onChange={setBackfill} />}
              </>
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
            {hasUs && (
              <div className="row" style={{ marginTop: 8 }}>
                <label className="f">미국 수수료 % (매수·매도)<input value={usCommission} onChange={(e) => setUsCommission(e.target.value)} /></label>
                <label className="f">미국 환전 비용 % (살 때·팔 때)<input value={usFx} onChange={(e) => setUsFx(e.target.value)} /></label>
              </div>
            )}
            <div className="row" style={{ marginTop: 8, alignItems: "flex-end" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, paddingBottom: 8 }}>
                <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={useDiv} onChange={(e) => setUseDiv(e.target.checked)} />
                배당금·분배금 반영
              </label>
              {useDiv && <label className="f">배당소득세 %<input placeholder="15.4" value={divTax} onChange={(e) => setDivTax(e.target.value)} /></label>}
            </div>
            <p className="help">신호는 당일 종가, 체결은 다음 날 시가.<Info>추가 입금은 다음 달부터 매월 첫 거래일 장 전에 들어오며, 수익률은 입금 효과를 뺀 값입니다. 매도세를 비우면 연도별 법정세율(2024 0.18%, 2025 0.15%, 2026 0.20%)을 씁니다.
              {useDiv && " 배당금은 배당락일에 세후 현금으로 들어와 수익으로 계산합니다. 배당소득세 기본 15.4%(ISA·연금은 0), 미국은 원천징수 15%."}
              {hasUs && " 미국 종목은 그날 환율로 원화 환산하며 거래세·양도소득세는 빼고 계산합니다(한국투자증권 기본 수수료 0.25%)."}</Info></p>
          </div>

          <button className="primary" onClick={run} disabled={!!busy}>
            {busy ? <><span className="spin" />실행 중</> : "백테스트 실행"}
          </button>

          <div className="card">
            <h2>전략 비교</h2>
            <p className="desc">고른 전략을 지금 기간·자금·비용으로 함께 돌려 나란히 봅니다 (최대 {MAX_COMPARE}개).<Info>내 전략은 저장된 종목으로, 기본 전략은 지금 화면의 종목·파라미터로 돌립니다. S&amp;P 500·KOSPI도 함께 표시합니다.</Info></p>
            <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", marginTop: 8 }}>
              {[true, false].map((mine) => {
                const opts = compareOptions.filter((o) => o.mine === mine);
                if (!opts.length) return null;
                return (
                  <div key={String(mine)}>
                    <div className="help" style={{ margin: "4px 0" }}>{mine ? "내 전략" : "기본 제공"}</div>
                    {opts.map((o) => {
                      const on = picked.includes(o.id);
                      return (
                        <label key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "3px 0", opacity: !on && picked.length >= MAX_COMPARE ? 0.5 : 1 }}>
                          <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={on} disabled={!on && picked.length >= MAX_COMPARE} onChange={() => togglePick(o.id)} />
                          {o.name}
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="btns" style={{ marginTop: 10 }}>
              <button className="primary" onClick={runCompare} disabled={!!busy || picked.length < 2}>
                {busy ? <><span className="spin" />실행 중</> : picked.length < 2 ? "전략을 2개 이상 고르세요" : `${picked.length}개 전략 비교`}
              </button>
              {picked.length > 0 && <button onClick={() => setCompareIds([])} disabled={!!busy}>선택 지우기</button>}
            </div>
          </div>

          <div className="card">
            <h2>전략 찾기 (종목 1~3개)</h2>
            <p className="desc">직접 입력한 종목 1~3개로 전략 6가지·설정 약 100개를 시험해 가장 좋은 것을 찾습니다.</p>
            <label className="f" style={{ marginTop: 10 }}>무엇을 기준으로 고를까요
              <select value={objective} onChange={(e) => setObjective(e.target.value as Objective)}>
                {OBJECTIVES.map((o) => <option key={o.id} value={o.id}>{o.id === "capped" ? `최대 낙폭 -${target.mdd}% 안에서 수익률이 가장 높은 것` : o.label}</option>)}
              </select>
            </label>
            <p className="help">{OBJECTIVES.find((o) => o.id === objective)?.help}</p>
            <label className="f" style={{ marginTop: 8 }}>확인 구간 (고를 때 보지 않을 마지막 기간)
              <select value={testRatio} onChange={(e) => setTestRatio(Number(e.target.value))}>
                <option value={0.2}>마지막 20%</option><option value={0.3}>마지막 30%</option><option value={0.4}>마지막 40%</option><option value={0.5}>마지막 50%</option>
              </select>
            </label>
            <p className="help">앞 구간으로 고르고 확인 구간에서 통했는지 봅니다. 5년 이상 권장.</p>
            <button className="primary" style={{ marginTop: 10 }} onClick={findStrategy} disabled={!!busy || !finderReady}>
              {busy ? <><span className="spin" />실행 중</> : finderReady ? `${finderList.length}종목으로 전략 찾기` : "종목을 1~3개 직접 입력하세요"}
            </button>
          </div>
        </section>

        <section className="stack">
          {busy && <div className="card"><span className="spin" />{busy}</div>}
          {error && <div className="error">{error}</div>}
          {warnings.length > 0 && (
            <div className="notice"><b>참고</b><ul>{warnings.slice(0, 8).map((w, k) => <li key={k}>{w}</li>)}</ul>
              {warnings.length > 8 && <span>외 {warnings.length - 8}건</span>}</div>
          )}
          {cmp && cmpFirst && <CompareResults report={cmp} onOpen={openFromCompare} onClose={() => setCmp(null)} />}
          {finder && finderFirst && <FinderResults report={finder.report} holdName={finder.holdName} onApply={applyCandidate} onClose={() => setFinder(null)} />}
          {out ? <Results {...out} onSensitivity={sensitivity} /> : !busy && !finder && !cmp && (
            <div className="card empty">
              <p><b>전략과 기간을 정하고 ‘백테스트 실행’을 누르세요.</b></p>
            </div>
          )}
          {finder && !finderFirst && <FinderResults report={finder.report} holdName={finder.holdName} onApply={applyCandidate} onClose={() => setFinder(null)} />}
          {cmp && !cmpFirst && <CompareResults report={cmp} onOpen={openFromCompare} onClose={() => setCmp(null)} />}
        </section>
      </main>
    </>
  );
}
