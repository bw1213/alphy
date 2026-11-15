import { NextResponse } from "next/server";
import { clientIp, logoutAll, requireAdminUser, issueSession, cookieHeader } from "@/lib/settings/auth";
import { recordLogin, type LoginEvent } from "@/lib/settings/loginlog";
import { createInvite, deleteUser, INVITE_DAYS, listInvites, listUsers, resetTotp, revokeInvite, setDisabled, userView } from "@/lib/settings/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 사용자·초대 목록 (관리자만, 비밀값 없음) */
export async function GET(req: Request) {
  const { user, denied } = requireAdminUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return NextResponse.json({ me: user.id, users: listUsers().map(userView), invites: listInvites(), inviteDays: INVITE_DAYS }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * 관리자만:
 * { action: "invite", name, role? }   초대 코드 만들기 (원문은 이 응답에만, 3일 유효, 1회용)
 * { action: "invite-revoke", id }     초대 취소
 * { action: "disable" | "enable", id } 계정 정지·해제 (정지하면 바로 로그아웃됨)
 * { action: "delete", id }            계정 삭제 (저장한 전략 파일은 NAS 에 남음)
 * { action: "reset-2fa", id }         그 사람의 2단계 인증 끄기 (휴대폰 분실)
 * { action: "logout-everyone" }       모든 사람 모든 기기 로그아웃 (이 기기만 유지)
 */
export async function POST(req: Request) {
  const { user, denied } = requireAdminUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let b: Record<string, string>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const ip = clientIp(req);
  const log = (event: LoginEvent, target?: string) => recordLogin(req, ip, event, process.env, Date.now(), target ? `${user.id}→${target}` : user.id);
  const id = String(b.id ?? "");
  try {
    if (b.action === "invite") {
      // 관리자 초대는 owner 만 (관리자가 관리자를 늘리지 못하게)
      const role = b.role === "admin" ? "admin" : "member";
      if (role === "admin" && user.id !== "owner") return NextResponse.json({ error: "관리자 초대는 owner 계정만 할 수 있습니다." }, { status: 403 });
      const { code, view } = createInvite(String(b.name ?? ""), role, user.id);
      log("invite-create");
      return NextResponse.json({ code, view });
    }
    if (b.action === "invite-revoke") { revokeInvite(id); log("invite-revoke"); }
    else if (b.action === "disable") { setDisabled(id, true, user.id); log("user-disable", id); }
    else if (b.action === "enable") { setDisabled(id, false, user.id); log("user-enable", id); }
    else if (b.action === "delete") { deleteUser(id, user.id); log("user-delete", id); }
    else if (b.action === "reset-2fa") {
      if (id === "owner" && user.id !== "owner") return NextResponse.json({ error: "owner 계정의 2단계 인증은 본인만 끌 수 있습니다." }, { status: 403 });
      resetTotp(id); log("user-2fa-reset", id);
    } else if (b.action === "logout-everyone") {
      logoutAll(); log("logout-everyone");
      const s = issueSession(process.env, Date.now(), user.id);
      const res = NextResponse.json({ ok: true });
      res.headers.set("set-cookie", cookieHeader(req, s.value, s.maxAge));
      return res;
    } else return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    return NextResponse.json({ users: listUsers().map(userView), invites: listInvites() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
