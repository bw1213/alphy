import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { loadSettings } from "@/lib/settings/store";
import { sellTax } from "@/lib/engine/costs";
import { kst } from "@/lib/auto/time";
import { namedJobs, pollJob, startJob } from "@/lib/server/jobReply";
import { allStocks, lookupCodes } from "@/lib/stocks/master";
import { loadAccounts, type FeeRates } from "@/lib/manual/store";
import { KIS_ID } from "@/lib/manual/value";
import { hasKisAccount } from "@/lib/manual/kis";
import { cleanEntry, parseLedgerText, toCsv, type CleanCtx } from "@/lib/accounts/ledger";
import { addEntries, clearEntries, deleteEntry, editEntry, ledgerStatus, rebuildAccount, MAX_ENTRIES } from "@/lib/accounts/ledgerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 다시 계산은 오래된 시세까지 받느라 오래 걸릴 수 있어 작업으로 (프록시 60초 제한) */
const buildJobs = namedJobs<{ ok: true; points: number; warnings: string[] }>("ledger-build");

const rates = (): FeeRates => {
  const b = loadSettings().backtest;
  const tax = b.sellTax ?? sellTax({ commission: 0, slippage: 0, sellTax: null }, Number(kst().date.slice(0, 4))) * 100;
  return { commission: b.commission, sellTax: tax, usCommission: b.usCommission, usFx: b.usFx };
};

function findByName(name: string) {
  const q = name.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return null;
  const hit = allStocks().all.find((s) => s.name.toLowerCase().replace(/\s+/g, "") === q);
  return hit ? { code: hit.code, name: hit.name } : null;
}

function named<T extends { ticker?: string; name?: string }>(x: T): T {
  if (!x.ticker || x.name) return x;
  const hit = lookupCodes([x.ticker])[0];
  return hit ? { ...x, name: hit.name } : x;
}

const ctx = (): CleanCtx => ({ today: kst().date, rates: rates(), find: findByName });

function accountKind(u: Parameters<typeof hasKisAccount>[0], id: string): "auto" | "manual" | null {
  if (id === KIS_ID) return hasKisAccount(u) ? "auto" : null;
  return loadAccounts(u.id).some((a) => a.id === id) ? "manual" : null;
}

/** ?account=<id> 과거 기록·계산 상태. &csv=1 은 내보내기. ?job=<id> 는 다시 계산 결과 물어보기 */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const q = new URL(req.url).searchParams;
  const job = q.get("job");
  if (job) return pollJob(buildJobs, user.id, job);
  const id = q.get("account") ?? "";
  if (!accountKind(user, id)) return NextResponse.json({ error: "그 계좌를 찾지 못했습니다." }, { status: 404 });
  const { entries, status } = ledgerStatus(user.id, id);
  if (q.get("csv")) {
    return new NextResponse(`﻿${toCsv(entries)}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ledger-${id}.csv"`, "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ entries, status, today: kst().date, max: MAX_ENTRIES }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * { action: "parse", accountId, text }   붙여넣은 표 읽어 보기 (저장 안 함)
 * { action: "add", accountId, entries: [...] }   기록 넣기 (한 건도 같은 모양)
 * { action: "edit", accountId, id, entry }
 * { action: "delete", accountId, id }
 * { action: "clear", accountId }   과거 기록 모두 지우기
 * { action: "build", accountId }   과거 평가액 다시 계산. 결과는 ?job=
 */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  const id = String(body?.accountId ?? "");
  const kind = accountKind(user, id);
  if (!kind) return NextResponse.json({ error: "그 계좌를 찾지 못했습니다." }, { status: 404 });
  try {
    switch (body?.action) {
      case "parse": {
        const text = String(body.text ?? "");
        if (text.length > 2_000_000) throw new Error("붙여넣은 내용이 너무 깁니다. 나눠서 넣어 주세요.");
        return NextResponse.json({ rows: parseLedgerText(text, ctx(), MAX_ENTRIES).map((r) => (r.entry ? { ...r, entry: named(r.entry) } : r)) });
      }
      case "add": {
        const c = ctx();
        const raw: unknown[] = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
        const bad: { index: number; error: string }[] = [];
        const good: { i: number; x: ReturnType<typeof cleanEntry> }[] = [];
        raw.forEach((x, i) => { try { good.push({ i, x: named(cleanEntry(x, c)) }); } catch (e) { bad.push({ index: i, error: (e as Error).message }); } });
        const r = addEntries(user.id, id, good.map((g) => g.x), { manual: kind === "manual" });
        return NextResponse.json({ ok: true, added: r.added.length, skipped: [...bad, ...r.skipped.map((s) => ({ index: good[s.index].i, error: s.error }))].sort((a, b) => a.index - b.index) });
      }
      case "edit":
        return NextResponse.json({ ok: true, entry: editEntry(user.id, id, String(body.id ?? ""), named(cleanEntry(body.entry, ctx()))) });
      case "delete":
        deleteEntry(user.id, id, String(body.id ?? ""));
        return NextResponse.json({ ok: true });
      case "clear":
        return NextResponse.json({ ok: true, removed: clearEntries(user.id, id) });
      case "build":
        return startJob(buildJobs, user.id, `build:${id}`, async (progress) => {
          const b = await rebuildAccount(user.id, id, { onProgress: progress });
          return { ok: true as const, points: b?.points.length ?? 0, warnings: b?.warnings ?? [] };
        }, { errStatus: () => 400 });
      default:
        return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
