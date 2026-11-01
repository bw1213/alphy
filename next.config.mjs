/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Docker 이미지용: .next/standalone 에 실행에 필요한 파일만 모음
  output: "standalone",
};
