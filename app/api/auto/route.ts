import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { OWNER_ID } from "@/lib/settings/userdir";
import { updateSettings } from "@/lib/settings/store";
import { loadStrategies } from "@/lib/strategies/library";
import { cleanPlan, keepRealConfirm, loadLog, loadPlan, planKind, savePlan } from "@/lib/auto/store";
import { loadPerf, perfFor, rebase, resetBase, savePerf, summarize } from "@/lib/auto/perf";
import { loadNotify } from "@/lib/auto/telegram";
import { checkPassword, clientIp, loginBlockedFor, recordFail } from "@/lib/settings/auth";
import { tradeCredentialsFor } from "@/lib/kis/access";
import { accountSnapshot, eveningFor, eveningTime, loadState, MIX_TIME, morningTimes } from "@/lib/auto/scheduler";
import { formatDay, loadDay, loadDays, saveDay, stopDay } from "@/lib/auto/morning";
import { brokerFor } from "@/lib/auto/broker";
import { loadIntradayDays } from "@/lib/auto/intraday";
import { clockOf, planMarket, planMarkets } from "@/lib/auto/session";
import { notify } from "@/lib/auto/telegram";
import { cleanHm, kst } from "@/lib/auto/time";
import { autoLimitFor, kisEnvFor } from "@/lib/kis/userkeys";
import { tradeEnv } from "@/lib/kis/config";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";
import type { EveningReport } from "@/lib/auto/evening";
import { clearOldRecords } from "@/lib/auto/clear";
import { hasKisAccount } from "@/lib/manual/kis";
import { loadHistory } from "@/lib/manual/value";
import { cleanDates, extraClosed, loadCalendar, refreshKrCalendar, tradingDay, upcomingClosed } from "@/lib/market/holidays";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 시세를 새로 받느라 오래 걸릴 수 있어 작업으로 돌림 (프록시 60초 제한)
const runJobs = namedJobs<EveningReport>("auto-run");

export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const job = new URL(req.url).searchParams.get("job");
  if (job) return pollJob(runJobs, user.id, job);
  if (new URL(req.url).searchParams.get("orders")) {
    const p = loadPlan(user.id);
    const markets = p ? planMarkets(p) : ["KR" as const];
    try {
      let env: "real" | "mock" = "mock";
      const orders = [];
      for (const m of markets) {
        const b = brokerFor(user, process.env, m);
        env = b.env;
        orders.push(...(await b.orders(clockOf(m).date)).map((o) => ({ ...o, market: m })));
      }
      return NextResponse.json({ env, market: markets[0], markets, date: clockOf(markets[0]).date, at: new Date().toISOString(), orders }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return NextResponse.json({ error: `주문 내역을 읽지 못했습니다: ${(e as Error).message}` }, { status: 500 });
    }
  }
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
      mockDays: Object.values(days).filter((d) => d.env === "mock" && d.items.some((x) => x.filledQty > 0)).length,
      telegram: !!loadNotify(user.id).chatId,
    },
    plan: plan ? { ...plan, kind: planKind(plan), strategy: undefined, strategyName: plan.strategy?.name ?? null, builtin: plan.builtin ?? null } : null,
    log: loadLog(user.id).slice(0, 30),
    eveningTime: eveningTime(),
    lastEvening: loadState().evening ?? null,
    lastMix: loadState().mix ?? null,
    mixTime: MIX_TIME,
    limit: autoLimitFor(user.id),
    times: morningTimes(),
    days: Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
    intradayDays: Object.values(loadIntradayDays(user.id)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
    account,
    market: plan ? planMarket(plan) : "KR",
    markets: plan ? planMarkets(plan) : ["KR"],
    owner: user.id === OWNER_ID,
    today: kst().date,
    calendar: calendarView(),
    ...(hasKisAccount(user) ? { accountView: loadHistory(user.id).kis ?? null } : {}),
  }, { headers: { "Cache-Control": "no-store" } });
}

function calendarView() {
  const c = loadCalendar();
  return {
    markets: (["KR", "US"] as const).map((m) => { const d = clockOf(m).date; return { market: m, today: tradingDay(m, d), upcoming: upcomingClosed(m, d, 45) }; }),
    krFetchedAt: c.krFetchedAt ?? null,
    krError: c.krError ?? null,
    extra: extraClosed(),
  };
}

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
      case "holidays": {
        if (user.id !== OWNER_ID) return NextResponse.json({ error: "휴장일은 관리자만 바꿀 수 있습니다." }, { status: 403 });
        const KR = cleanDates(body.KR), US = cleanDates(body.US);
        updateSettings((s) => { s.auto.extraClosed = { KR, US }; });
        return NextResponse.json({ ok: true, calendar: calendarView() });
      }
      case "holidaysRefresh": {
        if (user.id !== OWNER_ID) return NextResponse.json({ error: "관리자만 할 수 있습니다." }, { status: 403 });
        const c = await refreshKrCalendar(process.env, { force: true });
        if (c.krError) return NextResponse.json({ error: c.krError }, { status: 502 });
        return NextResponse.json({ ok: true, calendar: calendarView() });
      }
      case "real": {
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
        tradeCredentialsFor(user); // 실전 잠금이 걸려 있으면 이유와 함께 오류
        const cap = autoLimitFor(user.id).realBudget;
        if (cap > 0 && plan.budget > cap) return NextResponse.json({ error: `운용 금액이 실전 운용 금액 상한(${cap.toLocaleString("ko-KR")}원)을 넘습니다.` }, { status: 400 });
        const at = new Date().toISOString();
        // updatedAt 은 그대로 두어 이미 한 계산을 다음 주문에 그대로 씀
        savePlan({ ...plan, realConfirmedAt: at }, user.id);
        await notify(user.id, `[알피] 실전 전환을 확인했습니다. 다음 거래일 아침부터 실전 계좌로 자동 주문합니다 (${plan.label}, 운용 금액 ${plan.budget.toLocaleString("ko-KR")}원).`).catch(() => false);
        return NextResponse.json({ ok: true, confirmedAt: at });
      }
      case "clear": {
        const plan = loadPlan(user.id);
        const before = plan?.updatedAt || new Date().toISOString();
        const n = clearOldRecords(before, user.id);
        return NextResponse.json({ ok: true, ...n });
      }
      case "rebase": {
        const plan = loadPlan(user.id);
        if (!plan) return NextResponse.json({ error: "먼저 운용 전략을 저장하세요." }, { status: 400 });
        const snap = await accountSnapshot(user, planMarkets(plan));
        if (snap.total == null) return NextResponse.json({ error: `계좌 평가액을 정확히 읽지 못했습니다. ${snap.note ?? ""}`.trim() }, { status: 400 });
        const perf = perfFor(loadPerf(user.id), plan, snap.env);
        savePerf(body.reset ? resetBase(perf, snap.total, kst().date) : rebase(perf, snap.total, kst().date), user.id);
        return NextResponse.json({ ok: true });
      }
      case "stop": {
        const plan = loadPlan(user.id);
        if (plan?.enabled) savePlan({ ...plan, enabled: false, updatedAt: new Date().toISOString() }, user.id);
        let cancelled = false;
        for (const market of plan ? planMarkets(plan) : ["KR" as const]) {
          let d = loadDay(clockOf(market).date, user.id, process.env, market);
          if (!d || !["placed", "buying"].includes(d.phase)) continue;
          d = await stopDay(d, brokerFor(user, process.env, market), Date.now());
          d.notified = true;
          saveDay(d, user.id);
          cancelled = true;
          await notify(user.id, formatDay(d, true)).catch(() => false);
        }
        return NextResponse.json({ ok: true, cancelled });
      }
      default:
        return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
