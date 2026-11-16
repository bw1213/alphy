/**
 * 브라우저 저장값(localStorage)을 사람별로 나눔. 같은 기기를 여러 사람이 번갈아 써도 섞이지 않게.
 *
 * 누구인지는 서버가 넣어 주는 alphy_uid 쿠키로 압니다(middleware.ts). 이름표일 뿐이라 보안과는 무관합니다.
 * owner 는 예전 이름을 그대로 써서, 지금까지 저장된 값이 계속 보입니다.
 */
export const UID_COOKIE = "alphy_uid";
const OWNER = "owner";

export function uidFromCookie(cookie: string): string {
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === UID_COOKIE) {
      const v = decodeURIComponent(part.slice(i + 1).trim());
      return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(v) ? v : OWNER;
    }
  }
  return OWNER;
}

export function keyFor(base: string, uid: string): string {
  return uid === OWNER ? base : `${base}:${uid}`;
}

/** 지금 로그인한 사람의 저장 이름 */
export function userKey(base: string): string {
  return keyFor(base, typeof document === "undefined" ? OWNER : uidFromCookie(document.cookie));
}
