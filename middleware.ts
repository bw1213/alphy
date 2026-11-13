/**
 * 앱 전체 로그인 잠금. 밖(인터넷)에서 접속해도 로그인하기 전에는 아무 화면·API 도 열리지 않습니다.
 * 로그인 없이 열리는 것: /login, /api/auth(로그인 처리), /api/health(상태 확인), 정적 파일, robots.txt
 *
 * Node.js 런타임에서 돌려서 설정 파일(쿠키 서명 키)을 그대로 읽습니다 (Next.js 15.5+).
 */
import { NextResponse, type NextRequest } from "next/server";
import { isLoggedIn } from "@/lib/settings/auth";

const PUBLIC = [/^\/login\/?$/, /^\/api\/auth\/?$/, /^\/api\/health\/?$/, /^\/robots\.txt$/];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname)) || isLoggedIn(req)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  // 주소는 그대로 두고 로그인 화면을 보여 줌(rewrite). 로그인하면 그 화면이 다시 열림.
  // 리다이렉트를 쓰지 않는 이유: 역방향 프록시 뒤에서는 앱이 바깥 주소(https://도메인)를 정확히 모를 수 있음
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.rewrite(url, { headers: { "Cache-Control": "no-store" } });
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
