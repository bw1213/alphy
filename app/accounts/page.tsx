"use client";

import { useEffect, useState } from "react";
import AutoAccount from "@/components/accounts/AutoAccount";
import ManualAccount from "@/components/accounts/ManualAccount";

const KIS = "kis";

/** 계좌 화면 하나: ?id=kis 는 한국투자증권(자동 주문), 그 밖은 수동 계좌 */
export default function AccountsPage() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("id");
    if (want) return setId(want);
    fetch("/api/accounts", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((j) => setId(j?.accounts?.[0]?.id ?? "")).catch(() => setId(""));
  }, []);
  const go = (next: string) => {
    try { window.history.pushState(null, "", `/accounts?id=${next}`); } catch { /* 주소만 못 바꿈 */ }
    setId(next);
  };
  useEffect(() => {
    const back = () => setId(new URLSearchParams(window.location.search).get("id") ?? "");
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  if (id === null) return null;
  return id === KIS ? <AutoAccount onSwitch={go} /> : <ManualAccount key="manual" onSwitch={go} />;
}
