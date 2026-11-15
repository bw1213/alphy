"use client";
/**
 * 종목 이름으로 찾아 코드를 넣는 입력칸, 넣은 코드의 이름을 보여 주는 칩.
 * 검색은 /api/stocks?q= (이름·코드·초성), 이름 조회는 /api/stocks?codes=
 */
import { useEffect, useRef, useState } from "react";

export interface StockItem { code: string; name: string; market: string; type?: string }

const tag = (s: StockItem) => [s.market, s.type && s.type !== "주식" && s.type !== "stock" ? s.type.toUpperCase() === "ETF" ? "ETF" : s.type : ""].filter(Boolean).join(" · ");

export function StockSearch({ onPick, placeholder = "종목 이름으로 찾기 (예: 삼성전자, KODEX 200, ㅅㅅㅈㅈ)", exclude = [], keepOpen = false }: {
  onPick: (s: StockItem) => void;
  placeholder?: string;
  /** 이미 넣은 코드 (목록에서 표시만 흐리게) */
  exclude?: string[];
  /** 고른 뒤에도 입력칸을 비우고 계속 찾기 */
  keepOpen?: boolean;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<StockItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setItems([]); setErr(""); return; }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/stocks?q=${encodeURIComponent(term)}`);
        const j = await r.json();
        if (my !== seq.current) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setItems(j.items ?? []); setActive(0); setErr("");
      } catch (e) { if (my === seq.current) { setItems([]); setErr((e as Error).message); } }
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (s: StockItem) => {
    onPick(s);
    setQ(""); setItems([]);
    setOpen(keepOpen);
  };

  const ex = new Set(exclude.map((c) => c.toUpperCase()));
  return (
    <div className="ssearch" ref={box}>
      <input value={q} placeholder={placeholder} autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={open && items.length > 0} aria-autocomplete="list"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && items[active]) { e.preventDefault(); pick(items[active]); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && q.trim() && (
        <ul className="ssearch-list" role="listbox">
          {items.map((s, i) => (
            <li key={`${s.market}:${s.code}`} role="option" aria-selected={i === active} className={`${i === active ? "on" : ""}${ex.has(s.code.toUpperCase()) ? " dim" : ""}`}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(s); }}>
              <span className="nm">{s.name}</span>
              <span className="cd">{s.code}</span>
              <span className="mk">{tag(s)}{ex.has(s.code.toUpperCase()) ? " · 넣음" : ""}</span>
            </li>
          ))}
          {!items.length && <li className="empty">{err ? `찾지 못했습니다: ${err}` : "맞는 종목이 없습니다"}</li>}
        </ul>
      )}
    </div>
  );
}

/** 쉼표·공백으로 나눈 종목코드 목록 */
export const splitCodes = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);

/** 코드 → 이름 (한 번 받은 이름은 기억) */
const nameCache = new Map<string, StockItem | null>();
export function useStockNames(codes: string[]): Record<string, StockItem | null> {
  const [, bump] = useState(0);
  const key = codes.map((c) => c.toUpperCase()).join(",");
  useEffect(() => {
    const need = [...new Set(key.split(",").filter((c) => c && !nameCache.has(c)))];
    if (!need.length) return;
    let alive = true;
    fetch(`/api/stocks?codes=${encodeURIComponent(need.join(","))}`).then((r) => r.ok ? r.json() : { items: [] }).then((j) => {
      const got = new Map<string, StockItem>((j.items ?? []).map((s: StockItem) => [s.code.toUpperCase(), s]));
      for (const c of need) nameCache.set(c, got.get(c) ?? null);
      if (alive) bump((n) => n + 1);
    }).catch(() => { /* 이름만 못 보여 줌 */ });
    return () => { alive = false; };
  }, [key]);
  const out: Record<string, StockItem | null> = {};
  for (const c of codes) { const v = nameCache.get(c.toUpperCase()); if (v !== undefined) out[c] = v; }
  return out;
}

/** 쉼표로 적은 종목코드를 이름 칩으로 보여 주고 × 로 뺄 수 있게 */
export function StockChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const codes = splitCodes(value);
  const names = useStockNames(codes);
  if (!codes.length) return null;
  return (
    <div className="schips">
      {codes.map((c, i) => {
        const s = names[c];
        return (
          <span key={`${c}-${i}`} className={`schip${s === null ? " unknown" : ""}`} title={s === null ? "목록에 없는 코드입니다. 코드가 맞는지 확인하세요." : s?.market}>
            {s ? s.name : s === null ? "모르는 코드" : "…"} <b>{c}</b>
            <button type="button" aria-label={`${c} 빼기`} onClick={() => onChange(codes.filter((_, k) => k !== i).join(", "))}>×</button>
          </span>
        );
      })}
    </div>
  );
}

/** 목록 문자열에 코드 하나 더하기 (이미 있으면 그대로) */
export function appendCode(value: string, code: string): string {
  const codes = splitCodes(value);
  if (codes.some((c) => c.toUpperCase() === code.toUpperCase())) return codes.join(", ");
  return [...codes, code].join(", ");
}
