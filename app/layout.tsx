import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "KOSPI 백테스트", description: "내 전략으로 KOSPI 종목 백테스트" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
