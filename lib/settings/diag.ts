/**
 * 점검용 접근 키 (서버 전용).
 *
 * 설정 화면에서 발급해 Claude 같은 도우미에게 넘겨 주면, 그쪽이 서버 상태를 직접 볼 수 있습니다.
 * - 쓸 수 있는 곳: /api/diag/* (읽기 전용 점검 API) 뿐. 화면·설정·주문·잔고·전략 저장에는 쓸 수 없습니다.
 * - 키 원문은 발급할 때 한 번만 보여 주고, 서버에는 SHA-256 해시만 저장합니다.
 * - 유효 기간(최대 30일)이 지나면 자동으로 막히고, 화면에서 언제든 폐기할 수 있습니다.
 * - 비밀번호를 바꾸거나 "모든 기기 로그아웃"을 누르면 점검 키도 모두 폐기됩니다.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { loadSettings, updateSettings } from "./store";

type Env = Record<string, string | undefined>;

export interface DiagToken {
  id: string;
  name: string;
  /** 키 원문의 SHA-256 (hex) */
  hash: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  lastIp?: string;
}

/** 화면에 보여 주는 모양 (해시 없음) */
export type DiagTokenView = Omit<DiagToken, "hash">;

export const DIAG_PREFIX = "alphy_diag_";
export const DIAG_DAYS = [1, 7, 30] as const;
export const MAX_DIAG_TOKENS = 5;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const list = (e: Env, now = Date.now()) => (loadSettings(e).auth.diagTokens ?? []).filter((t) => t.expiresAt > now);

export function listDiagTokens(e: Env = process.env, now = Date.now()): DiagTokenView[] {
  return list(e, now).map(({ hash: _h, ...rest }) => rest);
}

/** 새 키 발급. 원문은 반환값으로 한 번만 나옴 */
export function createDiagToken(name: string, days: number, e: Env = process.env, now = Date.now()): { token: string; view: DiagTokenView } {
  if (!DIAG_DAYS.includes(days as (typeof DIAG_DAYS)[number])) throw new Error(`유효 기간은 ${DIAG_DAYS.join("·")}일 중에서 고르세요.`);
  const label = String(name ?? "").trim().slice(0, 40) || "점검용";
  const token = DIAG_PREFIX + randomBytes(32).toString("base64url");
  const item: DiagToken = { id: randomBytes(4).toString("hex"), name: label, hash: sha(token), createdAt: now, expiresAt: now + days * 864e5 };
  updateSettings((s) => {
    const live = (s.auth.diagTokens ?? []).filter((t) => t.expiresAt > now);
    if (live.length >= MAX_DIAG_TOKENS) throw new Error(`점검 키는 ${MAX_DIAG_TOKENS}개까지 둘 수 있습니다. 안 쓰는 키를 먼저 폐기하세요.`);
    s.auth.diagTokens = [...live, item];
  }, e);
  const { hash: _h, ...view } = item;
  return { token, view };
}

export function revokeDiagToken(id: string, e: Env = process.env) {
  updateSettings((s) => { s.auth.diagTokens = (s.auth.diagTokens ?? []).filter((t) => t.id !== id); }, e);
}

export function revokeAllDiagTokens(e: Env = process.env) {
  updateSettings((s) => { delete s.auth.diagTokens; }, e);
}

/** Authorization: Bearer alphy_diag_... 에서 키 원문 */
export function bearerToken(req: Request): string | undefined {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m && m[1].startsWith(DIAG_PREFIX) && m[1].length < 200 ? m[1] : undefined;
}

/** 유효한 키면 그 항목, 아니면 null */
export function findDiagToken(token: string | undefined, e: Env = process.env, now = Date.now()): DiagToken | null {
  if (!token) return null;
  const want = Buffer.from(sha(token), "hex");
  let hit: DiagToken | null = null;
  for (const t of list(e, now)) {
    const got = Buffer.from(t.hash, "hex");
    if (got.length === want.length && timingSafeEqual(got, want)) hit = t;
  }
  return hit;
}

/** 마지막 사용 시각·주소 기록 (같은 키는 1분에 한 번만 파일에 씀) */
export function touchDiagToken(id: string, ip: string, e: Env = process.env, now = Date.now()) {
  const t = list(e, now).find((x) => x.id === id);
  if (!t || (t.lastUsedAt && now - t.lastUsedAt < 60_000 && t.lastIp === ip)) return;
  try {
    updateSettings((s) => {
      const x = s.auth.diagTokens?.find((y) => y.id === id);
      if (x) { x.lastUsedAt = now; x.lastIp = ip; }
    }, e);
  } catch { /* 기록 실패는 점검에 영향 없게 */ }
}
