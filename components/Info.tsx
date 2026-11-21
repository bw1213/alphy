"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** 눌러야 펼쳐지는 짧은 도움말 (ⓘ). 화면에 늘 보일 필요 없는 설명을 여기에 넣음 */
export default function Info({ children, label = "ⓘ" }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) ref.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  return (
    <details ref={ref} className="info" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary aria-label="설명 보기" title="설명 보기">{label}</summary>
      <div className="info-body">{children}</div>
    </details>
  );
}
