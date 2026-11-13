import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 컨테이너 상태 확인용 (로그인 불필요, 정보 없음) */
export function GET() {
  return NextResponse.json({ ok: true });
}
