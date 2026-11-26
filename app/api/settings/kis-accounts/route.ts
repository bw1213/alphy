import { NextResponse } from "next/server";
import { clientIp, requireUser } from "@/lib/settings/auth";
import { loadSettings, updateSettings } from "@/lib/settings/store";
import { OWNER_ID } from "@/lib/settings/userdir";
import { recordLogin } from "@/lib/settings/loginlog";
import { stepUpError } from "@/lib/settings/stepup";
import { loadUserKis, saveUserKis } from "@/lib/kis/userkeys";
import { applyKisAccountOp, type KisAccountOp } from "@/lib/kis/kisAccounts";
import { loadPlan, savePlan } from "@/lib/auto/store";
import { kisAccountsView } from "@/lib/settings/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 한국투자증권 계좌 더 붙이기. { action: "add" | "edit" | "delete", id?, name, env, appKey, appSecret, account, otp? }
 * 실전 계좌를 새로 넣거나 실전으로 바꿀 때는 2단계 인증 코드가 필요
 */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: KisAccountOp & { otp?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  if (!["add", "edit", "delete"].includes(String(body?.action))) return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
  const owner = user.id === OWNER_ID;
  const kis = owner ? loadSettings().kis : loadUserKis(user.id);
  let r;
  try { r = applyKisAccountOp(kis.accounts ?? [], body, kis, (id) => !!loadPlan(user.id, process.env, id)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  if (r.toReal) {
    const err = stepUpError(req, user.id, body.otp);
    if (err) return NextResponse.json({ error: err, needOtp: true }, { status: 400 });
  }
  try {
    if (owner) updateSettings((s) => { s.kis.accounts = r.list; });
    else saveUserKis(user.id, { ...loadUserKis(user.id), accounts: r.list });
  } catch (e) {
    return NextResponse.json({ error: `설정 파일을 저장하지 못했습니다 (${(e as Error).message}).` }, { status: 500 });
  }
  // 계좌·환경이 바뀌면 실전 전환 확인을 다시 받음
  const before = (kis.accounts ?? []).find((a) => a.id === r.id), after = r.list.find((a) => a.id === r.id);
  const plan = before && after ? loadPlan(user.id, process.env, r.id) : null;
  if (plan?.realConfirmedAt && (before!.env !== after!.env || before!.account !== after!.account || before!.appKey !== after!.appKey)) {
    savePlan({ ...plan, realConfirmedAt: undefined }, user.id, process.env, r.id);
  }
  console.log(`[settings] ${user.id} 한국투자증권 계좌 ${body.action} ${r.id}`);
  if (r.toReal) recordLogin(req, clientIp(req), "real-env", process.env, Date.now(), user.id);
  return NextResponse.json({ ok: true, id: r.id, accounts: kisAccountsView(r.list) });
}
