import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/settings/auth";
import { loadSettings, saveSettings } from "@/lib/settings/store";
import { applyPatch, settingsView, type SettingsPatch } from "@/lib/settings/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 설정 보기 (비밀값은 "설정됨" 여부와 끝 4자리만) */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return NextResponse.json(settingsView(loadSettings()));
}

/** 설정 바꾸기. 보낸 항목만 바뀜, "" 는 지우기 */
export async function PUT(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let patch: SettingsPatch;
  try { patch = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  let next;
  try { next = applyPatch(loadSettings(), patch); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try { saveSettings(next); }
  catch (e) {
    return NextResponse.json({ error: `설정 파일을 저장하지 못했습니다 (${(e as Error).message}). NAS 의 nas/cache 폴더 쓰기 권한을 확인하세요.` }, { status: 500 });
  }
  if (patch.kis?.tradeEnv) console.log(`[settings] 주문 대상 → ${patch.kis.tradeEnv}`);
  return NextResponse.json(settingsView(next));
}
