/**
 * 밖(인터넷)에서 접속할 때를 위한 보안 헤더.
 * 스크립트 제한(CSP script-src)은 넣지 않음: 사용자 전략 코드를 브라우저에서 new Function 으로 실행하기 때문.
 */
const securityHeaders = [
  // 다른 사이트가 알피 화면을 몰래 틀(iframe)에 넣어 클릭을 유도하지 못하게
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // HTTPS 로 접속했을 때만 브라우저가 기억함 (http://NAS-IP:3000 에는 영향 없음)
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  // 검색 엔진에 올라가지 않게
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Docker 이미지용: .next/standalone 에 실행에 필요한 파일만 모음
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
