"use client";

import { useEffect, useState } from "react";

export function useDragZoom(dates: string[]) {
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<[string, string] | null>(null);
  useEffect(() => { setZoom(null); setDrag(null); }, [dates]);

  const label = (st: any) => (st?.activeLabel == null ? null : String(st.activeLabel));
  const handlers = {
    onMouseDown: (st: any) => { const d = label(st); if (d) setDrag([d, d]); },
    onMouseMove: (st: any) => { const d = label(st); if (drag && d && d !== drag[1]) setDrag([drag[0], d]); },
    onMouseUp: () => {
      if (drag) {
        let a = dates.indexOf(drag[0]), b = dates.indexOf(drag[1]);
        if (a > b) [a, b] = [b, a];
        if (a >= 0 && b - a >= 5) setZoom([a, b]);
      }
      setDrag(null);
    },
    onMouseLeave: () => setDrag(null),
  };
  const focus = (i0: number, i1: number) => {
    const pad = Math.max(10, Math.round((i1 - i0) * 0.15));
    setZoom([Math.max(0, i0 - pad), Math.min(dates.length - 1, i1 + pad)]);
  };
  const slice = <T,>(a: T[]): T[] => (zoom ? a.slice(zoom[0], zoom[1] + 1) : a);
  const sel = drag && drag[0] !== drag[1] ? (drag[0] < drag[1] ? drag : [drag[1], drag[0]]) : null;
  return { zoom, setZoom, focus, slice, handlers, sel };
}

export function ZoomBar({ dates, zoom, onReset }: { dates: string[]; zoom: [number, number] | null; onReset: () => void }) {
  if (!zoom) return <p className="help" style={{ margin: "2px 0 6px" }}>그래프를 끌면 그 구간을 확대합니다.</p>;
  return (
    <p className="help" style={{ margin: "2px 0 6px" }}>
      <b>{dates[zoom[0]]} ~ {dates[zoom[1]]}</b> 확대 중 (자산 추이는 이 구간 시작 = 100) · <button className="link" onClick={onReset}>전체 보기</button>
    </p>
  );
}

export function rebase<T extends Record<string, any>>(rows: T[], keys: string[]): T[] {
  const base: Record<string, number> = {};
  for (const k of keys) {
    const r = rows.find((x) => typeof x[k] === "number" && Number.isFinite(x[k]));
    if (r) base[k] = r[k];
  }
  return rows.map((r) => {
    const o: Record<string, any> = { ...r };
    for (const k of keys) if (base[k] && typeof o[k] === "number") o[k] = (o[k] / base[k]) * 100;
    return o as T;
  });
}
