import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/settings/auth";
import { usersSummary } from "@/lib/diag/report";
import { dataGate, RATE_MAX, RATE_WINDOW_MS } from "@/lib/server/limiter";
import { secretFromEnv } from "@/lib/settings/secretbox";
import { configDir } from "@/lib/settings/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 설정 폴더의 크기와 가장 최근에 바뀐 시각 (백업 안내용, 파일 이름은 내보내지 않음) */
function configSummary(dir = configDir()) {
  let files = 0, bytes = 0, newest = 0;
  const walk = (p: string, depth: number) => {
    if (depth > 4) return;
    for (const x of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, x.name);
      if (x.isDirectory()) walk(q, depth + 1);
      else if (x.isFile()) { const st = fs.statSync(q); files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs); }
    }
  };
  try { walk(dir, 0); } catch { /* 없음 */ }
  return { files, bytes, newest: newest ? new Date(newest).toISOString() : null };
}

/** 관리자 화면의 "서버 상태·백업" 칸: 사람 수, 지금 돌고 있는 요청, 백업할 폴더 */
export async function GET(req: Request) {
  const { denied } = requireAdminUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  return NextResponse.json({
    users: usersSummary(),
    load: dataGate.stats(),
    rate: { max: RATE_MAX, minutes: RATE_WINDOW_MS / 60000 },
    config: configSummary(),
    secretFromEnv: secretFromEnv(),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  }, { headers: { "Cache-Control": "no-store" } });
}
