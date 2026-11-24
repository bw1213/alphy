import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { kst } from "@/lib/auto/time";
import { loadLog, loadPlan } from "@/lib/auto/store";
import { planMarket } from "@/lib/auto/session";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";
import { loadAccounts, loadManualLog, loadTrades } from "@/lib/manual/store";
import { KIS_ID, deleteFlow, putFlow, loadHistory, refreshHistory } from "@/lib/manual/value";
import { hasKisAccount, kisReader } from "@/lib/manual/kis";
import { allFills } from "@/lib/accounts/fills";
import { mergedHistory } from "@/lib/accounts/ledgerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 새로 고침은 증권사 잔고·시세를 받느라 오래 걸릴 수 있어 작업으로 (프록시 60초 제한) */
const refreshJobs = namedJobs<{ warnings: string[] }>("dashboard-refresh");

/** 전체 계좌 대시보드: 한국투자증권(자동 매매) 계좌 + 수동 계좌. ?job=<id> 는 새로 고침 결과 물어보기 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const job = new URL(req.url).searchParams.get("job");
  if (job) return pollJob(refreshJobs, user.id, job);
  const h = loadHistory(user.id);
  const logs = loadManualLog(user.id);
  const plan = loadPlan(user.id);
  const autoLast = plan ? loadLog(user.id).find((r) => r.status === "ok") ?? null : null;
  const pick = (r: { runDate: string; orders: unknown[]; equity?: number; label: string } | null | undefined) => r ? { runDate: r.runDate, orders: r.orders, equity: r.equity ?? null, label: r.label } : null;
  return NextResponse.json({
    today: kst().date,
    prices: h.prices,
    ...(() => { const m = mergedHistory(user.id, h); return { points: m.points, retFlows: m.flows }; })(),
    flows: h.flows ?? {},
    kis: hasKisAccount(user) ? { view: h.kis ?? null, plan: plan ? { label: plan.label, budget: plan.budget, enabled: plan.enabled, market: planMarket(plan) } : null, last: pick(autoLast) } : null,
    kisId: KIS_ID,
    manual: loadAccounts(user.id).map((a) => ({
      id: a.id, name: a.name, broker: a.broker, cash: a.cash, positions: a.positions,
      plan: a.plan ? { label: a.plan.label, budget: a.plan.budget, enabled: a.plan.enabled } : null,
      last: pick((logs[a.id] ?? []).find((r) => r.status === "ok")),
    })),
    trades: loadTrades(user.id).slice(0, 30),
    fills: allFills(user.id),
  }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * { action: "refresh" } 시세·한국투자증권 잔고를 새로 받아 오늘 점 기록
 * { action: "flow", accountId, date, amount, note?, id? } 입금(+)·출금(−) 기록 (id 는 고치기). 수동 계좌는 예수금에도 반영
 * { action: "deleteFlow", id }
 */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  if (body?.action === "flow" || body?.action === "deleteFlow") {
    try {
      if (body.action === "deleteFlow") return NextResponse.json({ ok: true, account: deleteFlow(user.id, String(body.id ?? "")) });
      const id = String(body.accountId ?? "");
      const ok = id === KIS_ID ? hasKisAccount(user) : loadAccounts(user.id).some((a) => a.id === id);
      if (!ok) return NextResponse.json({ error: "그 계좌를 찾지 못했습니다." }, { status: 404 });
      return NextResponse.json({ ok: true, ...putFlow(user.id, id, { date: String(body.date ?? ""), amount: Number(body.amount), note: body.note }, body.id ? String(body.id) : undefined) });
    } catch (err) { return NextResponse.json({ error: (err as Error).message }, { status: 400 }); }
  }
  if (body?.action !== "refresh") return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
  return startJob(refreshJobs, user.id, "refresh", async () => {
    const r = await refreshHistory(user.id, { kis: hasKisAccount(user) ? kisReader(user) : undefined });
    return { warnings: r.warnings };
  }, { errStatus: () => 400 });
}
