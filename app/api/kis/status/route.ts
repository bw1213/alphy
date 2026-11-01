import { NextResponse } from "next/server";
import { kisStatus } from "@/lib/kis/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 설정 여부만 반환 (키 값은 포함하지 않음) */
export async function GET() {
  return NextResponse.json(kisStatus());
}
