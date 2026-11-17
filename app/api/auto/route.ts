import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { OWNER_ID } from "@/lib/settings/userdir";
import { updateSettings } from "@/lib/settings/store";
import { loadStrategies } from "@/lib/strategies/library";
import { cleanPlan, keepRealConfirm, loadLog, loadPlan, planKind, savePlan } from "@/lib/auto/store";
import { loadPerf, perfFor, rebase, savePerf, summarize } from "@/lib/auto/perf";
import { loadNotify } from "@/lib/auto/telegram";
import { checkPassword, clientIp, loginBlockedFor, recordFail } from "@/lib/settings/auth";
import { tradeCredentialsFor } from "@/lib/kis/access";
import { eveningFor, eveningTime, loadState, morningTimes } from "@/lib/auto/scheduler";
import { formatDay, loadDay, loadDays, saveDay, stopDay } from "@/lib/auto/morning";
import { brokerFor } from "@/lib/auto/broker";
import { loadIntradayDays } from "@/lib/auto/intraday";
import { notify } from "@/lib/auto/telegram";
import { cleanHm, kst } from "@/lib/auto/time";
import { autoLimitFor, kisEnvFor } from "@/lib/kis/userkeys";
import { tradeEnv } from "@/lib/kis/config";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";
import type { EveningReport } from "@/lib/auto/evening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "지금 계산해 보기"는 시세를 새로 받느라 오래 걸릴 수 있어 작업으로 돌림 (프록시 60초 제한) */
const runJobs = namedJobs<EveningReport>("auto-run");

/** 내 운용 전략·최근 계산 기록·예약 시각. ?job=<id> 는 "지금 계산해 보기" 결과 물어보기 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const job = new URL(req.url).searchParams.get("job");
  if (job) return pollJob(runJobs, user.id, job);
  const plan = loadPlan(user.id);
  const account = tradeEnv(kisEnvFor(user));
  const days = loadDays(user.id);
  const perf = plan ? perfFor(loadPerf(user.id), plan, account) : null;
  let lock: string | null = null;
  if (account === "real") { try { tradeCredentialsFor(user); } catch (e) { lock = (e as Error).message; } }
  return NextResponse.json({
    perf: perf ? { base: perf.base ?? null, budget: perf.budget, env: perf.env ?? account, points: perf.points.slice(-250), summary: summarize(perf) } : null,
    real: {
      confirmedAt: plan?.realConfirmedAt ?? null,
      lock,
      /** 모의투자로 실제 체결까지 된 날 수 */
      mockDays: Object.values(days).filter((d) => d.env === "mock" && d.items.some((x) => x.filledQty > 0)).length,
      telegram: !!loadNotify(user.id).chatId,
    },
    plan: plan ? { ...plan, kind: planKind(plan), strategy: undefined, strategyName: plan.strategy?.name ?? null, builtin: plan.builtin ?? null } : null,
    log: loadLog(user.id).slice(0, 30),
    eveningTime: eveningTime(),
    lastEvening: loadState().evening ?? null,
    limit: autoLimitFor(user.id),
    times: morningTimes(),
    days: Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
    intradayDays: Object.values(loadIntradayDays(user.id)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
    account,
    owner: user.id === OWNER_ID,
    today: kst().date,
  }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * { action: "save", strategy: "saved:이름" | "builtin:id", tickers, budget, startDate, enabled, intraday }
 * { action: "delete" }
 * { action: "run", notify?: boolean }   지금 저녁 계산 해 보기
 * { action: "time", eveningTime: "18:00" } (owner)
 * { action: "times", morningTime: "08:40", cutoffTime: "10:00" } (owner)
 * { action: "stop" }   긴급 정지: 운용 끄기 + 오늘 남은 자동 주문 취소
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
        const plan = keepRealConfirm(loadPlan(user.id), cleanPlan(body, user.id, kst().date, loadStrategies(process.env, user.id), real));
        savePlan(plan, user.id);
        return NextResponse.json({ ok: true });
      }
      case "delete":
        savePlan(null, user.id);
        return NextResponse.json({ ok: true });
      case "run": {
        if (!loadPlan(user.id)) return NextResponse.json({ error: "먼저 운용 전략을 저장하세요." }, { status: 400 });
        const notifyTg = body.notify === true;
        return startJob(runJobs, user.id, `run:${notifyTg}`, async () => {
          const r = await eveningFor(user, "manual", { notify: notifyTg });
          if (!r) throw new Error("먼저 운용 전략을 저장하세요.");
          return r;
        }, { errStatus: () => 400 });
      }
      case "time": {
        if (user.id !== OWNER_ID) return NextResponse.json({ error: "계산 시각은 관리자만 바꿀 수 있습니다." }, { status: 403 });
        const t = cleanHm(body.eveningTime);
        if (!t || t < "16:00") return NextResponse.json({ error: "16:00~23:59 사이로 넣으세요 (장 마감 뒤 시세가 확정된 다음)." }, { status: 400 });
        updateSettings((s) => { s.auto.eveningTime = t; });
        return NextResponse.json({ ok: true, eveningTime: t });
      }
      case "times": {
        if (user.id !== OWNER_ID) return NextResponse.json({ error: "주문 시각은 관리자만 바꿀 수 있습니다." }, { status: 403 });
        const m = cleanHm(body.morningTime), c = cleanHm(body.cutoffTime);
        if (!m || !c || m < "08:30" || m > "09:50") return NextResponse.json({ error: "주문 시각은 08:30~09:50 사이로 넣으세요 (08:30 전에는 증권사가 주문을 받지 않음)." }, { status: 400 });
        if (c > "10:00" || c <= m) return NextResponse.json({ error: "마감 시각은 주문 시각 뒤, 10:00 까지로 넣으세요." }, { status: 400 });
        updateSettings((s) => { s.auto.morningTime = m; s.auto.cutoffTime = c; });
        return NextResponse.json({ ok: true });
      }
      case "real": {
        // 실전 전환 확인 / 취소. 확인은 비밀번호를 다시 넣어야 함
        const plan = loadPlan(user.id);
        if (!plan) return NextResponse.json({ error: "먼저 운용 전략을 저장하세요." }, { status: 400 });
        if (body.on !== true) {
          savePlan({ ...plan, realConfirmedAt: undefined }, user.id);
          return NextResponse.json({ ok: true, confirmedAt: null });
        }
        const ip = clientIp(req);
        if (loginBlockedFor(ip, Date.now(), user.id) > 0) return NextResponse.json({ error: "여러 번 틀려서 잠겼습니다. 잠시 뒤에 다시 하세요." }, { status: 429 });
        if (!checkPassword(String(body.password ?? ""), process.env, user.id)) { recordFail(ip, Date.now(), user.id); return NextResponse.json({ error: "비밀번호가 틀렸습니다." }, { status: 401 }); }
        if (tradeEnv(kisEnvFor(user)) !== "real") return NextResponse.json({ error: "주문 계좌가 모의투자입니다. 먼저 설정에서 주문 대상을 실전으로 바꾸세요." }, { status: 400 });
        tradeCredentialsFor(user); // 실전 잠금이 걸려 있으면 여기서 이유와 함께 오류
        const cap = autoLimitFor(user.id).realBudget;
        if (cap > 0 && plan.budget > cap) return NextResponse.json({ error: `운용 금액이 실전 운용 금액 상한(${cap.toLocaleString("ko-KR")}원)을 넘습니다.` }, { status: 400 });
        const at = new Date().toISOString();
        // updatedAt 은 그대로: 어제 저녁 계산을 내일 아침에 그대로 씀
        savePlan({ ...plan, realConfirmedAt: at }, user.id);
        await notify(user.id, `[알피] 실전 전환을 확인했습니다. 다음 거래일 아침부터 실전 계좌로 자동 주문합니다 (${plan.label}, 운용 금액 ${plan.budget.toLocaleString("ko-KR")}원).`).catch(() => false);
        return NextResponse.json({ ok: true, confirmedAt: at });
      }
      case "rebase": {
        // 입금·출금 뒤: 손익은 그대로 두고 성과 기준을 지금 계좌 평가액에 맞춤
        const plan = loadPlan(user.id);
        if (!plan) return NextResponse.json({ error: "먼저 운용 전략을 저장하세요." }, { status: 400 });
        const b = brokerFor(user);
        const perf = perfFor(loadPerf(user.id), plan, b.env);
        const bal = await b.balance();
        savePerf(rebase(perf, bal.totalValue, kst().date), user.id);
        return NextResponse.json({ ok: true });
      }
      case "stop": {
        const plan = loadPlan(user.id);
        if (plan?.enabled) savePlan({ ...plan, enabled: false, updatedAt: new Date().toISOString() }, user.id);
        const today = kst().date;
        let d = loadDay(today, user.id);
        if (d && ["placed", "buying"].includes(d.phase)) {
          d = await stopDay(d, brokerFor(user), Date.now());
          d.notified = true;
          saveDay(d, user.id);
          await notify(user.id, formatDay(d, true)).catch(() => false);
        }
        return NextResponse.json({ ok: true, cancelled: d?.phase === "stopped" });
      }
      default:
        return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
