/**
 * 2단계 인증(TOTP, RFC 6238). Google Authenticator·Microsoft Authenticator·1Password 등
 * 휴대폰 인증 앱이 30초마다 바꿔 보여주는 6자리 숫자를 확인합니다. 외부 라이브러리 없이 crypto 만 사용.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("base32 형식 오류");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 새 비밀 키 (160비트, base32) */
export const newTotpSecret = () => base32Encode(randomBytes(20));

const STEP = 30;

/** counter(30초 단위 시각)의 6자리 코드 */
export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export const totpNow = (secret: string, now = Date.now()) => hotp(secret, Math.floor(now / 1000 / STEP));

/**
 * 코드가 맞으면 그 counter, 아니면 null. 휴대폰 시계가 조금 어긋나도 되도록 앞뒤 30초까지 허용.
 * lastUsed 이하의 counter 는 거부(같은 코드를 두 번 쓰지 못하게).
 */
export function verifyTotp(secret: string, code: string, now = Date.now(), lastUsed = -1): number | null {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const t = Math.floor(now / 1000 / STEP);
  for (const k of [t - 1, t, t + 1]) {
    if (k <= lastUsed) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, k)), Buffer.from(c))) return k;
  }
  return null;
}

/** 인증 앱에 등록할 주소 (QR 코드 내용) */
export function otpauthUri(secret: string, account = "admin", issuer = "알피"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}
