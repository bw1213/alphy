"use client";

import { useState } from "react";
import Info from "@/components/Info";
import type { FieldView, KisAccountView } from "@/lib/settings/view";

type Env = "real" | "mock";
type Keys = { appKey: FieldView; appSecret: FieldView; account: FieldView };
type Form = { base?: Env; id?: string; name: string; env: Env; appKey: string; appSecret: string; account: string; otp: string };
const blank = (): Form => ({ name: "", env: "mock", appKey: "", appSecret: "", account: "", otp: "" });
const FIELDS = ["appKey", "appSecret", "account"] as const;
const fieldLabel = { appKey: "앱키 (App Key)", appSecret: "앱시크릿 (App Secret)", account: "계좌번호 (12345678-01)" };
const envLabel = (e: Env) => (e === "real" ? "실전" : "모의");

export default function KisAccountsCard({ base, accounts, onChanged }: { base: Record<Env, Keys>; accounts: KisAccountView[]; onChanged: (msg: string) => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prevKeys: Keys | undefined = form?.base ? base[form.base] : form?.id ? accounts.find((a) => a.id === form.id) : undefined;
  const prevEnv = form?.id ? accounts.find((a) => a.id === form.id)?.env : undefined;
  const needOtp = !!form && !form.base && form.env === "real" && prevEnv !== "real";

  const send = async (url: string, method: string, body: unknown, msg: string) => {
    setBusy(true); setError("");
    try {
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? `HTTP ${r.status}`); return; }
      setForm(null);
      onChanged(msg);
    } finally { setBusy(false); }
  };
  const post = (body: Record<string, unknown>, msg: string) => send("/api/settings/kis-accounts", "POST", body, msg);
  const putBase = (env: Env, keys: Record<string, string>, msg: string) => send("/api/settings", "PUT", { kis: { [env]: keys } }, msg);

  const submit = () => {
    if (!form) return;
    if (form.base) {
      const patch: Record<string, string> = {};
      for (const f of FIELDS) if (form[f].trim()) patch[f] = form[f].trim();
      if (!Object.keys(patch).length) return setError("바꿀 값을 입력하세요. 비워 둔 칸은 그대로 유지됩니다.");
      return putBase(form.base, patch, `기본 ${envLabel(form.base)} 계좌 키를 저장했습니다`);
    }
    const { otp, base: _b, ...rest } = form;
    post({ action: form.id ? "edit" : "add", ...rest, ...(needOtp ? { otp } : {}) }, form.id ? "계좌를 고쳤습니다" : "계좌를 붙였습니다. 계좌 화면에서 운용 전략을 고르세요.");
  };
  const set = (k: keyof Form, v: string) => form && setForm({ ...form, [k]: v });
  const open = (f: Form) => { setForm(f); setError(""); };
  const editing = (f: Partial<Form>) => !!form && form.base === f.base && form.id === f.id;

  const hint = (k: Keys) => k.account.set || k.appKey.set ? `${k.account.hint ?? "계좌번호 없음"} · 앱키 ${k.appKey.hint ?? "없음"}` : "없음";

  const formBox = form && (
    <div style={{ margin: "4px 0 10px", flexBasis: "100%" }}>
      {!form.base && (<>
        <label className="f">계좌 이름<input value={form.name} maxLength={30} onChange={(e) => set("name", e.target.value)} placeholder="예: 연금저축, ISA" /></label>
        <div className="seg" style={{ marginTop: 8 }}>
          <button className={form.env === "mock" ? "on" : ""} onClick={() => set("env", "mock")}>모의투자</button>
          <button className={form.env === "real" ? "on" : ""} onClick={() => set("env", "real")}>실전</button>
        </div>
      </>)}
      {FIELDS.map((f) => (
        <label className="f" key={f} style={{ marginTop: 8 }}>
          {fieldLabel[f]}
          <input type={f === "account" ? "text" : "password"} value={form[f]} onChange={(e) => set(f, e.target.value)}
            placeholder={prevKeys?.[f].set ? "저장됨 · 바꿀 때만 입력" : ""} autoComplete="off" spellCheck={false} />
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
  );

  const row = (key: string, title: React.ReactNode, env: Env, keys: Keys, actions: React.ReactNode, isEditing: boolean) => (
    <li key={key} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line, #e5e5e5)" }}>
      <b>{title}</b>
      <span className={`badge ${env === "real" ? "no" : "ok"}`}>{envLabel(env)}</span>
      <span className="help" style={{ margin: 0 }}>{hint(keys)}</span>
      <span style={{ flex: 1 }} />
      {actions}
      {isEditing && formBox}
    </li>
  );

  const baseRow = (env: Env) => {
    const k = base[env];
    const any = k.appKey.set || k.appSecret.set || k.account.set;
    return row(`base-${env}`,
      <>기본 계좌<Info>{env === "mock" ? "모의투자 주문·잔고·시세용" : "실전 주문·잔고용 · 시세도 더 빠르게 받습니다"}</Info></>,
      env, k,
      <>
        <button disabled={busy} onClick={() => open({ ...blank(), base: env, env })}>{any ? "고치기" : "넣기"}</button>
        {any && <button disabled={busy} onClick={() => { if (window.confirm(`기본 ${envLabel(env)} 계좌의 앱키·앱시크릿·계좌번호를 모두 지울까요?`)) putBase(env, { appKey: "", appSecret: "", account: "" }, "지웠습니다"); }}>지우기</button>}
      </>,
      editing({ base: env }));
  };

  return (
    <div className="card wide">
      <h2>한국투자증권 계좌<Info>기본 계좌(모의·실전) 말고 연금저축·ISA·다른 종합계좌 등을 더 붙여 계좌마다 다른 전략으로 자동 매매할 수 있습니다. 한국투자증권은 계좌마다 앱키가 따로 나오니 KIS Developers 에서 계좌별로 앱키를 받으세요. 잔고·주문·체결·성과·손실 한도·하루 주문 합계는 계좌번호마다 따로 셉니다. 상한 금액 설정값은 모든 계좌에 같은 값을 씁니다. 화면에는 앱키·계좌번호를 다시 보여주지 않고 바꾸거나 지우기만 됩니다.</Info></h2>
      <ul className="plain" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
        {baseRow("mock")}
        {baseRow("real")}
        {accounts.map((a) => row(a.id, a.name, a.env, a,
          <>
            <a className="link" href={`/accounts?id=${a.id}`}>계좌 화면</a>
            <button disabled={busy} onClick={() => open({ ...blank(), id: a.id, name: a.name, env: a.env })}>고치기</button>
            <button disabled={busy} onClick={() => { if (window.confirm(`'${a.name}' 계좌를 지울까요? 이 계좌의 앱키·계좌번호가 지워집니다.`)) post({ action: "delete", id: a.id }, "계좌를 지웠습니다"); }}>지우기</button>
          </>,
          editing({ id: a.id })))}
      </ul>
      {form && !form.base && !form.id ? formBox : <button style={{ marginTop: 10 }} disabled={busy} onClick={() => open(blank())}>계좌 더하기</button>}
      {!form && error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
