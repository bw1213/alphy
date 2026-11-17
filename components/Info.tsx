import type { ReactNode } from "react";

/** 눌러야 펼쳐지는 짧은 도움말 (ⓘ). 화면에 늘 보일 필요 없는 설명을 여기에 넣음 */
export default function Info({ children, label = "ⓘ" }: { children: ReactNode; label?: string }) {
  return (
    <details className="info">
      <summary aria-label="설명 보기" title="설명 보기">{label}</summary>
      <div className="info-body">{children}</div>
    </details>
  );
}
