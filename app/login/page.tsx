"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Login, { fetchAuth, type AuthState } from "@/components/Login";

/** 같은 사이트 안의 경로만 (다른 사이트로 보내는 링크 악용 방지) */
const safeNext = (v: string | null) => (v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/");

/** 로그인 뒤 갈 곳: ?next=, 또는 다른 화면 주소에서 이 화면이 대신 열린 경우 그 주소 */
function target(params: URLSearchParams): string {
  if (typeof window !== "undefined" && !/^\/login\/?$/.test(window.location.pathname)) return window.location.pathname + window.location.search;
  return safeNext(params.get("next"));
}

function LoginInner() {
  const params = useSearchParams();
  const next = target(new URLSearchParams(params.toString()));
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState("");
  const load = () => fetchAuth().then((a) => {
    if (a.loggedIn) window.location.replace(next); else setAuth(a);
  }).catch(() => setError("서버에 연결하지 못했습니다."));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="settings" style={{ display: "flex", justifyContent: "center", paddingTop: 60 }}>
      {error ? <div className="error">{error}</div>
        : !auth ? <p className="help">확인 중…</p>
        : <Login auth={auth} onDone={() => window.location.replace(next)} title="알피 로그인" />}
    </main>
  );
}

export default function LoginPage() {
  return (
    <>
      <header className="top"><h1>알피</h1><p>로그인해야 쓸 수 있습니다.</p></header>
      <Suspense><LoginInner /></Suspense>
    </>
  );
}
