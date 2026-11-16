import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { OWNER_ID } from "@/lib/settings/userdir";
import { updateSettings } from "@/lib/settings/store";
import { loadStrategies } from "@/lib/strategies/library";
import { cleanPlan, loadLog, loadPlan, planKind, savePlan } from "@/lib/auto/store";
import { eveningFor, eveningTime, loadState } from "@/lib/auto/scheduler";
import { cleanHm, kst } from "@/lib/auto/time";
import { autoLimitFor, kisEnvFor } from "@/lib/kis/userkeys";
import { tradeEnv } from "@/lib/kis/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 내 운용 전략·최근 계산 기록·예약 시각 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const plan = loadPlan(user.id);
  return NextResponse.json({
    plan: plan ? { ...plan, kind: planKind(plan), strategy: undefined, strategyName: plan.strategy?.name ?? null, builtin: plan.builtin ?? null } : null,
    log: loadLog(user.id).slice(0, 30),
    eveningTime: eveningTime(),
    lastEvening: loadState().evening ?? null,
    limit: autoLimitFor(user.id),
    account: tradeEnv(kisEnvFor(user)),
    owner: user.id === OWNER_ID,
    today: kst().date,
  }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * { action: "save", strategy: "saved:이름" | "builtin:id", tickers, budget, startDate, enabled }
 * { action: "delete" }
 * { action: "run", notify?: boolean }   지금 저녁 계산 해 보기
 * { action: "time", eveningTime: "18:00" } (owner)
 */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try {
    switch (body?.action) {
      case "save": {
        const real = tradeEnv(kisEnvFor(user)) === "real" ? { cap: autoLimitFor(user.id).realBudget } : undefined;
        const plan = cleanPlan(body, user.id, kst().date, loadStrategies(process.env, user.id), real);
        savePlan(plan, user.id);
        return NextResponse.json({ ok: true });
      }
      case "delete":
        savePlan(null, user.id);
        return NextResponse.json({ ok: true });
      case "run": {
        const r = await eveningFor(user, "manual", { notify: body.notify === true });
        if (!r) return NextResponse.json({ error: "먼저 운용 전략을 저장하세요." }, { status: 400 });
        return NextResponse.json(r);
      }
      case "time": {
        if (user.id !== OWNER_ID) return NextResponse.json({ error: "계산 시각은 관리자만 바꿀 수 있습니다." }, { status: 403 });
        const t = cleanHm(body.eveningTime);
        if (!t || t < "16:00") return NextResponse.json({ error: "16:00~23:59 사이로 넣으세요 (장 마감 뒤 시세가 확정된 다음)." }, { status: 400 });
        updateSettings((s) => { s.auto.eveningTime = t; });
        return NextResponse.json({ ok: true, eveningTime: t });
      }
      default:
        return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
