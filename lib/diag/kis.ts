/**
 * GET /api/diag/kis : 한국투자증권 API 실제 호출 점검 (서버 전용, 읽기 전용).
 *
 * owner 가 설정 화면에 넣은 키(실전·모의 각각)로 접근토큰 → 현재가 → 일봉 → KOSPI 지수 → 잔고 → 매수가능조회 → 주문 내역을 차례로 불러 봅니다.
 * - 주문은 내지 않습니다. 매수가능조회·주문 내역 조회는 조회 전용 API 입니다.
 * - 앱키·시크릿·계좌번호·금액은 내보내지 않습니다. 성공/실패, 걸린 시간, 증권사 오류 문구, 공개 시세만 돌려줍니다.
 */
import { credentialsFor, quoteCredentials, realOrdersAllowed, tradeEnv, type KisCredentials, type KisEnv } from "../kis/config";
import { getClient, type KisClient } from "../kis/client";
import { kisDaily, kisIndexDaily, kisQuote, kisSp500Daily, kisUsDaily, kisUsdKrwDaily } from "../kis/market";
import { getBalance, getBuyable, getOrders } from "../kis/trading";
import { runtimeEnv } from "../settings/store";
import { lookupCodes } from "../stocks/master";

type Env = Record<string, string | undefined>;

export interface KisCheck { step: string; label: string; ok: boolean; ms: number; info?: Record<string, unknown>; error?: string }

export interface KisEnvReport {
  env: KisEnv;
  keys: boolean;
  account: boolean;
  /** 모든 단계 성공 */
  ok: boolean;
  checks: KisCheck[];
}

const isoDay = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10); // 한국 날짜
const ymd = (iso: string) => iso.replace(/-/g, "");

async function step(label: string, name: string, fn: () => Promise<Record<string, unknown> | undefined>, now: () => number): Promise<KisCheck> {
  const t0 = now();
  try {
    const info = await fn();
    return { step: name, label, ok: true, ms: now() - t0, ...(info ? { info } : {}) };
  } catch (e) {
    return { step: name, label, ok: false, ms: now() - t0, error: (e as Error).message };
  }
}

export async function checkEnv(client: KisClient, cred: KisCredentials, opts: { code?: string; now?: () => number } = {}): Promise<KisEnvReport> {
  const now = opts.now ?? Date.now;
  const code = opts.code ?? "005930";
  const today = isoDay(now());
  const weekAgo = isoDay(now() - 7 * 864e5);
  const monthAgo = isoDay(now() - 20 * 864e5);
  const checks: KisCheck[] = [];
  const account = !!(cred.cano && cred.acntPrdtCd);

  const token = await step("접근토큰 발급", "token", async () => { await client.getToken(); return undefined; }, now);
  checks.push(token);
  if (token.ok) {
    checks.push(await step("현재가 조회", "quote", async () => {
      const q = await kisQuote(client, code);
      if (!(q.price > 0)) throw new Error("현재가가 0 입니다 (응답 모양이 다를 수 있음)");
      let name = q.name ?? null;
      if (!name) { try { name = lookupCodes([code])[0]?.name ?? null; } catch { /* 목록 없음 */ } }
      return { code, name, price: q.price, changeRate: q.changeRate };
    }, now));
    checks.push(await step("일봉(기간별 시세) 조회", "daily", async () => {
      const bars = await kisDaily(client, code, monthAgo, today);
      return { code, count: bars.length, last: bars.at(-1)?.date ?? null, close: bars.at(-1)?.close ?? null };
    }, now));
    checks.push(await step("KOSPI 지수 일봉 조회", "index", async () => {
      const bars = await kisIndexDaily(client, monthAgo, today);
      return { count: bars.length, last: bars.at(-1)?.date ?? null, close: bars.at(-1)?.close ?? null };
    }, now));
    // 미국 주식: 일봉(수정주가인지, 과거 몇 년치인지), 환율, S&P 500
    checks.push(await step("미국 주식 일봉 조회 (AAPL, 최근)", "usDaily", async () => {
      const bars = await kisUsDaily(client, "AAPL", monthAgo, today, ["NAS"]);
      return { count: bars.length, last: bars.at(-1)?.date ?? null, close: bars.at(-1)?.close ?? null };
    }, now));
    checks.push(await step("미국 주식 과거 범위·수정주가 (NVDA 2024-06 액면분할 전후, AAPL 2010)", "usHistory", async () => {
      // NVDA 는 2024-06-10 에 10:1 분할. 수정주가면 2024-06-07 종가가 120.9 안팎, 아니면 1208.9
      const nv = await kisUsDaily(client, "NVDA", "2024-06-03", "2024-06-14", ["NAS"]);
      const pre = nv.find((b) => b.date === "2024-06-07")?.close ?? null;
      const old = await kisUsDaily(client, "AAPL", "2010-01-04", "2010-01-29", ["NAS"]).catch((e) => e as Error);
      return {
        nvda20240607: pre, splitAdjusted: pre == null ? null : pre < 200,
        aapl2010: old instanceof Error ? old.message : { count: old.length, first: old[0]?.date ?? null, close: old[0]?.close ?? null },
      };
    }, now));
    checks.push(await step("원/달러 환율 일별 조회", "fx", async () => {
      const bars = await kisUsdKrwDaily(client, monthAgo, today);
      const old = await kisUsdKrwDaily(client, "2010-01-04", "2010-01-29").catch((e) => e as Error);
      return { count: bars.length, last: bars.at(-1)?.date ?? null, close: bars.at(-1)?.close ?? null, y2010: old instanceof Error ? old.message : { count: old.length, first: old[0]?.date ?? null, close: old[0]?.close ?? null } };
    }, now));
    checks.push(await step("S&P 500 지수 일별 조회", "sp500", async () => {
      const bars = await kisSp500Daily(client, monthAgo, today);
      return { count: bars.length, last: bars.at(-1)?.date ?? null, close: bars.at(-1)?.close ?? null };
    }, now));
    if (account) {
      checks.push(await step("계좌 잔고 조회", "balance", async () => {
        const b = await getBalance(client);
        return { holdings: b.holdings.length, cashRead: Number.isFinite(b.cash), totalPositive: b.totalValue > 0 };
      }, now));
      checks.push(await step("매수가능조회 (주문 없이 주문 경로 확인)", "buyable", async () => {
        const r = await getBuyable(client, code);
        return { code, canBuy: r.maxQty > 0 };
      }, now));
      checks.push(await step("주문·체결 내역 조회 (최근 7일)", "orders", async () => {
        const list = await getOrders(client, ymd(weekAgo), ymd(today));
        return {
          count: list.length,
          recent: list.slice(0, 10).map((o) => ({
            date: o.date, time: o.time, side: o.side, code: o.code, name: o.name, qty: o.qty, filled: o.filledQty, remaining: o.remaining, cancelled: o.cancelled,
          })),
        };
      }, now));
    }
  }
  return { env: cred.env, keys: true, account, ok: checks.every((c) => c.ok), checks };
}

export async function kisReport(
  q: { env?: string | null; code?: string | null } = {},
  deps: { env?: Env; clientFor?: (c: KisCredentials) => KisClient; now?: () => number } = {},
) {
  const e = deps.env ?? runtimeEnv();
  const clientFor = deps.clientFor ?? getClient;
  const want: KisEnv[] = q.env === "real" ? ["real"] : q.env === "mock" ? ["mock"] : ["real", "mock"];
  const code = q.code && /^[0-9A-Z]{6}$/.test(q.code.toUpperCase()) ? q.code.toUpperCase() : "005930";
  const envs: KisEnvReport[] = [];
  for (const env of want) {
    const cred = credentialsFor(env, e);
    if (!cred) { envs.push({ env, keys: false, account: false, ok: false, checks: [] }); continue; }
    envs.push(await checkEnv(clientFor(cred), cred, { code, now: deps.now }));
  }
  return {
    note: "주문은 내지 않았습니다. 매수가능조회·주문 내역은 조회 전용입니다.",
    quotesUse: quoteCredentials(e)?.env ?? null,
    tradeEnv: tradeEnv(e),
    realOrdersUnlocked: realOrdersAllowed(e),
    envs,
  };
}
