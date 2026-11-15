"use client";

import { useCallback, useEffect, useState } from "react";
import { StockSearch } from "./StockSearch";

interface Entry { code: string; name: string; market: string; type?: string }
interface Status { count: number; downloaded: number; updated: string | null; custom: Entry[]; error: string | null; errorAt: string | null }

const when = (t: string | null) => (t ? new Date(t).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-");

/** 설정 화면의 "종목 목록" 칸: 이름 검색에 쓰는 종목코드·이름 목록 상태, 새로 받기, 직접 추가 */
export default function StockListCard() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState({ code: "", name: "", market: "KOSPI" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tried, setTried] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/stocks", { cache: "no-store" });
    if (r.ok) setSt(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (body: unknown, ok: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/stocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSt(j);
      setMsg(j.error && (body as any).action === "refresh" ? { ok: false, text: `일부를 받지 못했습니다: ${j.error}` } : { ok: true, text: ok });
      return true;
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); return false; } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <h2>종목 목록 (이름 검색)</h2>
      <p className="help" style={{ marginTop: -6, marginBottom: 10 }}>
        백테스트·매매 화면에서 종목 이름으로 코드를 찾을 때 쓰는 목록입니다. 한국투자증권이 공개하는 종목 마스터 파일(KOSPI·KOSDAQ 주식, ETF, ETN, 리츠)을 받아 저장해 두고, 7일마다 저절로 새로 받습니다.
      </p>
      {st ? (
        <>
          <p className="help">검색 가능한 종목 {st.count.toLocaleString("ko-KR")}개 · 마지막으로 받은 때 {when(st.updated)}{!st.downloaded && " (아직 받지 않아 기본 목록만 있습니다)"}</p>
          {st.error && <p className="help" style={{ color: "var(--bad)" }}>마지막 받기 실패({when(st.errorAt)}): {st.error}</p>}
        </>
      ) : <p className="help">읽는 중…</p>}
      <button style={{ marginTop: 8 }} disabled={busy} onClick={() => post({ action: "refresh" }, "종목 목록을 새로 받았습니다")}>{busy ? "받는 중…" : "지금 새로 받기"}</button>

      <h3>찾아보기</h3>
      <StockSearch onPick={setTried} placeholder="이름·코드·초성으로 찾아보기" />
      {tried && <p className="help">{tried.name} · {tried.code} · {tried.market}{tried.type ? ` · ${tried.type}` : ""}</p>}

      <h3>직접 추가</h3>
      <p className="help" style={{ marginTop: -4, marginBottom: 6 }}>목록에 없는 종목(새로 상장된 종목, 상장폐지 종목 등)을 넣어 두면 검색에 나옵니다. 같은 코드가 있으면 여기 넣은 이름이 먼저 쓰입니다.</p>
      <div className="row3">
        <label className="f">종목코드<input value={add.code} placeholder="005930" onChange={(e) => setAdd({ ...add, code: e.target.value.trim().toUpperCase() })} /></label>
        <label className="f">이름<input value={add.name} placeholder="삼성전자" onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
        <label className="f">시장
          <select value={add.market} onChange={(e) => setAdd({ ...add, market: e.target.value })}>
            <option>KOSPI</option><option>KOSDAQ</option><option>NASDAQ</option><option>NYSE</option><option>AMEX</option>
          </select>
        </label>
      </div>
      <button style={{ marginTop: 8 }} disabled={busy || !add.code || !add.name.trim()} onClick={async () => {
        if (await post({ action: "add", ...add }, `${add.name.trim()}(${add.code})을 추가했습니다`)) setAdd({ code: "", name: "", market: add.market });
      }}>추가</button>
      {!!st?.custom.length && (
        <table className="tbl" style={{ marginTop: 10 }}>
          <tbody>
            {st.custom.map((c) => (
              <tr key={`${c.market}:${c.code}`}>
                <td>{c.name}</td><td>{c.code}</td><td>{c.market}</td>
                <td style={{ textAlign: "right" }}><button disabled={busy} onClick={() => post({ action: "remove", code: c.code, market: c.market }, `${c.name}을 뺐습니다`)}>빼기</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && (msg.ok ? <span className="saved" style={{ display: "block", marginTop: 8 }}>✓ {msg.text}</span> : <div className="error" style={{ marginTop: 8 }}>{msg.text}</div>)}
    </div>
  );
}
