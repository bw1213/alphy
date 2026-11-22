"use client";

import { useEffect, useState } from "react";
import type { AccountSummary } from "@/lib/accounts/list";
import Info from "@/components/Info";

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

/**
 * 내 계좌 목록 (자동·수동 함께). 수동 계좌는 onPick 이 있으면 그 화면 안에서 고르고, 없으면 그 계좌 화면으로 이동.
 * reload 가 바뀌면 다시 읽음.
 */
export default function AccountList({ current, onPick, onAdd, reload = 0 }: { current?: string; onPick?: (id: string) => void; onAdd?: () => void; reload?: number }) {
  const [list, setList] = useState<AccountSummary[] | null>(null);
  useEffect(() => {
    fetch("/api/accounts", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => setList(j?.accounts ?? [])).catch(() => setList([]));
  }, [reload]);
  const go = (a: AccountSummary) => {
    if (a.id === current) return;
    if (a.mode === "manual" && onPick) onPick(a.id); else window.location.href = a.href;
  };
  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>내 계좌
        <Info>자동: 앱이 한국투자증권에 직접 주문합니다. 직접: 저녁 계산의 안내를 보고 증권사 앱에서 주문한 뒤 체결을 기록합니다. 수익률은 입금·출금을 뺀 누적 수익률입니다.</Info>
        {onAdd && <button style={{ marginLeft: "auto", fontWeight: 400 }} onClick={onAdd}>+ 수동 계좌 추가</button>}
      </h2>
      {!list ? <p className="help">불러오는 중…</p> : !list.length ? <p className="help">아직 계좌가 없습니다. 한국투자증권은 <a href="/settings">설정</a>에서 연결합니다.</p> : (
        <div style={{ display: "grid", gap: 6 }}>
          {list.map((a) => (
            <button key={a.id} onClick={() => go(a)} aria-current={a.id === current ? "true" : undefined}
              style={{ textAlign: "left", display: "grid", gap: 2, borderColor: a.id === current ? "var(--accent)" : undefined }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b>{a.name}</b>
                <span className="help" style={{ margin: 0 }}>{a.mode === "auto" ? "자동 주문" : `${a.broker} · 직접 주문`}</span>
                {a.ret != null && <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: a.ret >= 0 ? "var(--bad)" : "var(--accent)" }}>{pct(a.ret)}</span>}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-2)" }}>
                {a.total != null ? won(a.total) : "잔고 미확인"} · {a.plan ? `${a.plan.label}${a.plan.enabled ? "" : " (꺼짐)"}` : "전략 없음"}{a.todo ? ` · 할 일 ${a.todo}건` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
