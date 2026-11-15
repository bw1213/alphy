import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { kisStatus } from "@/lib/kis/config";
import { kisEnvFor, realLock } from "@/lib/kis/userkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 내 한국투자증권 설정 여부만 반환 (키 값은 포함하지 않음) */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  try {
    return NextResponse.json({ ...kisStatus(kisEnvFor(user)), realLock: realLock(user) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
