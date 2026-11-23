"use client";

import { useCallback, useEffect, useState } from "react";
import Login, { fetchAuth, type AuthState } from "@/components/Login";
import SecurityCard from "@/components/SecurityCard";
import DiagTokenCard from "@/components/DiagTokenCard";
import UsersCard from "@/components/UsersCard";
import ServerStatusCard from "@/components/ServerStatusCard";
import StockListCard from "@/components/StockListCard";
import Info from "@/components/Info";
import AppNav from "@/components/AppNav";
import type { FieldView, SettingsPatch, SettingsView as BaseView } from "@/lib/settings/view";

type ServerLock = { at?: number; ownerTotp: boolean };
type SettingsView = BaseView & { scope?: "owner" | "member"; realLock?: { server: boolean; granted: boolean; totp: boolean; open: boolean }; serverLock?: ServerLock };
import type { DataSource } from "@/lib/settings/store";

type Env = "real" | "mock";
type KeyForm = { appKey: string; appSecret: string; account: string };
const emptyKeys = (): KeyForm => ({ appKey: "", appSecret: "", account: "" });

function FieldState({ f }: { f: FieldView }) {
  if (f.set) return <span className="fieldline"><span className="badge ok">설정됨</span>{f.hint ? ` ${f.hint}` : ""}</span>;
  return <span className="fieldline"><span className="badge no">없음</span></span>;
}

export default function SettingsPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [keys, setKeys] = useState<Record<Env, KeyForm>>({ real: emptyKeys(), mock: emptyKeys() });
  const [bt, setBt] = useState({ source: "naver" as DataSource, cash: "", commission: "", slippage: "", sellTax: "", usCommission: "", usFx: "", universeSize: "", targetCagr: "", maxDrawdown: "" });
  const [limit, setLimit] = useState({ perOrder: "", perDay: "" });
  const [alim, setAlim] = useState({ realBudget: "", maxLoss: "" });
  const [realConfirm, setRealConfirm] = useState(false);
  const [realOtp, setRealOtp] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockOtp, setUnlockOtp] = useState("");
  const [pw, setPw] = useState({ current: "", next: "", next2: "" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const applyView = (v: SettingsView) => {
    setView(v);
    const b = v.backtest;
    setLimit({ perOrder: String(v.orderLimit.perOrder), perDay: String(v.orderLimit.perDay) });
    setAlim({ realBudget: String(v.autoLimit.realBudget), maxLoss: String(v.autoLimit.maxLoss) });
    setBt({ source: b.source, cash: String(b.cash), commission: String(b.commission), slippage: String(b.slippage), sellTax: b.sellTax == null ? "" : String(b.sellTax), usCommission: String(b.usCommission ?? 0.25), usFx: String(b.usFx ?? 0.1), universeSize: String(b.universeSize), targetCagr: String(b.targetCagr), maxDrawdown: String(b.maxDrawdown) });
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

  const save = async (patch: SettingsPatch & { otp?: string }, msg: string) => {
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

  const setServerLock = async (on: boolean) => {
    setError("");
    const r = await fetch("/api/settings/real-lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(on ? { on, code: unlockOtp } : { on }) });
    const j = await r.json();
    setUnlockOtp("");
    if (!r.ok) { setError(j.error ?? `HTTP ${r.status}`); if (r.status === 401) refresh(); return; }
    setUnlockOpen(false);
    await refresh();
    flash(on ? "실전 주문 잠금을 풀었습니다" : "실전 주문을 잠갔습니다");
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
    <AppNav title="설정" sub={auth?.user && auth.multiUser ? `${auth.user.name}(${auth.user.id})` : undefined}
      extra={auth?.loggedIn ? <button className="link" onClick={logout}>로그아웃</button> : undefined} />
  );

  if (!auth) return <>{header}<main className="settings"><p className="help">확인 중…</p></main></>;
  if (!auth.loggedIn) return <>{header}<main className="settings"><Login auth={auth} onDone={refresh} /></main></>;
  const pwCard = () => (
    <div className="card">
      <h2>{auth.user?.owner === false ? "내 비밀번호" : "관리자 비밀번호"}</h2>
      <>
          <label className="f">현재 비밀번호<input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></label>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="f">새 비밀번호<input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></label>
            <label className="f">새 비밀번호 확인<input type="password" value={pw.next2} onChange={(e) => setPw({ ...pw, next2: e.target.value })} autoComplete="new-password" /></label>
          </div>
          <button style={{ marginTop: 10 }} onClick={changePassword}>비밀번호 바꾸기</button>
          {auth.user?.owner === false
            ? <p className="help">잊어버렸으면 관리자에게 계정을 지우고 새 초대 링크를 달라고 하세요.</p>
            : <p className="help">잊어버렸으면<Info>NAS의 <code>nas/cache/config/users.json</code> 에서 owner 의 <code>passwordHash</code> 줄을 지우고 컨테이너를 다시 시작하세요. 새 설정 코드가 로그에 나옵니다.</Info></p>}
      </>
    </div>
  );

  if (!view) return <>{header}<main className="settings">{error ? <div className="error">{error}</div> : <p className="help">불러오는 중…</p>}</main></>;

  const trade = view.kis.tradeEnv;
  const isOwner = view.scope !== "member";
  const lock = view.realLock;
  const keyCard = (env: Env) => {
    const v = view.kis[env];
    const label = env === "real" ? "실전투자" : "모의투자";
    const k = keys[env];
    const set = (f: keyof KeyForm, val: string) => setKeys({ ...keys, [env]: { ...k, [f]: val } });
    const any = v.appKey.set || v.appSecret.set || v.account.set;
    return (
      <div className="card">
        <h2>한국투자증권 · {label}<Info>{env === "mock" ? "모의투자 주문·잔고·시세용" : "선택 · 시세를 더 빠르게 받습니다"}</Info></h2>
        {(["appKey", "appSecret", "account"] as const).map((f) => (
          <label className="f" key={f} style={{ marginTop: 8 }}>
            {f === "appKey" ? "앱키 (App Key)" : f === "appSecret" ? "앱시크릿 (App Secret)" : "계좌번호 (12345678-01)"}
            <input type={f === "account" ? "text" : "password"} value={k[f]} onChange={(e) => set(f, e.target.value)}
              placeholder={v[f].set ? "저장됨 · 바꿀 때만 입력" : ""} autoComplete="off" spellCheck={false} />
            <FieldState f={v[f]} />
          </label>
        ))}
        <div className="btns" style={{ marginTop: 12 }}>
          <button onClick={() => saveKeys(env)}>저장</button>
          {any && <button onClick={() => clearKeys(env)}>모두 지우기</button>}
        </div>
      </div>
    );
  };

  const sl = view.serverLock;
  const serverLockBox = (
    <div style={{ marginTop: 12 }}>
      <p className="help" style={{ margin: 0 }}>
        실전 주문 잠금: {view.realOrdersAllowed ? <span className="badge ok">해제됨</span> : <span className="badge no">잠김</span>}
        <Info>실전 주문은 &apos;실전&apos; 선택과 잠금 해제가 모두 있어야 나갑니다. 풀 때는 2단계 인증 코드가 필요하고, 잠글 때는 코드 없이 바로 잠깁니다. 2단계 인증을 끄면 자동으로 다시 잠깁니다.</Info>
      </p>
      {view.realOrdersAllowed ? (
        <div className="btns" style={{ marginTop: 8 }}>
          <button onClick={() => setServerLock(false)}>실전 주문 잠그기</button>
          {sl?.at ? <span className="help" style={{ margin: 0 }}>{new Date(sl.at).toLocaleString("ko-KR")} 에 풂</span> : null}
        </div>
      ) : !sl?.ownerTotp ? (
        <p className="help">잠금을 풀려면 먼저 아래 보안 칸에서 2단계 인증을 켜세요.</p>
      ) : !unlockOpen ? (
        <button style={{ marginTop: 8 }} onClick={() => setUnlockOpen(true)}>실전 주문 잠금 풀기</button>
      ) : (
        <div className="error" style={{ marginTop: 8 }}>
          잠금을 풀면 &apos;실전&apos;을 고른 계정과 실전 자동 매매에서 <b>실제 돈으로 주문</b>이 나갑니다.
          <label className="f" style={{ marginTop: 8, maxWidth: 220 }}>2단계 인증 코드
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={unlockOtp} onChange={(e) => setUnlockOtp(e.target.value.replace(/\D/g, ""))} placeholder="인증 앱의 6자리" />
          </label>
          <div className="btns" style={{ marginTop: 8 }}>
            <button disabled={unlockOtp.length !== 6} onClick={() => setServerLock(true)}>잠금 풀기</button>
            <button onClick={() => { setUnlockOpen(false); setUnlockOtp(""); }}>취소</button>
          </div>
        </div>
      )}
    </div>
  );

  const tradeCard = (
    <div className="card">
      <h2>주문 대상</h2>
      <div className="seg">
        <button className={trade.value === "mock" ? "on" : ""} onClick={() => { setRealConfirm(false); save({ kis: { tradeEnv: "mock" } }, "모의투자로 바꿨습니다"); }}>모의투자</button>
        <button className={trade.value === "real" ? "on" : ""} onClick={() => setRealConfirm(true)}>실전</button>
      </div>
      {realConfirm && trade.value !== "real" && (
        <div className="error" style={{ marginTop: 10 }}>
          실전으로 바꾸면 주문 화면의 주문이 <b>실제 돈으로 체결</b>됩니다.
          <label className="f" style={{ marginTop: 8, maxWidth: 220 }}>2단계 인증 코드
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={realOtp} onChange={(e) => setRealOtp(e.target.value.replace(/\D/g, ""))} placeholder="인증 앱의 6자리" />
          </label>
          <div className="btns" style={{ marginTop: 8 }}>
            <button disabled={realOtp.length !== 6} onClick={async () => { const ok = await save({ kis: { tradeEnv: "real" }, otp: realOtp }, "실전으로 바꿨습니다"); setRealOtp(""); if (ok) setRealConfirm(false); }}>실전으로 바꾸기</button>
            <button onClick={() => { setRealConfirm(false); setRealOtp(""); }}>취소</button>
          </div>
        </div>
      )}
      {isOwner ? serverLockBox : (
        <>
          <p className="help" style={{ marginTop: 10 }}>
            실전 주문 잠금: {lock?.open ? <span className="badge ok">해제됨</span> : <span className="badge no">잠김</span>}
          </p>
          <ul className="help" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            <li>서버의 실전 주문 잠금 해제 (관리자가 설정): {lock?.server ? "됨" : "안 됨"}</li>
            <li>관리자(owner)의 실전 허용: {lock?.granted ? "받음" : "아직 — 관리자에게 요청하세요"}</li>
            <li>내 계정의 2단계 인증: {lock?.totp ? "켜짐" : "꺼짐 — 아래 보안 칸에서 켜세요"}</li>
          </ul>
          <p className="help">셋 다 되고 &apos;실전&apos;을 골라야 실제 돈으로 주문이 나갑니다.</p>
        </>
      )}
      <h2 style={{ marginTop: 16 }}>실전 주문 금액 상한<Info>실전 주문에만 적용 · 0 = 제한 없음</Info></h2>
      <div className="row">
        <label className="f">1회 주문 상한(원)<input type="number" min={0} value={limit.perOrder} onChange={(e) => setLimit({ ...limit, perOrder: e.target.value })} /></label>
        <label className="f">하루 합계 상한(원)<input type="number" min={0} value={limit.perDay} onChange={(e) => setLimit({ ...limit, perDay: e.target.value })} /></label>
      </div>
      <button style={{ marginTop: 10 }} onClick={() => {
        if (limit.perOrder.trim() === "" || limit.perDay.trim() === "") return setError("상한 금액을 넣으세요. 제한을 없애려면 0 을 넣습니다.");
        save({ kis: { orderLimit: { perOrder: Number(limit.perOrder), perDay: Number(limit.perDay) } } }, "주문 금액 상한을 저장했습니다");
      }}>저장</button>
      <h2 style={{ marginTop: 16 }}>자동 매매 한도<Info>손실 한도만큼 잃으면 자동 매매를 멈추고 알립니다 · 0 = 제한 없음</Info></h2>
      <div className="row">
        <label className="f">실전 운용 금액 상한(원)<input type="number" min={0} step={100000} value={alim.realBudget} onChange={(e) => setAlim({ ...alim, realBudget: e.target.value })} /></label>
        <label className="f">손실 한도(%)<input type="number" min={0} max={100} step={1} value={alim.maxLoss} onChange={(e) => setAlim({ ...alim, maxLoss: e.target.value })} /></label>
      </div>
      <button style={{ marginTop: 10 }} onClick={() => {
        if (alim.realBudget.trim() === "" || alim.maxLoss.trim() === "") return setError("두 칸을 모두 넣으세요. 제한을 없애려면 0 을 넣습니다.");
        save({ kis: { autoLimit: { realBudget: Number(alim.realBudget), maxLoss: Number(alim.maxLoss) } } }, "자동 매매 한도를 저장했습니다");
      }}>저장</button>
    </div>
  );

  // owner 가 아닌 사람: 내 계정 설정만
  if (auth.user && !auth.user.owner) return (
    <>
      {header}
      <main className="settings">
        {(error || saved) && <div className="wide">{error ? <div className="error">{error}</div> : <span className="saved">✓ {saved}</span>}</div>}
        <div className="card">
          <h2>내 계정<Info>앱키·계좌는 암호화되어 본인만 씁니다. 결과와 추천은 참고용이며 투자 책임은 본인에게 있습니다.</Info></h2>
          <p className="desc"><b>{auth.user.name}</b> (<code>{auth.user.id}</code>) · {auth.user.role === "admin" ? "관리자" : "일반 사용자"}</p>
        </div>
        <div className="wide section"><h2>내 설정</h2></div>
        {keyCard("mock")}
        {keyCard("real")}
        {tradeCard}
        {pwCard()}
        <SecurityCard />
        {auth.user.role === "admin" && (<>
        <div className="wide section"><h2>관리<Info>모든 사용자에게 적용됩니다.</Info></h2></div>
          <UsersCard />
          <StockListCard />
          <ServerStatusCard />
        </>)}
      </main>
    </>
  );

  return (
    <>
      {header}
      <main className="settings">
        {(error || saved) && <div className="wide">{error ? <div className="error">{error}</div> : <span className="saved">✓ {saved}</span>}</div>}

        <div className="wide section"><h2>내 설정</h2></div>
        {keyCard("mock")}
        {keyCard("real")}

        {tradeCard}

        {pwCard()}

        <SecurityCard />

        <div className="wide section"><h2>관리<Info>모든 사용자에게 적용됩니다.</Info></h2></div>
        <UsersCard />

        <div className="card">
          <h2>백테스트 기본값</h2>
          
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
            <label className="f"><span>매도세 %<Info>비우면 연도별 법정세율을 씁니다.</Info></span><input placeholder="연도별 자동" value={bt.sellTax} onChange={(e) => setBt({ ...bt, sellTax: e.target.value })} /></label>
            <label className="f">미국 수수료 %<input value={bt.usCommission} onChange={(e) => setBt({ ...bt, usCommission: e.target.value })} /></label>
            <label className="f">미국 환전 비용 %<input value={bt.usFx} onChange={(e) => setBt({ ...bt, usFx: e.target.value })} /></label>
            <label className="f">목표 연 수익률 %<input type="number" value={bt.targetCagr} onChange={(e) => setBt({ ...bt, targetCagr: e.target.value })} /></label>
            <label className="f">감당할 최대 낙폭 %<input type="number" value={bt.maxDrawdown} onChange={(e) => setBt({ ...bt, maxDrawdown: e.target.value })} /></label>
          </div>
          <button style={{ marginTop: 10 }} onClick={() => save({
            backtest: { source: bt.source, cash: Number(bt.cash), commission: Number(bt.commission), slippage: Number(bt.slippage), sellTax: bt.sellTax.trim() === "" ? null : Number(bt.sellTax), usCommission: Number(bt.usCommission), usFx: Number(bt.usFx), universeSize: Number(bt.universeSize), targetCagr: Number(bt.targetCagr), maxDrawdown: Number(bt.maxDrawdown) },
          }, "백테스트 기본값을 저장했습니다")}>저장</button>
        </div>

        <StockListCard />

        <DiagTokenCard />

        <ServerStatusCard />

        <div className="card wide why">
          <details>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>설정 저장 위치와 이유</summary>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>항목</th><th>어디서</th><th>이유</th></tr></thead>
            <tbody>
              <tr><td>앱키·앱시크릿·계좌번호</td><td>화면</td><td>NAS 안의 파일(<code>nas/cache/config/settings.json</code>, 권한 600)에 저장됩니다. 화면에는 다시 보여주지 않고(끝 4자리만) 바꾸거나 지우기만 됩니다.</td></tr>
              <tr><td>주문 대상(모의/실전), 실전 주문 금액 상한, 백테스트 기본값</td><td>화면</td><td>자주 바꾸고 비밀값이 아닙니다.</td></tr>
              <tr><td>관리자 비밀번호</td><td>화면</td><td>scrypt 해시로만 저장합니다. 처음 만들 때는 컨테이너 로그에 나온 설정 코드가 있어야 해서, 남이 먼저 접속해 비밀번호를 정할 수 없습니다.</td></tr>
              <tr><td>2단계 인증</td><td>화면</td><td>인증 앱 키는 NAS 설정 파일에만 저장됩니다. 휴대폰을 잃어버리면 NAS 파일(<code>disable-2fa.txt</code>)로만 끌 수 있습니다.</td></tr>
              <tr><td>점검 키</td><td>화면</td><td>읽기 전용 점검 API(/api/diag)에만 쓰이고 주문·설정 변경에는 쓸 수 없습니다. 해시만 저장하고 기간이 지나면 저절로 막힙니다.</td></tr>
              <tr><td><b>실전 주문 잠금 해제</b>, 주문 대상을 실전으로</td><td>화면 + 2단계 인증</td><td>비밀번호만 새서는 실제 돈이 나가지 않게, 켤 때마다 인증 앱 코드를 다시 확인합니다. 2단계 인증이 꺼지면 잠금이 다시 걸립니다.</td></tr>
              <tr><td>포트, 실행 사용자(PUID/PGID)</td><td>docker-compose</td><td>컨테이너가 뜨기 전에 정해져야 하는 값이라 앱이 바꿀 수 없습니다.</td></tr>
            </tbody>
          </table>
          <p className="help">환경변수(.env)는 읽지 않습니다. 모든 설정은 이 화면에서 합니다.</p>
          </details>
        </div>
      </main>
    </>
  );
}
