"use client";

import { useEffect, useState } from "react";

export interface AuthState { setupNeeded: boolean; loggedIn: boolean; passwordFromEnv: boolean; minPassword: number }

export async function fetchAuth(): Promise<AuthState> {
  const r = await fetch("/api/auth", { cache: "no-store" });
  return r.json();
}

/** 로그인 / 처음 비밀번호 만들기. 성공하면 onDone */
export default function Login({ auth, onDone, title = "관리자 로그인" }: { auth: AuthState; onDone: () => void; title?: string }) {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(""), [auth.setupNeeded]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (auth.setupNeeded) {
      if (password.length < auth.minPassword) return setError(`비밀번호는 ${auth.minPassword}자 이상으로 정하세요.`);
      if (password !== password2) return setError("두 비밀번호가 다릅니다.");
    }
    setBusy(true);
    try {
      const body = auth.setupNeeded ? { action: "setup", code, password } : { action: "login", password };
      const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setPassword(""); setPassword2("");
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 420 }}>
      <h2>{auth.setupNeeded ? "관리자 비밀번호 만들기" : title}</h2>
      {auth.setupNeeded ? (
        <>
          <p className="desc">처음 한 번만 합니다. 이 비밀번호로 설정 화면과 주문·잔고를 엽니다.</p>
          <p className="help">
            본인 확인용 <b>설정 코드</b>는 Container Manager → 컨테이너 → kospi-backtest → <b>로그</b>의 &quot;처음 설정 코드&quot; 줄,
            또는 File Station의 <code>nas/cache/config/setup-code.txt</code>에 있습니다.
          </p>
          <label className="f" style={{ marginTop: 10 }}>설정 코드 (8자리)
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required />
          </label>
          <label className="f" style={{ marginTop: 8 }}>새 비밀번호 ({auth.minPassword}자 이상)
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          </label>
          <label className="f" style={{ marginTop: 8 }}>비밀번호 확인
            <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required />
          </label>
        </>
      ) : (
        <label className="f">비밀번호
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
        </label>
      )}
      <button className="primary" style={{ marginTop: 12 }} disabled={busy}>{auth.setupNeeded ? "만들고 로그인" : "로그인"}</button>
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </form>
  );
}
