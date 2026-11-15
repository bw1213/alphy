"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface JoinInfo { minPassword: number; invite?: { name: string; expiresAt: number } | null }

/** 초대 링크(/join?code=...)로 가입하는 화면. 로그인 없이 열림 */
function JoinInner() {
  const code = useSearchParams().get("code") ?? "";
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [f, setF] = useState({ id: "", name: "", password: "", password2: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/auth?invite=${encodeURIComponent(code)}`, { cache: "no-store" }).then((r) => r.json())
      .then((j: JoinInfo) => { setInfo(j); if (j.invite) setF((x) => ({ ...x, name: j.invite!.name })); })
      .catch(() => setError("서버에 연결하지 못했습니다."));
  }, [code]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!info) return;
    if (f.password.length < info.minPassword) return setError(`비밀번호는 ${info.minPassword}자 이상으로 정하세요.`);
    if (f.password !== f.password2) return setError("두 비밀번호가 다릅니다.");
    setBusy(true);
    try {
      const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "join", invite: code, id: f.id, name: f.name, password: f.password }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      window.location.replace("/settings");
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!info) return error ? <div className="error">{error}</div> : <p className="help">확인 중…</p>;
  if (!info.invite) return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h2>초대 링크를 쓸 수 없습니다</h2>
      <p className="help">이미 사용했거나 기간(3일)이 지났습니다. 초대한 사람에게 새 링크를 받아 주세요.</p>
      <p className="help"><a href="/login">로그인 화면으로</a></p>
    </div>
  );
  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 420 }}>
      <h2>알피 가입</h2>
      <p className="desc">초대받은 분만 가입할 수 있습니다. 이 링크는 한 번만 쓸 수 있고 {new Date(info.invite.expiresAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" })}까지 유효합니다.</p>
      <label className="f">아이디 (영문 소문자·숫자, 로그인할 때 씀)
        <input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.toLowerCase() })} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} pattern="[a-z0-9][a-z0-9_-]*" required autoFocus />
      </label>
      <label className="f" style={{ marginTop: 8 }}>이름
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={30} required />
      </label>
      <label className="f" style={{ marginTop: 8 }}>비밀번호 ({info.minPassword}자 이상)
        <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required />
      </label>
      <label className="f" style={{ marginTop: 8 }}>비밀번호 확인
        <input type="password" value={f.password2} onChange={(e) => setF({ ...f, password2: e.target.value })} autoComplete="new-password" required />
      </label>
      <p className="help" style={{ marginTop: 10 }}>가입한 뒤 설정 화면에서 <b>2단계 인증</b>을 켜 두시길 권합니다. 백테스트 결과와 추천은 과거 자료를 바탕으로 한 참고용이며, 투자 판단과 책임은 본인에게 있습니다.</p>
      <button className="primary" style={{ marginTop: 12 }} disabled={busy}>가입하고 시작</button>
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </form>
  );
}

export default function JoinPage() {
  return (
    <>
      <header className="top"><h1>알피</h1><p>초대받은 분의 가입 화면입니다.</p></header>
      <main className="settings" style={{ display: "flex", justifyContent: "center", paddingTop: 60 }}>
        <Suspense><JoinInner /></Suspense>
      </main>
    </>
  );
}
