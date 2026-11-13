"use client";

import { useCallback, useEffect, useState } from "react";

interface TokenRow { id: string; name: string; createdAt: number; expiresAt: number; lastUsedAt?: number; lastIp?: string }

const when = (t?: number) => (t ? new Date(t).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-");

const post = async (body: unknown) => {
  const r = await fetch("/api/security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};

/** 설정 화면의 "점검 키" 칸: Claude 같은 도우미가 서버 상태를 읽기 전용으로 볼 수 있게 하는 키 */
export default function DiagTokenCard() {
  const [rows, setRows] = useState<TokenRow[] | null>(null);
  const [name, setName] = useState("Claude 점검");
  const [days, setDays] = useState(7);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/security", { cache: "no-store" });
    if (r.ok) setRows((await r.json()).diagTokens ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    load();
  };

  const copy = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* 직접 선택해서 복사 */ }
  };

  return (
    <div className="card wide">
      <h2>점검 키 (읽기 전용)</h2>
      {msg && (msg.ok ? <span className="saved">✓ {msg.text}</span> : <div className="error">{msg.text}</div>)}
      <p className="help">
        Claude 에게 서버를 직접 점검하게 할 때 발급해서 넘겨 주는 키입니다. 비밀번호나 인증 코드를 알려 줄 필요가 없습니다.
        이 키로는 <b>점검 화면(/api/diag)만</b> 볼 수 있습니다: 버전·배포 시각, 설정이 되어 있는지 여부(값은 안 보임), 저장한 전략, 시세 데이터 범위, 백테스트 다시 돌려 보기.
        <b> 주문·잔고·설정 변경·전략 저장은 할 수 없고</b>, 앱키·계좌번호 같은 비밀값도 보이지 않습니다.
      </p>
      <p className="help">
        키는 발급할 때 <b>한 번만</b> 보입니다. 점검이 끝나면 아래 목록에서 폐기하세요. 기간이 지나면 저절로 막히고,
        비밀번호를 바꾸거나 &apos;모든 기기 로그아웃&apos;을 눌러도 모두 폐기됩니다.
      </p>

      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="f">이름 (어디에 줬는지)<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
        <label className="f">유효 기간
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>1일</option>
            <option value={7}>7일</option>
            <option value={30}>30일</option>
          </select>
        </label>
        <button className="primary" onClick={() => run(async () => { const j = await post({ action: "diag-create", name, days }); setFresh(j.token); return "점검 키를 만들었습니다. 지금 복사하세요"; })}>점검 키 만들기</button>
      </div>

      {fresh && (
        <div className="lock" style={{ marginTop: 10 }}>
          <p className="help" style={{ marginTop: 0 }}>이 키를 복사해서 Claude 스레드에 붙여 넣으세요. 이 화면을 벗어나면 다시 볼 수 없습니다.</p>
          <code style={{ wordBreak: "break-all", display: "block", userSelect: "all" }}>{fresh}</code>
          <div className="btns" style={{ marginTop: 8 }}>
            <button onClick={copy}>{copied ? "복사됨" : "복사"}</button>
            <button onClick={() => setFresh(null)}>닫기</button>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>발급한 키</h3>
      {!rows ? <p className="help">불러오는 중…</p> : rows.length === 0 ? <p className="help">없습니다.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>이름</th><th>만든 시각</th><th>만료</th><th>마지막 사용</th><th></th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{when(t.createdAt)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{when(t.expiresAt)}</td>
                  <td>{t.lastUsedAt ? <>{when(t.lastUsedAt)} <code>{t.lastIp}</code></> : "아직 안 씀"}</td>
                  <td><button onClick={() => run(async () => { await post({ action: "diag-revoke", id: t.id }); return `'${t.name}' 키를 폐기했습니다`; })}>폐기</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
