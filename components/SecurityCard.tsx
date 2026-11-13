"use client";

import { useCallback, useEffect, useState } from "react";

interface LogRow { t: number; ip: string; event: string; ua?: string }
interface SecState { totpEnabled: boolean; log: LogRow[]; you: string }

const EVENT: Record<string, string> = {
  login: "로그인", fail: "비밀번호 틀림", "otp-fail": "인증 코드 틀림", setup: "처음 비밀번호 만듦", change: "비밀번호 바꿈",
  locked: "잠긴 상태에서 시도", "logout-all": "모든 기기 로그아웃", "2fa-on": "2단계 인증 켬", "2fa-off": "2단계 인증 끔",
};
const BAD = new Set(["fail", "otp-fail", "locked"]);

const device = (ua?: string) => {
  if (!ua) return "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "삼성 인터넷" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "";
  return [os, br].filter(Boolean).join(" · ") || ua.slice(0, 40);
};

const post = async (body: unknown) => {
  const r = await fetch("/api/security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};

/** 설정 화면의 "보안" 칸: 2단계 인증, 모든 기기 로그아웃, 최근 로그인 기록 */
export default function SecurityCard() {
  const [st, setSt] = useState<SecState | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/security", { cache: "no-store" });
    if (r.ok) setSt(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    load();
  };

  if (!st) return <div className="card"><h2>보안</h2><p className="help">불러오는 중…</p></div>;

  return (
    <div className="card wide">
      <h2>보안 · 밖에서 접속</h2>
      {msg && (msg.ok ? <span className="saved">✓ {msg.text}</span> : <div className="error">{msg.text}</div>)}

      <h3 style={{ marginTop: 10 }}>2단계 인증 {st.totpEnabled ? <span className="badge ok">켜짐</span> : <span className="badge no">꺼짐</span>}</h3>
      <p className="help">
        켜 두면 로그인할 때 비밀번호와 함께 휴대폰 인증 앱(Google Authenticator, Microsoft Authenticator 등)의 6자리 숫자가 필요합니다.
        인터넷에서 접속할 수 있게 열어 둘 거라면 <b>꼭 켜 두세요.</b> 비밀번호가 새도 휴대폰이 없으면 들어올 수 없습니다.
      </p>
      {!st.totpEnabled && !setup && (
        <button onClick={() => run(async () => { const j = await post({ action: "totp-begin" }); setSetup({ secret: j.secret, qr: j.qr }); setCode(""); return "인증 앱으로 QR 코드를 찍으세요"; })}>QR 코드 만들기</button>
      )}
      {!st.totpEnabled && setup && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginTop: 8 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="2단계 인증 QR 코드" width={180} height={180} style={{ background: "#fff", borderRadius: 6 }} />
          <div style={{ flex: "1 1 240px" }}>
            <p className="help">1. 휴대폰 인증 앱에서 + → QR 코드 스캔<br />
              (찍을 수 없으면 키 직접 입력: <code style={{ wordBreak: "break-all" }}>{setup.secret}</code>)<br />
              2. 앱에 뜬 6자리 숫자를 아래에 넣고 켜기</p>
            <label className="f">인증 앱 코드<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} /></label>
            <div className="btns" style={{ marginTop: 8 }}>
              <button className="primary" onClick={() => run(async () => { await post({ action: "totp-enable", code }); setSetup(null); setCode(""); return "2단계 인증을 켰습니다. 다음 로그인부터 코드가 필요합니다"; })}>켜기</button>
              <button onClick={() => { setSetup(null); setCode(""); }}>취소</button>
            </div>
          </div>
        </div>
      )}
      {st.totpEnabled && (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="f">끄려면 지금 코드 입력<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={7} /></label>
          <button onClick={() => run(async () => { await post({ action: "totp-disable", code }); setCode(""); return "2단계 인증을 껐습니다"; })}>2단계 인증 끄기</button>
        </div>
      )}
      <p className="help">
        휴대폰을 잃어버렸으면: File Station에서 <code>nas/cache/config</code> 폴더에 <code>disable-2fa.txt</code> 라는 빈 파일을 올리세요.
        다음 접속 때 2단계 인증이 꺼집니다(NAS 파일에 손댈 수 있는 사람만 가능).
      </p>

      <h3 style={{ marginTop: 16 }}>다른 기기 로그아웃</h3>
      <p className="help">다른 곳(PC방, 남의 휴대폰 등)에서 로그인한 채로 두었거나, 모르는 로그인이 보이면 누르세요. 이 기기만 로그인이 유지됩니다.</p>
      <button onClick={() => run(async () => { await post({ action: "logout-all" }); return "다른 기기의 로그인을 모두 끊었습니다"; })}>모든 기기 로그아웃</button>

      <h3 style={{ marginTop: 16 }}>최근 로그인 기록</h3>
      <p className="help">지금 이 기기의 주소: <code>{st.you}</code>. 모르는 주소에서 &apos;로그인&apos;이 있으면 비밀번호를 바꾸고 모든 기기 로그아웃을 누르세요.</p>
      {st.log.length === 0 ? <p className="help">기록이 없습니다.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>시각</th><th>내용</th><th>주소</th><th>기기</th></tr></thead>
            <tbody>
              {st.log.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(r.t).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</td>
                  <td>{BAD.has(r.event) ? <span className="badge no">{EVENT[r.event] ?? r.event}</span> : EVENT[r.event] ?? r.event}</td>
                  <td><code>{r.ip}</code></td>
                  <td>{device(r.ua)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
