/**
 * 비밀값 암호화 (서버 전용). 다른 사람의 한국투자증권 앱키·계좌를 파일에 그대로 두지 않기 위한 것.
 *
 * 키: {설정 폴더}/secret.key (처음 쓸 때 자동 생성, 권한 600). 설정 폴더 안에 같이 있으므로 "폴더 전체가 새는 경우"는 막지 못합니다.
 * 방식: AES-256-GCM, 키는 scrypt 로 늘림. 형식 "v1.<iv>.<tag>.<data>" (base64url)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import fs from "fs";
import path from "path";
import { configDir } from "./store";

type Env = Record<string, string | undefined>;

const SALT = "alphy-secretbox-v1";
const derived = new Map<string, Buffer>();
const derive = (secret: string) => {
  let k = derived.get(secret);
  if (!k) { k = scryptSync(secret, SALT, 32); derived.set(secret, k); }
  return k;
};

const keyFile = (e: Env) => path.join(configDir(e), "secret.key");

function fileSecret(e: Env, create: boolean): string | null {
  try { const v = fs.readFileSync(keyFile(e), "utf8").trim(); if (v) return v; } catch { /* 없음 */ }
  if (!create) return null;
  const fresh = randomBytes(32).toString("base64url");
  fs.mkdirSync(configDir(e), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(keyFile(e), `${fresh}\n`, { mode: 0o600, flag: "wx" }); return fresh; }
  catch { return fs.readFileSync(keyFile(e), "utf8").trim(); } // 동시에 만들어졌으면 그 값을 씀
}

export function seal(plain: string, e: Env = process.env): string {
  const key = derive(fileSecret(e, true)!);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** 풀지 못하면(키가 바뀜·파일 손상) 에러 */
export function open(sealed: string, e: Env = process.env): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("암호화 형식이 아닙니다.");
  const secrets = [fileSecret(e, false)].filter((x): x is string => !!x);
  for (const s of secrets) {
    try {
      const d = createDecipheriv("aes-256-gcm", derive(s), Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
    } catch { /* 다음 키 */ }
  }
  throw new Error("저장된 값을 풀지 못했습니다. 암호화 키(secret.key)가 바뀌었다면 앱키를 다시 넣어야 합니다.");
}
