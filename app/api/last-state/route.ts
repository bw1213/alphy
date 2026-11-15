import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { clearLastState, loadLastState, saveLastState } from "@/lib/strategies/lastState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 백테스트 화면의 마지막 설정 (없으면 null) */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return NextResponse.json(loadLastState(process.env, user.id), { headers: { "Cache-Control": "no-store" } });
}

/** 마지막 설정 저장. 사람마다 따로 저장 */
export async function PUT(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const text = await req.text().catch(() => "");
  if (text.length > 200_000) return NextResponse.json({ error: "너무 큽니다" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try { return NextResponse.json(saveLastState(body, process.env, new Date(), user.id)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

/** 마지막 설정 지우기 (처음 설정으로 되돌리기) */
export async function DELETE(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  clearLastState(process.env, user.id);
  return NextResponse.json({ ok: true });
}
