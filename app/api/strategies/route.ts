import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/settings/auth";
import { deleteStrategy, loadStrategies, upsertStrategy } from "@/lib/strategies/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 내 전략 목록 (비밀값 없음, 로그인 불필요) */
export async function GET() {
  return NextResponse.json(loadStrategies());
}

/** 전략 저장 (같은 이름이면 덮어씀). 저장된 코드는 접속한 브라우저에서 실행되므로 관리자만 */
export async function PUT(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try { return NextResponse.json(upsertStrategy(body)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

/** ?name=전략이름 */
export async function DELETE(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!name) return NextResponse.json({ error: "전략 이름이 없습니다" }, { status: 400 });
  try { return NextResponse.json(deleteStrategy(name)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}
