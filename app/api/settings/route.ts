import { NextResponse } from "next/server";
import { clientIp, requireUser } from "@/lib/settings/auth";
import { loadSettings, saveSettings, serverRealLock } from "@/lib/settings/store";
import { secretFromEnv } from "@/lib/settings/secretbox";
import { OWNER_ID } from "@/lib/settings/userdir";
import type { User } from "@/lib/settings/users";
import { recordLogin } from "@/lib/settings/loginlog";
import { stepUpError } from "@/lib/settings/stepup";
import { applyPatch, settingsView, type SettingsPatch } from "@/lib/settings/view";
import { memberSettings, realLock, saveUserKis } from "@/lib/kis/userkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 설정 보기 (비밀값은 "설정됨" 여부와 끝 4자리만).
 * owner: 서버 설정 전체. 그 밖의 사람: 본인의 한국투자증권 설정만(백테스트 기본값은 보기만)
 */
function viewFor(u: User) {
  const owner = u.id === OWNER_ID;
  const lock = realLock(u);
  const v = owner ? settingsView(loadSettings()) : { ...settingsView(memberSettings(u.id), {}), passwordFromEnv: false, path: "" };
  const server = owner ? serverRealLock() : undefined;
  return { ...v, realOrdersAllowed: lock.open, scope: owner ? "owner" as const : "member" as const, realLock: lock, serverLock: server && { env: server.env, screen: server.screen, at: server.at, ownerTotp: server.ownerTotp }, secretFromEnv: secretFromEnv() };
}

export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  try { return NextResponse.json(viewFor(user)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}

/** 설정 바꾸기. 보낸 항목만 바뀜, "" 는 지우기. owner 가 아니면 kis 항목만. 주문 대상을 실전으로 바꿀 때는 otp 필요 */
export async function PUT(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let patch: SettingsPatch & { otp?: string };
  try { patch = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const owner = user.id === OWNER_ID;
  if (!owner && patch.backtest) return NextResponse.json({ error: "백테스트 기본값은 관리자(owner)만 바꿀 수 있습니다." }, { status: 403 });
  let next;
  const before = owner ? loadSettings() : memberSettings(user.id);
  try { next = applyPatch(before, owner ? { kis: patch.kis, backtest: patch.backtest } : { kis: patch.kis }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const toReal = next.kis.tradeEnv === "real" && before.kis.tradeEnv !== "real";
  if (toReal) {
    const err = stepUpError(req, user.id, patch.otp);
    if (err) return NextResponse.json({ error: err, needOtp: true }, { status: 400 });
  }
  try { if (owner) saveSettings(next); else saveUserKis(user.id, next.kis); }
  catch (e) {
    return NextResponse.json({ error: `설정 파일을 저장하지 못했습니다 (${(e as Error).message}). NAS 의 nas/cache 폴더 쓰기 권한을 확인하세요.` }, { status: 500 });
  }
  if (patch.kis?.tradeEnv) console.log(`[settings] ${user.id} 주문 대상 → ${patch.kis.tradeEnv}`);
  if (toReal) recordLogin(req, clientIp(req), "real-env", process.env, Date.now(), user.id);
  return NextResponse.json(viewFor(user));
}
