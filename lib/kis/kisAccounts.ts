/** 설정 화면에서 한국투자증권 계좌를 더 붙이기·고치기·지우기 (서버 전용) */
import { randomBytes } from "crypto";
import { parseAccount } from "./config";
import type { KisAccount, KisKeySet } from "../settings/store";

export const MAX_KIS_ACCOUNTS = 10;

export interface KisAccountOp {
  action: "add" | "edit" | "delete";
  id?: string;
  name?: string;
  env?: string;
  appKey?: string;
  appSecret?: string;
  account?: string;
}

const accountKey = (s?: string) => { const a = parseAccount(s); return a ? `${a.cano}-${a.acntPrdtCd}` : null; };
const clip = (v: unknown) => String(v ?? "").trim();

/** 바뀐 목록과 실전 계좌가 새로 생겼는지. 잘못된 값이면 에러 */
export function applyKisAccountOp(list: KisAccount[], op: KisAccountOp, primary: { real: KisKeySet; mock: KisKeySet }, hasPlan: (id: string) => boolean): { list: KisAccount[]; toReal: boolean; id: string } {
  const out = list.map((a) => ({ ...a }));
  if (op.action === "delete") {
    const i = out.findIndex((a) => a.id === op.id);
    if (i < 0) throw new Error("그 계좌를 찾지 못했습니다.");
    if (hasPlan(out[i].id)) throw new Error("이 계좌에 운용 전략이 있습니다. 계좌 화면에서 먼저 \"운용 그만두기\"를 하세요.");
    out.splice(i, 1);
    return { list: out, toReal: false, id: String(op.id) };
  }
  const prev = op.action === "edit" ? out.find((a) => a.id === op.id) : undefined;
  if (op.action === "edit" && !prev) throw new Error("그 계좌를 찾지 못했습니다.");
  const wasReal = prev?.env === "real";
  if (op.action === "add" && out.length >= MAX_KIS_ACCOUNTS) throw new Error(`계좌는 ${MAX_KIS_ACCOUNTS}개까지 더 붙일 수 있습니다.`);
  const next: KisAccount = prev ?? { id: `kis-${randomBytes(3).toString("hex")}`, name: "", env: "mock" };
  if (op.name !== undefined) next.name = clip(op.name).slice(0, 30);
  if (!next.name) throw new Error("계좌 이름을 넣으세요 (예: 연금저축, ISA).");
  if (op.env !== undefined) {
    if (op.env !== "real" && op.env !== "mock") throw new Error("실전 또는 모의투자를 고르세요.");
    next.env = op.env;
  }
  for (const f of ["appKey", "appSecret", "account"] as const) {
    const v = clip(op[f]);
    if (v.length > 500) throw new Error("값이 너무 깁니다.");
    if (v) next[f] = v;
  }
  if (!next.appKey || !next.appSecret) throw new Error("앱키와 앱시크릿을 넣으세요. 한국투자증권은 계좌마다 앱키가 따로 나옵니다.");
  const key = accountKey(next.account);
  if (!key) throw new Error("계좌번호는 12345678-01 형식입니다.");
  const used = [primary.real.account, primary.mock.account, ...out.filter((a) => a.id !== next.id).map((a) => a.account)].map(accountKey);
  if (used.includes(key)) throw new Error("이미 등록한 계좌번호입니다. 한 계좌에는 운용을 하나만 둡니다.");
  if (!prev) out.push(next);
  return { list: out, toReal: next.env === "real" && !wasReal, id: next.id };
}
