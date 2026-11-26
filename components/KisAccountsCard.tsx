"use client";

import { useState } from "react";
import Info from "@/components/Info";
import type { KisAccountView } from "@/lib/settings/view";

type Form = { id?: string; name: string; env: "real" | "mock"; appKey: string; appSecret: string; account: string; otp: string };
const blank = (): Form => ({ name: "", env: "mock", appKey: "", appSecret: "", account: "", otp: "" });

/** 기본 계좌 말고 한국투자증권 계좌를 더 붙여 계좌마다 따로 자동 매매 */
export default function KisAccountsCard({ accounts, onChanged }: { accounts: KisAccountView[]; onChanged: (msg: string) => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prev = form?.id ? accounts.find((a) => a.id === form.id) : undefined;
  const needOtp = !!form && form.env === "real" && prev?.env !== "real";

  const post = async (body: Record<string, unknown>, msg: string) => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/settings/kis-accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? `HTTP ${r.status}`); return; }
      setForm(null);
      onChanged(msg);
    } finally { setBusy(false); }
  };
  const submit = () => {
    if (!form) return;
    const { otp, ...rest } = form;
    post({ action: form.id ? "edit" : "add", ...rest, ...(needOtp ? { otp } : {}) }, form.id ? "계좌를 고쳤습니다" : "계좌를 붙였습니다. 계좌 화면에서 운용 전략을 고르세요.");
  };
  const set = (k: keyof Form, v: string) => form && setForm({ ...form, [k]: v });

  return (
    <div className="card">
      <h2>한국투자증권 계좌 더 붙이기<Info>위 기본 계좌 말고 연금저축·ISA·다른 종합계좌 등을 더 붙여 계좌마다 다른 전략으로 자동 매매합니다. 한국투자증권은 계좌마다 앱키가 따로 나오니 KIS Developers 에서 계좌별로 앱키를 받으세요. 잔고·주문·체결·성과·손실 한도·하루 주문 합계는 계좌번호마다 따로 셉니다. 상한 금액 설정값은 모든 계좌에 같은 값을 씁니다.</Info></h2>
      {accounts.length === 0 && !form && <p className="help">더 붙인 계좌가 없습니다.</p>}
      {accounts.length > 0 && (
        <ul className="plain" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
          {accounts.map((a) => (
            <li key={a.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line, #e5e5e5)" }}>
              <b>{a.name}</b>
              <span className={`badge ${a.env === "real" ? "no" : "ok"}`}>{a.env === "real" ? "실전" : "모의"}</span>
              <span className="help" style={{ margin: 0 }}>{a.account.hint ?? "계좌번호 없음"} · 앱키 {a.appKey.hint ?? "없음"}</span>
              <span style={{ flex: 1 }} />
              <a className="link" href={`/accounts?id=${a.id}`}>계좌 화면</a>
              <button disabled={busy} onClick={() => setForm({ ...blank(), id: a.id, name: a.name, env: a.env })}>고치기</button>
              <button disabled={busy} onClick={() => { if (window.confirm(`'${a.name}' 계좌를 지울까요? 이 계좌의 앱키·계좌번호가 지워집니다.`)) post({ action: "delete", id: a.id }, "계좌를 지웠습니다"); }}>지우기</button>
            </li>
          ))}
        </ul>
      )}
      {!form && <button style={{ marginTop: 10 }} disabled={busy} onClick={() => setForm(blank())}>계좌 더하기</button>}
      {form && (
        <div style={{ marginTop: 10 }}>
          <label className="f">계좌 이름<input value={form.name} maxLength={30} onChange={(e) => set("name", e.target.value)} placeholder="예: 연금저축, ISA" /></label>
          <div className="seg" style={{ marginTop: 8 }}>
            <button className={form.env === "mock" ? "on" : ""} onClick={() => set("env", "mock")}>모의투자</button>
            <button className={form.env === "real" ? "on" : ""} onClick={() => set("env", "real")}>실전</button>
          </div>
          {(["appKey", "appSecret", "account"] as const).map((f) => (
            <label className="f" key={f} style={{ marginTop: 8 }}>
              {f === "appKey" ? "앱키 (App Key)" : f === "appSecret" ? "앱시크릿 (App Secret)" : "계좌번호 (12345678-01)"}
              <input type={f === "account" ? "text" : "password"} value={form[f]} onChange={(e) => set(f, e.target.value)}
                placeholder={prev?.[f].set ? "저장됨 · 바꿀 때만 입력" : ""} autoComplete="off" spellCheck={false} />
            </label>
          ))}
          {needOtp && (
            <div className="error" style={{ marginTop: 8 }}>
              실전 계좌는 자동 매매에서 <b>실제 돈으로 주문</b>이 나갈 수 있습니다. 서버 실전 잠금이 풀려 있고 계좌 화면에서 &quot;실전 전환&quot;을 확인해야 주문합니다.
              <label className="f" style={{ marginTop: 8, maxWidth: 220 }}>2단계 인증 코드
                <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.otp} onChange={(e) => set("otp", e.target.value.replace(/\D/g, ""))} placeholder="인증 앱의 6자리" />
              </label>
            </div>
          )}
          {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
          <div className="btns" style={{ marginTop: 10 }}>
            <button className="primary" disabled={busy || (needOtp && form.otp.length !== 6)} onClick={submit}>{busy ? "저장 중…" : "저장"}</button>
            <button disabled={busy} onClick={() => { setForm(null); setError(""); }}>취소</button>
          </div>
        </div>
      )}
      {!form && error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
