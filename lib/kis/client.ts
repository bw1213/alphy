/**
 * KIS REST 클라이언트 (서버 전용).
 * - 접근토큰: 하루(24h) 유효, 1분에 1회만 발급 가능 → 메모리 + .cache/kis/ 파일에 저장해 재사용
 * - 호출 간격 제한(실전 20건/초, 모의 2건/초) → 환경별 직렬 대기열
 * - "초당 거래건수 초과"(EGW00201)는 잠시 쉬고 재시도, 토큰 만료(EGW00123)는 재발급 후 1회 재시도
 */
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { KIS_BASE_URL, KIS_MIN_INTERVAL_MS, type KisCredentials, type KisEnv } from "./config";

export class KisError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}

export interface KisResponse {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  [k: string]: unknown;
}

export interface KisCallResult<T extends KisResponse = KisResponse> {
  body: T;
  /** 다음 페이지가 있으면 "M" 또는 "F" */
  trCont: string;
}

interface Token { token: string; expiresAt: number; keyHash: string }

export interface KisClientOptions {
  fetch?: typeof fetch;
  cacheDir?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
}

const RATE_LIMIT = "EGW00201";
const TOKEN_EXPIRED = new Set(["EGW00123", "EGW00121"]);

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KisClient {
  private token: Token | null = null;
  private tokenPromise: Promise<string> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cacheDir: string | null;
  private readonly minInterval: number;
  readonly base: string;

  constructor(readonly cred: KisCredentials, opt: KisClientOptions = {}) {
    this.f = opt.fetch ?? fetch;
    this.sleep = opt.sleep ?? realSleep;
    this.now = opt.now ?? Date.now;
    this.cacheDir = opt.cacheDir === undefined ? path.join(process.cwd(), ".cache", "kis") : opt.cacheDir;
    this.minInterval = opt.minIntervalMs ?? KIS_MIN_INTERVAL_MS[cred.env];
    this.base = KIS_BASE_URL[cred.env];
  }

  get env(): KisEnv { return this.cred.env; }

  private get keyHash() {
    return createHash("sha256").update(this.cred.appKey).digest("hex").slice(0, 16);
  }
  private get tokenFile() { return this.cacheDir ? path.join(this.cacheDir, `token-${this.cred.env}.json`) : null; }

  /** 만료 1시간 전부터는 새로 발급 */
  private valid(t: Token | null): t is Token {
    return !!t && t.keyHash === this.keyHash && t.expiresAt - this.now() > 3600_000;
  }

  async getToken(force = false): Promise<string> {
    if (!force && this.valid(this.token)) return this.token.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      if (!force && this.tokenFile) {
        try {
          const t = JSON.parse(await fs.readFile(this.tokenFile, "utf8")) as Token;
          if (this.valid(t)) { this.token = t; return t.token; }
        } catch { /* 없음 */ }
      }
      const res = await this.f(`${this.base}/oauth2/tokenP`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ grant_type: "client_credentials", appkey: this.cred.appKey, appsecret: this.cred.appSecret }),
        cache: "no-store",
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof j.access_token !== "string") {
        const msg = String(j.error_description ?? j.msg1 ?? `HTTP ${res.status}`);
        throw new KisError(`한국투자증권 접근토큰 발급 실패: ${msg} (앱키·시크릿과 실전/모의 구분을 확인하세요. 토큰은 1분에 한 번만 발급됩니다)`,
          String(j.error_code ?? j.msg_cd ?? ""), res.status);
      }
      const expiresIn = Number(j.expires_in) || 86400;
      const t: Token = { token: j.access_token, expiresAt: this.now() + expiresIn * 1000, keyHash: this.keyHash };
      this.token = t;
      if (this.tokenFile) {
        try {
          await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
          await fs.writeFile(this.tokenFile, JSON.stringify(t), { mode: 0o600 });
        } catch { /* 캐시 실패는 무시 */ }
      }
      return t.token;
    })();
    try { return await this.tokenPromise; } finally { this.tokenPromise = null; }
  }

  /** 호출 간격을 지키도록 직렬화 */
  private throttle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastCall + this.minInterval - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCall = this.now();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async call<T extends KisResponse = KisResponse>(opts: {
    method: "GET" | "POST";
    path: string;
    trId: string;
    query?: Record<string, string>;
    body?: Record<string, string>;
    trCont?: string;
  }): Promise<KisCallResult<T>> {
    let retriedToken = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const url = new URL(this.base + opts.path);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
      const res = await this.throttle(() => this.f(url.toString(), {
        method: opts.method,
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
          appkey: this.cred.appKey,
          appsecret: this.cred.appSecret,
          tr_id: opts.trId,
          tr_cont: opts.trCont ?? "",
          custtype: "P",
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      }));
      const body = (await res.json().catch(() => ({}))) as T;
      const code = String(body.msg_cd ?? "");
      if (code === RATE_LIMIT && attempt < 5) { await this.sleep(1000 * (attempt + 1)); continue; }
      if (TOKEN_EXPIRED.has(code) && !retriedToken) { retriedToken = true; await this.getToken(true); continue; }
      if (!res.ok || (body.rt_cd !== undefined && body.rt_cd !== "0")) {
        throw new KisError(`${opts.trId}: ${body.msg1?.trim() || `HTTP ${res.status}`}${code ? ` (${code})` : ""}`, code, res.status);
      }
      return { body, trCont: res.headers.get("tr_cont") ?? "" };
    }
  }
}

const clients = new Map<string, KisClient>();

/** 프로세스 안에서 같은 자격 증명이면 같은 클라이언트(토큰·호출간격 공유) */
export function getClient(cred: KisCredentials): KisClient {
  const key = `${cred.env}:${cred.appKey}`;
  let c = clients.get(key);
  if (!c) { c = new KisClient(cred); clients.set(key, c); }
  return c;
}
