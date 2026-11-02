import { NextResponse } from "next/server";
import { loadSettings } from "@/lib/settings/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 백테스트 화면 기본값 (비밀값 없음, 로그인 불필요) */
export async function GET() {
  return NextResponse.json(loadSettings().backtest);
}
