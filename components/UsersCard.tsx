"use client";

import { useCallback, useEffect, useState } from "react";

interface UserRow { id: string; name: string; role: "admin" | "member"; totpEnabled: boolean; disabled: boolean; createdAt: number; owner: boolean }
interface InviteRow { id: string; name: string; role: "admin" | "member"; expiresAt: number; createdBy: string }
interface State { me: string; users: UserRow[]; invites: InviteRow[]; inviteDays: number }

const when = (t: number) => new Date(t).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });

/** 설정 화면의 "사용자" 칸 (관리자만): 초대 링크, 정지·삭제, 2단계 인증 초기화 */
export default function UsersCard() {
  const [st, setSt] = useState<State | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/users", { cache: "no-store" });
    if (r.ok) setSt(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (body: unknown, done: string) => {
    setMsg(null);
    try {
      const r = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMsg({ ok: true, text: done });
      load();
      return j;
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); return null; }
  };

  const invite = async () => {
    const j = await post({ action: "invite", name, role }, "초대 링크를 만들었습니다. 아래 링크를 그 사람에게만 보내세요");
    if (j?.code) { setLink(`${window.location.origin}/join?code=${j.code}`); setCopied(false); setName(""); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* 직접 복사 */ } };

  if (!st) return null;
  const isOwner = st.me === "owner";

  return (
    <div className="card wide">
      <h2>사용자 (가족·지인 초대)</h2>
      {msg && (msg.ok ? <span className="saved">✓ {msg.text}</span> : <div className="error">{msg.text}</div>)}
      <p className="help">
        초대 링크를 받은 사람만 가입할 수 있습니다. 가입한 사람은 백테스트와 본인 전략 보관함·마지막 설정을 따로 씁니다.
        <b> 한국투자증권 계좌·주문과 서버 설정은 아직 owner 계정만</b> 쓸 수 있습니다(사람마다 본인 계좌를 넣는 기능은 다음 단계).
      </p>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>아이디</th><th>이름</th><th>역할</th><th>2단계 인증</th><th>가입</th><th></th></tr></thead>
          <tbody>
            {st.users.map((u) => (
              <tr key={u.id}>
                <td><code>{u.id}</code>{u.id === st.me && " (나)"}</td>
                <td>{u.name}</td>
                <td>{u.owner ? "owner" : u.role === "admin" ? "관리자" : "일반"}{u.disabled && <> <span className="badge no">정지</span></>}</td>
                <td>{u.totpEnabled ? <span className="badge ok">켜짐</span> : <span className="badge no">꺼짐</span>}</td>
                <td style={{ whiteSpace: "nowrap" }}>{when(u.createdAt)}</td>
                <td>
                  {!u.owner && u.id !== st.me && (
                    <span className="btns">
                      <button onClick={() => post({ action: u.disabled ? "enable" : "disable", id: u.id }, u.disabled ? "정지를 풀었습니다" : "정지했습니다. 그 사람은 바로 로그아웃됩니다")}>{u.disabled ? "정지 해제" : "정지"}</button>
                      {u.totpEnabled && <button onClick={() => window.confirm(`${u.name}(${u.id})의 2단계 인증을 끌까요? 휴대폰을 잃어버렸을 때만 쓰세요.`) && post({ action: "reset-2fa", id: u.id }, "2단계 인증을 껐습니다")}>2단계 인증 초기화</button>}
                      <button onClick={() => window.confirm(`${u.name}(${u.id}) 계정을 지울까요? 되돌릴 수 없습니다.`) && post({ action: "delete", id: u.id }, "계정을 지웠습니다")}>삭제</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 16 }}>초대하기</h3>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="f">받는 사람 이름(메모)<input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="예: 엄마" /></label>
        {isOwner && (
          <label className="f">역할
            <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
              <option value="member">일반</option><option value="admin">관리자 (사용자 초대·정지 가능)</option>
            </select>
          </label>
        )}
        <button onClick={invite}>초대 링크 만들기</button>
      </div>
      {link && (
        <div style={{ marginTop: 10 }}>
          <p className="help">이 링크는 지금 한 번만 보입니다. 한 번 쓰면 사라지고 {st.inviteDays}일 뒤 만료됩니다.</p>
          <code style={{ wordBreak: "break-all", display: "block", padding: 8 }}>{link}</code>
          <button style={{ marginTop: 6 }} onClick={copy}>{copied ? "복사됨" : "링크 복사"}</button>
        </div>
      )}
      {st.invites.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>아직 안 쓴 초대</th><th>역할</th><th>만료</th><th></th></tr></thead>
          <tbody>
            {st.invites.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td><td>{i.role === "admin" ? "관리자" : "일반"}</td><td style={{ whiteSpace: "nowrap" }}>{when(i.expiresAt)}</td>
                <td><button onClick={() => post({ action: "invite-revoke", id: i.id }, "초대를 취소했습니다")}>취소</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 16 }}>모두 로그아웃</h3>
      <p className="help">비밀번호가 샜다고 의심될 때: 모든 사람의 모든 기기 로그인을 끊습니다(이 기기만 유지). 점검 키도 폐기됩니다.</p>
      <button onClick={() => window.confirm("모든 사람을 로그아웃시킬까요?") && post({ action: "logout-everyone" }, "모든 로그인을 끊었습니다")}>모든 사람 로그아웃</button>
    </div>
  );
}
