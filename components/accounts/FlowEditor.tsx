"use client";

import { useState } from "react";
import type { Flow } from "@/lib/manual/returns";

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

export interface FlowAccount { id: string; name: string; color?: string }

const blank = { id: "", accountId: "", date: "", amount: "", side: "in" as "in" | "out", note: "" };

/** 입금·출금 넣기·고치기·지우기. 계좌가 하나면 계좌 고르기를 숨김 */
export default function FlowEditor({ accounts, flows, today, onChanged, limit = 50 }: {
  accounts: FlowAccount[];
  flows: Record<string, Flow[]>;
  today: string;
  onChanged: () => void | Promise<unknown>;
  limit?: number;
}) {
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [delAsk, setDelAsk] = useState("");
  const one = accounts.length === 1;
  const list = accounts.flatMap((a) => (flows[a.id] ?? []).map((f) => ({ a, f }))).sort((x, y) => y.f.at.localeCompare(x.f.at));

  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/dashboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? "저장하지 못했습니다.");
      await onChanged();
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  const save = async () => {
    const amount = Math.round(Number(form.amount.replace(/[,\s원]/g, "")));
    if (!(amount > 0)) return setError("입출금 금액을 넣으세요.");
    const accountId = form.accountId || accounts[0]?.id;
    const ok = await post({ action: "flow", accountId, date: form.date || today, amount: form.side === "in" ? amount : -amount, note: form.note, ...(form.id ? { id: form.id } : {}) });
    if (ok) setForm((f) => ({ ...blank, accountId: f.accountId, date: f.id ? "" : f.date }));
  };
  const edit = (accountId: string, f: Flow) => {
    setDelAsk("");
    setForm({ id: f.id, accountId, date: f.date, amount: String(Math.abs(f.amount)), side: f.amount >= 0 ? "in" : "out", note: f.note ?? "" });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!one && (
          <select aria-label="계좌" style={{ width: "auto" }} disabled={!!form.id} value={form.accountId || accounts[0]?.id || ""} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <select aria-label="구분" style={{ width: "auto" }} value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as "in" | "out" })}>
          <option value="in">입금</option><option value="out">출금</option>
        </select>
        <input aria-label="날짜" type="date" style={{ width: "auto" }} max={today} value={form.date || today} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <input aria-label="금액(원)" inputMode="numeric" placeholder="금액(원)" style={{ width: 140 }} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        <input aria-label="메모" placeholder="메모 (선택)" style={{ width: 160 }} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        <button className="primary" style={{ width: "auto" }} disabled={busy} onClick={save}>{form.id ? "고친 내용 저장" : "기록"}</button>
        {form.id && <button style={{ width: "auto" }} disabled={busy} onClick={() => setForm({ ...blank, accountId: form.accountId })}>취소</button>}
      </div>
      {error && <p className="help" style={{ color: "var(--bad)" }}>{error}</p>}
      {!list.length ? <p className="help">입출금 기록이 없습니다.</p> : (
        <div className="tablewrap" style={{ marginTop: 8 }}><table>
          <thead><tr><th>날짜</th>{!one && <th>계좌</th>}<th>금액</th><th>메모</th><th></th></tr></thead>
          <tbody>{list.slice(0, limit).map(({ a, f }) => (
            <tr key={f.id} style={form.id === f.id ? { background: "var(--bg)" } : undefined}>
              <td>{f.date}</td>
              {!one && <td>{a.color && <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: a.color, marginRight: 6 }} />}{a.name}</td>}
              <td style={{ fontWeight: 600 }}>{f.amount >= 0 ? `입금 ${won(f.amount)}` : `출금 ${won(-f.amount)}`}</td>
              <td>{f.note ?? ""}{f.auto ? <span className="help"> (자동)</span> : null}</td>
              <td>
                <button style={{ width: "auto", padding: "2px 8px", fontSize: 12 }} disabled={busy} onClick={() => edit(a.id, f)}>고치기</button>{" "}
                {delAsk !== f.id
                  ? <button style={{ width: "auto", padding: "2px 8px", fontSize: 12 }} disabled={busy} onClick={() => setDelAsk(f.id)}>지우기</button>
                  : <button style={{ width: "auto", padding: "2px 8px", fontSize: 12, background: "var(--bad)", borderColor: "var(--bad)", color: "#fff" }} disabled={busy} onClick={() => post({ action: "deleteFlow", id: f.id }).then((ok) => { setDelAsk(""); if (ok && form.id === f.id) setForm(blank); })}>정말 지우기</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
