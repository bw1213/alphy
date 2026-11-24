import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { loadSettings } from "@/lib/settings/store";
import { sellTax } from "@/lib/engine/costs";
import { loadStrategies } from "@/lib/strategies/library";
import { planKind } from "@/lib/auto/store";
import { kst } from "@/lib/auto/time";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";
import { manualEveningFor } from "@/lib/manual/evening";
import { MAX_ACCOUNTS, brokerList, cleanAccount, forgetBroker, resetBasis, loadAccounts, loadManualLog, loadTrades, recordTrade, rewriteTrade, saveAccounts, undoLastTrade, type FeeRates } from "@/lib/manual/store";
import { fetchPrices, loadHistory, recordEdit, refreshHistory } from "@/lib/manual/value";
import type { EveningReport } from "@/lib/auto/evening";
import { dropAccount } from "@/lib/accounts/ledgerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "지금 계산해 보기"는 시세를 받느라 오래 걸릴 수 있어 작업으로 (프록시 60초 제한) */
const runJobs = namedJobs<Record<string, EveningReport>>("manual-run");
/** 기준 다시 잡기는 종가를 새로 받느라 오래 걸릴 수 있어 작업으로 */
const resetJobs = namedJobs<{ budget: number; startDate: string; warning?: string }>("manual-reset");

const rates = (): FeeRates => {
  const b = loadSettings().backtest;
  const y = Number(kst().date.slice(0, 4));
  // 거래세를 비워 두면(자동) 올해 코스피 거래세
  const tax = b.sellTax ?? sellTax({ commission: 0, slippage: 0, sellTax: null }, y) * 100;
  return { commission: b.commission, sellTax: tax, usCommission: b.usCommission, usFx: b.usFx };
};

/** 내 수동 계좌·계좌별 최근 계산·체결 기록. ?job=<id> 는 "지금 계산해 보기" 결과 물어보기 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const job = new URL(req.url).searchParams.get("job");
  if (job) return new URL(req.url).searchParams.get("kind") === "reset" ? pollJob(resetJobs, user.id, job) : pollJob(runJobs, user.id, job);
  const accounts = loadAccounts(user.id);
  const logs = loadManualLog(user.id);
  const h = loadHistory(user.id);
  return NextResponse.json({
    accounts: accounts.map((a) => ({
      ...a,
      plan: a.plan ? { ...a.plan, kind: planKind(a.plan), strategy: undefined, strategyName: a.plan.strategy?.name ?? null, builtin: a.plan.builtin ?? null } : null,
      log: (logs[a.id] ?? []).slice(0, 10),
    })),
    prices: h.prices,
    trades: loadTrades(user.id).slice(0, 200),
    brokers: brokerList(user.id),
    rates: rates(),
    today: kst().date,
  }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * { action: "save", account: { id?, name, broker, cash, positions: [{ticker, name?, qty, avgPrice}], plan: { strategy, tickers, budget, startDate, enabled } | null } }
 * { action: "delete", id }
 * { action: "trade", accountId, ticker, name?, side, qty, price, fee?, date? }   체결 기록
 * { action: "editTrade", accountId, id, ticker, name?, side, qty, price, fee?, date? }   체결 기록 고치기 (잔고 다시 계산)
 * { action: "deleteTrade", accountId, id }   체결 기록 지우기 (잔고 다시 계산)
 * { action: "undo", accountId }   그 계좌의 마지막 체결 기록 되돌리기
 * { action: "run", accountId?, notify? }   지금 계산해 보기
 * { action: "reset", accountId }   전략 기준 다시 잡기 (시작일=오늘, 운용 금액=지금 평가액). 결과는 ?kind=reset&job=
 * { action: "forgetBroker", name }   직접 입력한 증권사를 목록에서 지움
 */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try {
    switch (body?.action) {
      case "save": {
        const list = loadAccounts(user.id);
        const id = String(body.account?.id ?? "");
        const i = id ? list.findIndex((a) => a.id === id) : -1;
        if (id && i < 0) return NextResponse.json({ error: "그 계좌를 찾지 못했습니다." }, { status: 404 });
        if (i < 0 && list.length >= MAX_ACCOUNTS) return NextResponse.json({ error: `수동 계좌는 ${MAX_ACCOUNTS}개까지 만들 수 있습니다.` }, { status: 400 });
        const a = cleanAccount(body.account, i >= 0 ? list[i] : null, user.id, kst().date, loadStrategies(process.env, user.id));
        const prev = i >= 0 ? list[i] : null;
        if (i >= 0) list[i] = a; else list.push(a);
        saveAccounts(list, user.id);
        const flow = prev ? recordEdit(user.id, prev, a) : null;
        return NextResponse.json({ ok: true, id: a.id, ...(flow ? { flow } : {}) });
      }
      case "delete": {
        const list = loadAccounts(user.id);
        const next = list.filter((a) => a.id !== String(body.id ?? ""));
        if (next.length === list.length) return NextResponse.json({ error: "그 계좌를 찾지 못했습니다." }, { status: 404 });
        saveAccounts(next, user.id);
        dropAccount(user.id, String(body.id ?? ""));
        return NextResponse.json({ ok: true });
      }
      case "trade": {
        const r = recordTrade(user.id, String(body.accountId ?? ""), body, rates(), kst().date);
        return NextResponse.json({ ok: true, trade: r.trade });
      }
      case "editTrade": {
        const r = rewriteTrade(user.id, String(body.accountId ?? ""), String(body.id ?? ""), body, rates(), kst().date);
        return NextResponse.json({ ok: true, trade: r.trade });
      }
      case "deleteTrade": {
        rewriteTrade(user.id, String(body.accountId ?? ""), String(body.id ?? ""), null, rates(), kst().date);
        return NextResponse.json({ ok: true });
      }
      case "undo": {
        const t = undoLastTrade(user.id, String(body.accountId ?? ""));
        return NextResponse.json({ ok: true, trade: t });
      }
      case "reset": {
        // 전략 기준 다시 잡기: 시작일=오늘, 운용 금액=지금 계좌 평가액 (종가를 새로 받아서, 못 받으면 지난 시세·평균단가)
        const id = String(body.accountId ?? "");
        const a = loadAccounts(user.id).find((x) => x.id === id);
        if (!a) return NextResponse.json({ error: "그 계좌를 찾지 못했습니다." }, { status: 404 });
        if (!a.plan) return NextResponse.json({ error: "이 계좌에는 전략이 없습니다. 먼저 전략을 정하세요." }, { status: 400 });
        return startJob(resetJobs, user.id, `reset:${id}`, async () => {
          const old = loadHistory(user.id).prices;
          let warning: string | undefined;
          let fresh: Awaited<ReturnType<typeof fetchPrices>> | null = null;
          try { fresh = await fetchPrices(a.positions.map((p) => p.ticker)); }
          catch (e) { warning = `종가를 받지 못해 ${old ? "지난번 시세" : "평균단가"}로 계산했습니다: ${(e as Error).message}`; }
          const price = (t: string) => fresh?.map[t]?.close ?? old?.map[t]?.close;
          const next = resetBasis(user.id, id, kst().date, price);
          // 대시보드의 오늘 점도 새 기준으로 (전략 평가액 = 운용 금액)
          await refreshHistory(user.id, { strategy: { [id]: next.plan!.budget } }).catch(() => null);
          return { budget: next.plan!.budget, startDate: next.plan!.startDate, ...(warning ? { warning } : {}) };
        }, { errStatus: () => 400 });
      }
      case "forgetBroker": {
        forgetBroker(String(body.name ?? ""), user.id);
        return NextResponse.json({ ok: true });
      }
      case "run": {
        const only = body.accountId ? String(body.accountId) : undefined;
        const acc = loadAccounts(user.id).filter((a) => a.plan && (!only || a.id === only));
        if (!acc.length) return NextResponse.json({ error: "전략을 지정한 계좌가 없습니다. 계좌에 전략을 먼저 저장하세요." }, { status: 400 });
        const notifyTg = body.notify === true;
        return startJob(runJobs, user.id, `run:${only ?? "all"}:${notifyTg}`, async () => (await manualEveningFor(user.id, "manual", { notify: notifyTg, only })).reports, { errStatus: () => 400 });
      }
      default:
        return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
