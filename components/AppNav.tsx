"use client";

import { useEffect, useState, type ReactNode } from "react";

const LINKS = [
  { href: "/dashboard", label: "전체 계좌", icon: "M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z" },
  { href: "/accounts", label: "계좌", icon: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm0 3h18M7 15h4" },
  { href: "/", label: "백테스트", icon: "M4 19V5m0 14h16M8 15l3-4 3 2 5-6" },
  { href: "/settings", label: "설정", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.4a7.6 7.6 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z" },
];

const isOn = (href: string, path: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

export default function AppNav({ title, sub, extra }: { title: ReactNode; sub?: ReactNode; extra?: ReactNode }) {
  const [path, setPath] = useState("");
  useEffect(() => setPath(window.location.pathname), []);
  return (
    <>
      <header className="top">
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
        <nav className="topnav" aria-label="화면">
          {LINKS.map((l) => <a key={l.href} href={l.href} aria-current={isOn(l.href, path) ? "page" : undefined}>{l.label}</a>)}
          {extra}
        </nav>
        {extra ? <span className="topextra">{extra}</span> : null}
      </header>
      <nav className="tabbar" aria-label="화면">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} aria-current={isOn(l.href, path) ? "page" : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={l.icon} /></svg>
            <span>{l.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
