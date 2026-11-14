import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/settings/auth";
import { clearLastState, loadLastState, saveLastState } from "@/lib/strategies/lastState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 백테스트 화면의 마지막 설정 (없으면 null) */
export async function GET() {
  return NextResponse.json(loadLastState(), { headers: { "Cache-Control": "no-store" } });
}

/** 마지막 설정 저장. 전략 코드가 들어 있어 다시 열면 브라우저에서 실행될 수 있으므로 관리자만 */
export async function PUT(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const text = await req.text().catch(() => "");
  if (text.length > 200_000) return NextResponse.json({ error: "너무 큽니다" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try { return NextResponse.json(saveLastState(body)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

/** 마지막 설정 지우기 (처음 설정으로 되돌리기) */
export async function DELETE(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  clearLastState();
  return NextResponse.json({ ok: true });
}
