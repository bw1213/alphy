"use client";

import { useCallback, useEffect, useState } from "react";
import Info from "@/components/Info";
import { StockSearch, useNameOf } from "@/components/StockSearch";
import { fetchJob } from "@/lib/client/fetchData";
import { withCode } from "@/lib/strategies/universe";
import { CASH_KINDS, KIND_LABEL, type LedgerEntry, type LedgerKind, type ParsedLine } from "@/lib/accounts/ledger";
import type { LedgerStatus } from "@/lib/accounts/ledgerStore";

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const money = (n: number | undefined, usd?: boolean) => (n == null ? "" : usd ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : won(n));
const KINDS = Object.keys(KIND_LABEL) as LedgerKind[];
const small = { width: "auto", padding: "2px 8px", fontSize: 12 } as const;

interface Form { id: string; date: string; kind: LedgerKind; ticker: string; name: string; qty: string; price: string; amount: string; fee: string; usd: boolean; note: string }
const blank = (date = ""): Form => ({ id: "", date, kind: "buy", ticker: "", name: "", qty: "", price: "", amount: "", fee: "", usd: false, note: "" });

const SAMPLE = "날짜\t구분\t종목\t수량\t가격\t금액\t수수료\t통화\t메모\n2019-03-04\t입금\t\t\t\t10,000,000\n2019-03-05\t매수\t삼성전자 (005930)\t100\t45,000\t\t700\n2019-04-19\t배당\t005930\t\t\t35,400\n2020-01-06\t입고\tAAPL\t10\t\t\t\t\t다른 증권사에서 옮김";

/** 계좌 과거 기록: 한 건씩 넣기·붙여넣기·고치기·지우기, 바뀌면 과거 평가액 다시 계산 */
export default function Ledger({ id, onChanged }: { id: string; onChanged: () => unknown }) {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [status, setStatus] = useState<LedgerStatus | null>(null);
  const [today, setToday] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedLine[] | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState<{ line: string; error: string }[]>([]);
  const [delAsk, setDelAsk] = useState("");
  const [clearAsk, setClearAsk] = useState(false);
  const [limit, setLimit] = useState(20);
  const [progress, setProgress] = useState("");
  const [open, setOpen] = useState(false);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/ledger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: id, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? "저장하지 못했습니다.");
    return j;
  };

  const load = useCallback(async () => {
    const r = await fetch(`/api/ledger?account=${encodeURIComponent(id)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? "과거 기록을 불러오지 못했습니다.");
    setEntries(j.entries); setStatus(j.status); setToday(j.today);
    return j.status as LedgerStatus;
  }, [id]);

  const build = useCallback(async () => {
    setBusy("build"); setProgress("");
    try {
      const r = await fetchJob<{ warnings: string[] }>("/api/ledger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: id, action: "build" }) },
        (p) => setProgress(`${p.done}/${p.total} 종목`), undefined, 720, 2000, "과거 평가액 계산");
      await load();
      await onChanged();
      return r;
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); setProgress(""); }
  }, [id, load, onChanged]);

  useEffect(() => {
    load().then((s) => { if (s.stale) build(); }).catch((e) => setError((e as Error).message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const run = async (what: string, fn: () => Promise<string | void>) => {
    setBusy(what); setError(""); setMsg("");
    try {
      const m = await fn();
      if (m) setMsg(m);
      const s = await load();
      if (s.stale) await build(); else await onChanged();
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy((b) => (b === what ? "" : b)); }
  };

  const entryOf = (f: Form) => ({ date: f.date || today, kind: f.kind, ticker: f.ticker, name: f.name, qty: f.qty, price: f.price, amount: f.amount, fee: f.fee, currency: f.usd ? "USD" : "", note: f.note });
  const save = () => form && run("save", async () => {
    if (form.id) { await post({ action: "edit", id: form.id, entry: entryOf(form) }); setForm(null); return "기록을 고쳤습니다."; }
    const j = await post({ action: "add", entries: [entryOf(form)] });
    if (j.skipped?.length) throw new Error(j.skipped[0].error);
    setForm(blank(form.date));
    return "기록했습니다.";
  });
  const edit = (x: LedgerEntry) => {
    setDelAsk(""); setPaste(null);
    setForm({ id: x.id, date: x.date, kind: x.kind, ticker: x.ticker ?? "", name: x.name ?? "", qty: x.qty != null ? String(x.qty) : "", price: x.price != null ? String(x.price) : "", amount: x.amount != null ? String(x.amount) : "", fee: x.fee != null ? String(x.fee) : "", usd: x.currency === "USD", note: x.note ?? "" });
  };
  const readPaste = async () => {
    setBusy("parse"); setError(""); setSkipped([]);
    try { setRows((await post({ action: "parse", text: paste ?? "" })).rows); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };
  const savePaste = () => rows && run("paste", async () => {
    const good = rows.filter((r) => r.entry);
    const j = await post({ action: "add", entries: good.map((r) => r.entry) });
    setSkipped((j.skipped ?? []).map((s: { index: number; error: string }) => ({ line: `${good[s.index].line}줄: ${good[s.index].text.slice(0, 60)}`, error: s.error })));
    setRows(null);
    if (!j.skipped?.length) setPaste(null);
    return `${j.added}건을 넣었습니다${j.skipped?.length ? `, ${j.skipped.length}건은 건너뛰었습니다` : ""}.`;
  });

  const nameOf = useNameOf([...new Set([...(entries ?? []), ...(rows ?? []).map((r) => r.entry)].map((x) => x?.ticker).filter((t): t is string => !!t))]);
  const label = (x: { ticker?: string; name?: string }) => (x.ticker ? withCode(x.name || nameOf(x.ticker), x.ticker) : "");
  const list = [...(entries ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  const b = status?.built;
  const stockKind = form && !CASH_KINDS.includes(form.kind);
  const gap = status?.join ? status.join.live - status.join.past : 0;

  return (
    <div className="card">
      <h2 style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        과거 기록
        <Info>
          앱이 이 계좌를 기록하기 전의 입금·출금·매매·배당을 넣으면, 그날그날 보유와 예수금을 다시 만들고 실제 종가로 평가해 누적 수익률을 처음부터 이어 계산합니다.
          {status?.started ? ` 앱 기록은 ${status.upTo}부터라 그 전 날짜만 받습니다. 그 뒤의 매매·입출금은 체결 기록·입금·출금으로 넣고, 배당·이자·비용은 여기 넣으면 수동 계좌 예수금에 바로 더합니다.` : ""}
          {" "}입고·출고(다른 증권사에서 주식 옮김)는 입출금처럼 수익률에서 빼고, 가격을 비우면 그날 종가로 봅니다. 배당·이자는 세후 금액을 넣으세요. 금액은 원화, 달러로 넣을 때는 통화를 USD로 하면 그날 환율로 바꿉니다. 수수료를 비우면 설정의 비용률로 어림합니다. 액면분할 전 수량·가격은 그대로 넣어도 시세와 비교해 맞춥니다.
        </Info>
        <span className="help" style={{ margin: 0, fontWeight: 400 }}>{entries ? `${list.length}건` : "불러오는 중…"}{busy === "build" ? ` · 과거 평가액 계산 중${progress ? ` (${progress})` : "…"}` : ""}</span>
        <button style={{ width: "auto", marginLeft: "auto", fontSize: 13 }} onClick={() => setOpen((v) => !v)}>{open ? "닫기" : list.length ? "보기·넣기" : "넣기"}</button>
      </h2>
      {!open && !list.length && <p className="help" style={{ margin: 0 }}>앱이 기록하기 전의 입금·출금·매매·배당을 넣으면 누적 수익률을 처음부터 계산합니다.</p>}

      {b && (
        <div style={{ marginTop: 6, fontSize: 13 }}>
          <p className="help" style={{ margin: 0 }}>
            {b.from} ~ {b.upTo} · 입금 {won(b.sums.deposit)} · 출금 {won(b.sums.withdraw)}{b.sums.transferIn ? ` · 입고 ${won(b.sums.transferIn)}` : ""}{b.sums.transferOut ? ` · 출고 ${won(b.sums.transferOut)}` : ""} · 배당 {won(b.sums.dividend)}{b.sums.interest ? ` · 이자 ${won(b.sums.interest)}` : ""} · 매매 비용 {won(b.sums.tradeFee + b.sums.fee)}
          </p>
          {status?.join && (
            <p className="help" style={{ margin: "2px 0 0", color: Math.abs(gap) > Math.max(10_000, status.join.live * 0.01) ? "var(--bad)" : undefined }}>
              {status.join.date} 과거 기록으로 계산한 평가액 {won(status.join.past)} · 앱 첫 기록 {won(status.join.live)}
              {gap ? ` · 차이 ${gap > 0 ? "+" : "−"}${won(Math.abs(gap))} (수익률에 넣지 않음${Math.abs(gap) > Math.max(10_000, status.join.live * 0.01) ? ", 빠진 기록이 있는지 확인하세요" : ""})` : " · 딱 맞습니다"}
            </p>
          )}
          {!!b.warnings.length && (
            <details style={{ marginTop: 4 }}><summary className="help" style={{ cursor: "pointer" }}>계산 참고 {b.warnings.length}건</summary>
              {b.warnings.map((w, i) => <p key={i} className="help" style={{ margin: "2px 0 0" }}>※ {w}</p>)}
            </details>
          )}
        </div>
      )}

      {open && <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        <button style={{ width: "auto" }} disabled={!!busy} onClick={() => { setPaste(null); setForm(form && !form.id ? null : blank()); }}>{form && !form.id ? "한 건 넣기 닫기" : "한 건 넣기"}</button>
        <button style={{ width: "auto" }} disabled={!!busy} onClick={() => { setForm(null); setRows(null); setPaste(paste == null ? "" : null); }}>{paste != null ? "붙여넣기 닫기" : "엑셀·CSV 붙여넣기"}</button>
        {!!list.length && <a href={`/api/ledger?account=${encodeURIComponent(id)}&csv=1`} style={{ alignSelf: "center", fontSize: 13 }}>CSV로 받기</a>}
        {!!status?.count && (
          !clearAsk ? <button style={{ width: "auto" }} disabled={!!busy} onClick={() => setClearAsk(true)}>모두 지우기</button>
            : <button style={{ width: "auto", background: "var(--bad)", borderColor: "var(--bad)", color: "#fff" }} disabled={!!busy} onClick={() => run("clear", async () => { const j = await post({ action: "clear" }); setClearAsk(false); return `과거 기록 ${j.removed}건을 지웠습니다.`; })}>과거 기록 {status.count}건 정말 지우기</button>
        )}
      </div>

      {form && (
        <div style={{ marginTop: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8, display: "grid", gap: 8 }}>
          {form.id && <b style={{ fontSize: 13 }}>기록 고치기</b>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 8 }}>
            <label className="f">날짜<input type="date" max={today} value={form.date || today} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <label className="f">구분<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as LedgerKind })}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
            <label className="f">통화<select value={form.usd ? "USD" : "KRW"} onChange={(e) => setForm({ ...form, usd: e.target.value === "USD" })}><option value="KRW">원</option><option value="USD">달러</option></select></label>
          </div>
          {(stockKind || form.kind === "dividend") && (
            !form.ticker
              ? <StockSearch placeholder={form.kind === "dividend" ? "배당 준 종목 (선택)" : "종목 이름으로 찾기"} onPick={(s) => setForm({ ...form, ticker: s.code, name: s.name })} />
              : <p style={{ margin: 0, fontSize: 13 }}><b>{withCode(form.name, form.ticker)}</b> <button style={small} onClick={() => setForm({ ...form, ticker: "", name: "" })}>바꾸기</button></p>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 8 }}>
            {stockKind ? (
              <>
                <label className="f">수량<input inputMode="decimal" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></label>
                <label className="f">{form.kind === "in" || form.kind === "out" ? "가격 (비우면 종가)" : "1주 가격"}<input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
                {(form.kind === "buy" || form.kind === "sell") && <label className="f">수수료·세금 (비우면 어림)<input inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></label>}
              </>
            ) : <label className="f">{form.kind === "dividend" || form.kind === "interest" ? "받은 금액 (세후)" : "금액"}<input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>}
            <label className="f">메모<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="primary" style={{ width: "auto" }} disabled={!!busy} onClick={save}>{busy === "save" ? "저장 중…" : form.id ? "고친 내용 저장" : "기록"}</button>
            <button style={{ width: "auto" }} disabled={!!busy} onClick={() => setForm(null)}>취소</button>
          </div>
        </div>
      )}

      {paste != null && (
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <p className="help" style={{ margin: 0, display: "flex", alignItems: "center", gap: 4 }}>엑셀에서 표를 복사해 붙여넣으세요.
            <Info>첫 줄에 열 이름(날짜·구분·종목·수량·가격·금액·수수료·세금·통화·메모)이 있으면 그 이름으로 맞춥니다. 없으면 날짜, 구분, 종목, 수량, 가격, 금액, 수수료, 통화, 메모 순서로 읽습니다. 종목은 코드, &quot;이름 (코드)&quot;, 정확한 종목 이름 모두 됩니다. 수수료와 세금 열이 따로 있으면 더합니다. 이미 넣은 것과 똑같은 줄은 건너뛰므로 같은 표를 다시 붙여넣어도 됩니다.</Info>
            <button style={small} onClick={() => setPaste(SAMPLE)}>예시 넣기</button>
          </p>
          <textarea rows={6} style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={paste} onChange={(e) => { setPaste(e.target.value); setRows(null); }} placeholder={SAMPLE} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button style={{ width: "auto" }} disabled={!!busy || !paste.trim()} onClick={readPaste}>{busy === "parse" ? "읽는 중…" : "읽어 보기"}</button>
            {rows && <button className="primary" style={{ width: "auto" }} disabled={!!busy || !rows.some((r) => r.entry)} onClick={savePaste}>{busy === "paste" ? "저장 중…" : `${rows.filter((r) => r.entry).length}건 넣기`}</button>}
          </div>
          {rows && (
            <div className="tablewrap"><table>
              <thead><tr><th>줄</th><th>날짜</th><th>구분</th><th>종목</th><th>수량</th><th>가격·금액</th><th>수수료</th></tr></thead>
              <tbody>{rows.slice(0, 200).map((r) => r.entry ? (
                <tr key={r.line}><td>{r.line}</td><td>{r.entry.date}</td><td>{KIND_LABEL[r.entry.kind]}</td><td>{label(r.entry)}</td><td>{r.entry.qty ?? ""}</td><td>{money(r.entry.price ?? r.entry.amount, r.entry.currency === "USD")}</td><td>{money(r.entry.fee, r.entry.currency === "USD")}</td></tr>
              ) : (
                <tr key={r.line}><td>{r.line}</td><td colSpan={6} style={{ color: "var(--bad)" }}>{r.error} <span className="help">{r.text.slice(0, 60)}</span></td></tr>
              ))}</tbody>
            </table>{rows.length > 200 && <p className="help">앞 200줄만 보여 줍니다 (모두 {rows.length}줄).</p>}</div>
          )}
        </div>
      )}

      {msg && <p className="help" style={{ color: "var(--good, var(--text-2))" }}>{msg}</p>}
      {error && <p className="help" style={{ color: "var(--bad)" }}>{error}</p>}
      {!!skipped.length && (
        <details open style={{ marginTop: 4 }}><summary className="help">건너뛴 줄 {skipped.length}건</summary>
          {skipped.slice(0, 50).map((s, i) => <p key={i} className="help" style={{ margin: "2px 0 0" }}>{s.line} · {s.error}</p>)}
        </details>
      )}

      {!!list.length && (
        <div className="tablewrap" style={{ marginTop: 8 }}><table>
          <thead><tr><th>날짜</th><th>구분</th><th>종목</th><th>수량</th><th>가격·금액</th><th>메모</th><th></th></tr></thead>
          <tbody>{list.slice(0, limit).map((x) => (
            <tr key={x.id} style={form?.id === x.id ? { background: "var(--bg)" } : undefined}>
              <td>{x.date}</td>
              <td style={{ fontWeight: 600, color: x.kind === "buy" ? "var(--bad)" : x.kind === "sell" ? "var(--accent)" : undefined }}>{KIND_LABEL[x.kind]}{x.live ? <span className="help"> (예수금 반영)</span> : null}</td>
              <td>{label(x)}</td>
              <td>{x.qty ?? ""}</td>
              <td>{money(x.price ?? x.amount, x.currency === "USD")}{x.fee ? <span className="help"> +{money(x.fee, x.currency === "USD")}</span> : null}</td>
              <td>{x.note ?? ""}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {!x.live && <button style={small} disabled={!!busy} onClick={() => edit(x)}>고치기</button>}{" "}
                {delAsk !== x.id
                  ? <button style={small} disabled={!!busy} onClick={() => setDelAsk(x.id)}>지우기</button>
                  : <button style={{ ...small, background: "var(--bad)", borderColor: "var(--bad)", color: "#fff" }} disabled={!!busy} onClick={() => run("del", async () => { await post({ action: "delete", id: x.id }); setDelAsk(""); if (form?.id === x.id) setForm(null); })}>정말 지우기</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
          {list.length > limit && <button style={{ ...small, marginTop: 6 }} onClick={() => setLimit((n) => n + 50)}>더 보기 ({list.length - limit}건 남음)</button>}
        </div>
      )}
      </>}
    </div>
  );
}
