import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { deleteStrategy, loadStrategies, upsertStrategy } from "@/lib/strategies/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 내 전략 목록 (로그인한 사람 것만) */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return NextResponse.json(loadStrategies(process.env, user.id));
}

/** 전략 저장 (같은 이름이면 덮어씀). 사람마다 따로 저장되고, 저장된 코드는 본인 브라우저에서만 실행됨 */
export async function PUT(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try { return NextResponse.json(upsertStrategy(body, process.env, new Date(), user.id)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

/** ?name=전략이름 */
export async function DELETE(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!name) return NextResponse.json({ error: "전략 이름이 없습니다" }, { status: 400 });
  try { return NextResponse.json(deleteStrategy(name, process.env, user.id)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}
