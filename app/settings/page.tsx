"use client";

import { useCallback, useEffect, useState } from "react";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import SecurityCard from "@/components/SecurityCard";
import DiagTokenCard from "@/components/DiagTokenCard";
import type { FieldView, SettingsPatch, SettingsView } from "@/lib/settings/view";
import type { DataSource } from "@/lib/settings/store";

type Env = "real" | "mock";
type KeyForm = { appKey: string; appSecret: string; account: string };
const emptyKeys = (): KeyForm => ({ appKey: "", appSecret: "", account: "" });

function FieldState({ f }: { f: FieldView }) {
  if (f.fromEnv) return <span className="fieldline">🔒 환경변수로 고정{f.hint ? ` (${f.hint})` : ""}</span>;
  if (f.set) return <span className="fieldline"><span className="badge ok">설정됨</span>{f.hint ? ` ${f.hint}` : ""}</span>;
  return <span className="fieldline"><span className="badge no">없음</span></span>;
}

export default function SettingsPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [keys, setKeys] = useState<Record<Env, KeyForm>>({ real: emptyKeys(), mock: emptyKeys() });
  const [bt, setBt] = useState({ source: "naver" as DataSource, cash: "", commission: "", slippage: "", sellTax: "", universeSize: "", targetCagr: "", maxDrawdown: "" });
  const [limit, setLimit] = useState({ perOrder: "", perDay: "" });
  const [realConfirm, setRealConfirm] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", next2: "" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const applyView = (v: SettingsView) => {
    setView(v);
    const b = v.backtest;
    setLimit({ perOrder: String(v.orderLimit.perOrder), perDay: String(v.orderLimit.perDay) });
    setBt({ source: b.source, cash: String(b.cash), commission: String(b.commission), slippage: String(b.slippage), sellTax: b.sellTax == null ? "" : String(b.sellTax), universeSize: String(b.universeSize), targetCagr: String(b.targetCagr), maxDrawdown: String(b.maxDrawdown) });
  };

  const refresh = useCallback(async () => {
    setError("");
    const a = await fetchAuth().catch(() => null);
    setAuth(a);
    if (!a?.loggedIn) { setView(null); return; }
    const r = await fetch("/api/settings", { cache: "no-store" });
    const j = await r.json();
    if (r.ok) applyView(j); else setError(j.error ?? `HTTP ${r.status}`);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const flash = (msg: string) => { setSaved(msg); setTimeout(() => setSaved(""), 2500); };

  const save = async (patch: SettingsPatch, msg: string) => {
    setError("");
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const j = await r.json();
    if (!r.ok) { setError(j.error ?? `HTTP ${r.status}`); if (r.status === 401) refresh(); return false; }
    applyView(j); flash(msg);
    return true;
  };

  const saveKeys = async (env: Env) => {
    const k = keys[env];
    const patch: Record<string, string> = {};
    for (const f of ["appKey", "appSecret", "account"] as const) if (k[f].trim()) patch[f] = k[f].trim();
    if (!Object.keys(patch).length) return setError("바꿀 값을 입력하세요. 비워 둔 칸은 그대로 유지됩니다.");
    if (await save({ kis: { [env]: patch } }, `${env === "real" ? "실전" : "모의투자"} 키를 저장했습니다`)) setKeys({ ...keys, [env]: emptyKeys() });
  };
  const clearKeys = async (env: Env) => {
    if (!window.confirm(`${env === "real" ? "실전" : "모의투자"} 앱키·앱시크릿·계좌번호를 모두 지울까요?`)) return;
    await save({ kis: { [env]: { appKey: "", appSecret: "", account: "" } } }, "지웠습니다");
  };

  const changePassword = async () => {
    setError("");
    if (pw.next !== pw.next2) return setError("새 비밀번호 두 개가 다릅니다.");
    const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "change", current: pw.current, password: pw.next }) });
    const j = await r.json();
    if (!r.ok) return setError(j.error ?? `HTTP ${r.status}`);
    setPw({ current: "", next: "", next2: "" }); flash("비밀번호를 바꿨습니다. 다른 기기는 다시 로그인해야 합니다.");
  };
  const logout = async () => { await fetch("/api/auth", { method: "DELETE" }); window.location.href = "/login"; };

  const header = (
    <header className="top">
      <h1>알피 설정</h1>
      <p>여기서 바꾼 값은 NAS에 저장되어 업데이트 후에도 유지됩니다.</p>
      <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 13 }}>
        <a href="/">백테스트</a><a href="/trade">주문·잔고</a>
        {auth?.loggedIn && <button className="link" onClick={logout}>로그아웃</button>}
      </span>
    </header>
  );

  if (!auth) return <>{header}<main className="settings"><p className="help">확인 중…</p></main></>;
  if (!auth.loggedIn) return <>{header}<main className="settings"><Login auth={auth} onDone={refresh} /></main></>;
  if (!view) return <>{header}<main className="settings">{error ? <div className="error">{error}</div> : <p className="help">불러오는 중…</p>}</main></>;

  const trade = view.kis.tradeEnv;
  const keyCard = (env: Env) => {
    const v = view.kis[env];
    const label = env === "real" ? "실전투자" : "모의투자";
    const k = keys[env];
    const set = (f: keyof KeyForm, val: string) => setKeys({ ...keys, [env]: { ...k, [f]: val } });
    const any = v.appKey.set || v.appSecret.set || v.account.set;
    const locked = v.appKey.fromEnv && v.appSecret.fromEnv && v.account.fromEnv;
    return (
      <div className="card">
        <h2>한국투자증권 · {label}</h2>
        <p className="help" style={{ marginTop: -6, marginBottom: 10 }}>
          {env === "mock" ? "먼저 이것부터. 모의투자 주문·잔고와 시세(초당 2건)에 씁니다." : "선택. 넣어 두면 시세를 실전 서버(초당 20건)로 빠르게 받습니다. 계좌번호는 실전 주문할 때만 필요합니다."}
        </p>
        {(["appKey", "appSecret", "account"] as const).map((f) => (
          <label className="f" key={f} style={{ marginTop: 8 }}>
            {f === "appKey" ? "앱키 (App Key)" : f === "appSecret" ? "앱시크릿 (App Secret)" : "계좌번호 (12345678-01)"}
            {v[f].fromEnv ? <div className="lock">.env 값 사용 중 — 여기서 바꾸려면 .env 에서 지우세요</div> : (
              <input type={f === "account" ? "text" : "password"} value={k[f]} onChange={(e) => set(f, e.target.value)}
                placeholder={v[f].set ? "저장됨 · 바꿀 때만 입력" : ""} autoComplete="off" spellCheck={false} />
            )}
            <FieldState f={v[f]} />
          </label>
        ))}
        {!locked && (
          <div className="btns" style={{ marginTop: 12 }}>
            <button onClick={() => saveKeys(env)}>저장</button>
            {any && <button onClick={() => clearKeys(env)}>모두 지우기</button>}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {header}
      <main className="settings">
        {(error || saved) && <div className="wide">{error ? <div className="error">{error}</div> : <span className="saved">✓ {saved}</span>}</div>}

        {keyCard("mock")}
        {keyCard("real")}

        <div className="card">
          <h2>주문 대상</h2>
          {trade.fromEnv ? <div className="lock">.env 의 KIS_TRADE_ENV={trade.value} 로 고정돼 있습니다</div> : (
            <div className="seg">
              <button className={trade.value === "mock" ? "on" : ""} onClick={() => { setRealConfirm(false); save({ kis: { tradeEnv: "mock" } }, "모의투자로 바꿨습니다"); }}>모의투자</button>
              <button className={trade.value === "real" ? "on" : ""} onClick={() => setRealConfirm(true)}>실전</button>
            </div>
          )}
          {realConfirm && trade.value !== "real" && (
            <div className="error" style={{ marginTop: 10 }}>
              실전으로 바꾸면 주문 화면의 주문이 <b>실제 돈으로 체결</b>됩니다.
              <div className="btns" style={{ marginTop: 8 }}>
                <button onClick={async () => { if (await save({ kis: { tradeEnv: "real" } }, "실전으로 바꿨습니다")) setRealConfirm(false); }}>실전으로 바꾸기</button>
                <button onClick={() => setRealConfirm(false)}>취소</button>
              </div>
            </div>
          )}
          <p className="help" style={{ marginTop: 10 }}>
            실전 주문 잠금: {view.realOrdersAllowed ? <span className="badge ok">해제됨 (KIS_ALLOW_REAL_ORDERS=yes)</span> : <span className="badge no">잠김</span>}
          </p>
          <p className="help">
            실전 주문은 여기서 &apos;실전&apos;을 고르고, <b>NAS의 .env 에 KIS_ALLOW_REAL_ORDERS=yes</b> 까지 넣어야 나갑니다.
            비밀번호가 새더라도 실제 돈이 나가지 않도록 이 잠금만은 화면에서 풀 수 없게 했습니다.
          </p>
          <h2 style={{ marginTop: 16 }}>실전 주문 금액 상한</h2>
          <div className="row">
            <label className="f">1회 주문 상한(원)<input type="number" min={0} value={limit.perOrder} onChange={(e) => setLimit({ ...limit, perOrder: e.target.value })} /></label>
            <label className="f">하루 합계 상한(원)<input type="number" min={0} value={limit.perDay} onChange={(e) => setLimit({ ...limit, perDay: e.target.value })} /></label>
          </div>
          <p className="help">실전 주문에만 적용됩니다(모의투자는 제한 없음). 실수로 큰 주문이 나가는 걸 막는 장치이고, 0 을 넣으면 제한이 없습니다. 하루 합계는 매수·매도 주문 금액을 모두 더합니다.</p>
          <button style={{ marginTop: 10 }} onClick={() => {
            if (limit.perOrder.trim() === "" || limit.perDay.trim() === "") return setError("상한 금액을 넣으세요. 제한을 없애려면 0 을 넣습니다.");
            save({ kis: { orderLimit: { perOrder: Number(limit.perOrder), perDay: Number(limit.perDay) } } }, "주문 금액 상한을 저장했습니다");
          }}>저장</button>
        </div>

        <div className="card">
          <h2>백테스트 기본값</h2>
          <p className="help" style={{ marginTop: -6, marginBottom: 10 }}>백테스트 화면을 열 때 처음 채워지는 값입니다. 화면에서 실행할 때마다 바꿀 수도 있습니다.</p>
          <label className="f">데이터
            <select value={bt.source} onChange={(e) => setBt({ ...bt, source: e.target.value as DataSource })}>
              <option value="naver">네이버 증권</option><option value="kis">한국투자증권 API</option>
              <option value="csv">내 CSV 파일</option><option value="synthetic">가짜 데이터</option>
            </select>
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="f">초기 자금(원)<input type="number" value={bt.cash} onChange={(e) => setBt({ ...bt, cash: e.target.value })} /></label>
            <label className="f">시총 상위 종목 수<input type="number" value={bt.universeSize} onChange={(e) => setBt({ ...bt, universeSize: e.target.value })} /></label>
            <label className="f">수수료 %<input value={bt.commission} onChange={(e) => setBt({ ...bt, commission: e.target.value })} /></label>
            <label className="f">슬리피지 %<input value={bt.slippage} onChange={(e) => setBt({ ...bt, slippage: e.target.value })} /></label>
            <label className="f">매도세 %<input placeholder="연도별 자동" value={bt.sellTax} onChange={(e) => setBt({ ...bt, sellTax: e.target.value })} /></label>
            <label className="f">목표 연 수익률 %<input type="number" value={bt.targetCagr} onChange={(e) => setBt({ ...bt, targetCagr: e.target.value })} /></label>
            <label className="f">감당할 최대 낙폭 %<input type="number" value={bt.maxDrawdown} onChange={(e) => setBt({ ...bt, maxDrawdown: e.target.value })} /></label>
          </div>
          <p className="help">목표 수익률과 최대 낙폭은 결과 화면의 달성 표시와 목표선에 쓰입니다. 장기 평균으로는 연 12~15%가 현실적인 범위이고 20%는 도전적인 목표입니다.</p>
          <p className="help">수수료는 내 계좌의 실제 온라인 수수료율을 넣으세요. 매도세를 비우면 연도별 법정세율을 씁니다.</p>
          <button style={{ marginTop: 10 }} onClick={() => save({
            backtest: { source: bt.source, cash: Number(bt.cash), commission: Number(bt.commission), slippage: Number(bt.slippage), sellTax: bt.sellTax.trim() === "" ? null : Number(bt.sellTax), universeSize: Number(bt.universeSize), targetCagr: Number(bt.targetCagr), maxDrawdown: Number(bt.maxDrawdown) },
          }, "백테스트 기본값을 저장했습니다")}>저장</button>
        </div>

        <div className="card">
          <h2>관리자 비밀번호</h2>
          {view.passwordFromEnv ? <div className="lock">.env 의 ADMIN_PASSWORD 로 고정돼 있습니다. 화면에서 관리하려면 .env 에서 지우세요.</div> : (
            <>
              <label className="f">현재 비밀번호<input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></label>
              <div className="row" style={{ marginTop: 8 }}>
                <label className="f">새 비밀번호<input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></label>
                <label className="f">새 비밀번호 확인<input type="password" value={pw.next2} onChange={(e) => setPw({ ...pw, next2: e.target.value })} autoComplete="new-password" /></label>
              </div>
              <button style={{ marginTop: 10 }} onClick={changePassword}>비밀번호 바꾸기</button>
              <p className="help">잊어버렸으면 NAS의 <code>nas/cache/config/settings.json</code> 에서 <code>passwordHash</code> 줄을 지우고 컨테이너를 다시 시작하세요. 새 설정 코드가 로그에 나옵니다.</p>
            </>
          )}
        </div>

        <SecurityCard />

        <DiagTokenCard />

        <div className="card wide why">
          <h2>어떤 건 화면에서, 어떤 건 환경변수로?</h2>
          <table>
            <thead><tr><th>항목</th><th>어디서</th><th>이유</th></tr></thead>
            <tbody>
              <tr><td>앱키·앱시크릿·계좌번호</td><td>화면</td><td>NAS 안의 파일(<code>nas/cache/config/settings.json</code>, 권한 600)에 저장되어 .env 파일과 보안 수준이 같습니다. 화면에는 다시 보여주지 않고(끝 4자리만) 바꾸거나 지우기만 됩니다.</td></tr>
              <tr><td>주문 대상(모의/실전), 실전 주문 금액 상한, 백테스트 기본값</td><td>화면</td><td>자주 바꾸고 비밀값이 아닙니다.</td></tr>
              <tr><td>관리자 비밀번호</td><td>화면</td><td>scrypt 해시로만 저장합니다. 처음 만들 때는 컨테이너 로그에 나온 설정 코드가 있어야 해서, 남이 먼저 접속해 비밀번호를 정할 수 없습니다.</td></tr>
              <tr><td>2단계 인증</td><td>화면</td><td>인증 앱 키는 NAS 설정 파일에만 저장됩니다. 휴대폰을 잃어버리면 NAS 파일(<code>disable-2fa.txt</code>)로만 끌 수 있습니다.</td></tr>
              <tr><td>점검 키</td><td>화면</td><td>읽기 전용 점검 API(/api/diag)에만 쓰이고 주문·설정 변경에는 쓸 수 없습니다. 해시만 저장하고 기간이 지나면 저절로 막힙니다.</td></tr>
              <tr><td><b>실전 주문 잠금 해제</b> (KIS_ALLOW_REAL_ORDERS)</td><td>.env 만</td><td>화면 비밀번호가 새거나 브라우저가 털려도 실제 돈이 나가지 않게, NAS 파일에 손댈 수 있는 사람만 풀 수 있게 했습니다.</td></tr>
              <tr><td>포트, 실행 사용자(PUID/PGID)</td><td>docker-compose</td><td>컨테이너가 뜨기 전에 정해져야 하는 값이라 앱이 바꿀 수 없습니다.</td></tr>
            </tbody>
          </table>
          <p className="help">예전처럼 .env 로 넣은 값도 그대로 동작하고 화면 값보다 우선합니다(🔒 표시). 화면에서 관리하려면 .env 에서 그 줄을 지우고 컨테이너를 다시 시작하세요.</p>
        </div>
      </main>
    </>
  );
}
