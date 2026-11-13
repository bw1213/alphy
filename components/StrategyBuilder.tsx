"use client";

import { METRICS, generate, type BuilderSpec, type Condition, type MetricId } from "@/lib/strategies/builder";

const chk = { width: "auto", flex: "none" } as const;
const small = { width: 70 } as const;

/** 지표 + 기간 입력 (조건과 순위 기준이 같이 씀) */
function MetricPick({ metric, n, m, onChange }: {
  metric: MetricId; n: number; m: number; onChange: (v: { metric: MetricId; n: number; m: number }) => void;
}) {
  const md = METRICS.find((x) => x.id === metric)!;
  return (
    <>
      <select value={metric} style={{ flex: "1 1 150px", minWidth: 0 }} onChange={(e) => {
        const d = METRICS.find((x) => x.id === e.target.value)!;
        onChange({ metric: d.id, n: d.defaults.n, m: d.defaults.m });
      }}>
        {METRICS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      {md.periods >= 1 && <label className="inl"><input type="number" min={1} max={500} style={small} value={n} onChange={(e) => onChange({ metric, n: Number(e.target.value), m })} />일</label>}
      {md.periods === 2 && <label className="inl">÷<input type="number" min={1} max={500} style={small} value={m} onChange={(e) => onChange({ metric, n, m: Number(e.target.value) })} />일</label>}
    </>
  );
}

/** 코드 없이 조건을 골라 전략을 만드는 화면 */
export default function StrategyBuilder({ spec, onChange }: { spec: BuilderSpec; onChange: (s: BuilderSpec) => void }) {
  const set = (patch: Partial<BuilderSpec>) => onChange({ ...spec, ...patch });
  const setFilter = (k: number, patch: Partial<Condition>) => set({ filters: spec.filters.map((c, i) => (i === k ? { ...c, ...patch } : c)) });
  const g = generate(spec);
  const row = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 } as const;

  return (
    <div className="builder">
      <h3>1. 시장이 나쁠 때</h3>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
        <input type="checkbox" style={chk} checked={spec.marketMa > 0} onChange={(e) => set({ marketMa: e.target.checked ? 120 : 0 })} />
        KOSPI 지수가
        {spec.marketMa > 0 && <input type="number" min={5} max={500} style={small} value={spec.marketMa} onChange={(e) => set({ marketMa: Number(e.target.value) })} />}
        {spec.marketMa > 0 ? "일 이동평균선 아래면 모두 팔고 현금" : "이동평균선 아래면 모두 팔고 현금 (꺼짐)"}
      </label>

      <h3>2. 종목 거르기 <span className="help" style={{ fontWeight: 400 }}>모두 만족하는 종목만 남깁니다</span></h3>
      {spec.filters.length === 0 && <p className="help">조건 없음: 모든 종목이 후보입니다.</p>}
      {spec.filters.map((c, k) => {
        const md = METRICS.find((x) => x.id === c.metric)!;
        return (
          <div key={k}>
            <div style={row}>
              <MetricPick metric={c.metric} n={c.n} m={c.m} onChange={(v) => setFilter(k, { ...v, value: METRICS.find((x) => x.id === v.metric)!.defaults.value })} />
              <label className="inl"><input type="number" step="any" style={{ width: 84 }} value={c.value} onChange={(e) => setFilter(k, { value: Number(e.target.value) })} />{md.unit}</label>
              <select value={c.op} style={{ width: 74, flex: "none" }} onChange={(e) => setFilter(k, { op: e.target.value as Condition["op"] })}>
                <option value=">=">이상</option><option value="<=">이하</option>
              </select>
              <button className="link" title="이 조건 지우기" onClick={() => set({ filters: spec.filters.filter((_, i) => i !== k) })}>지우기</button>
            </div>
            <p className="help" style={{ margin: "2px 0 0" }}>{md.help}</p>
          </div>
        );
      })}
      {spec.filters.length < 8 && (
        <button style={{ marginTop: 8 }} onClick={() => set({ filters: [...spec.filters, { metric: "ret", n: 120, m: 0, op: ">=", value: 0 }] })}>+ 조건 추가</button>
      )}

      <h3>3. 남은 종목 중 고르기</h3>
      <div style={row}>
        <MetricPick metric={spec.rank.metric} n={spec.rank.n} m={spec.rank.m} onChange={(v) => set({ rank: { ...spec.rank, ...v } })} />
        <select value={spec.rank.dir} style={{ width: 100, flex: "none" }} onChange={(e) => set({ rank: { ...spec.rank, dir: e.target.value as "desc" | "asc" } })}>
          <option value="desc">높은 순</option><option value="asc">낮은 순</option>
        </select>
        <label className="inl">상위<input type="number" min={1} max={50} style={small} value={spec.topK} onChange={(e) => set({ topK: Number(e.target.value) })} />종목</label>
      </div>
      <p className="help" style={{ margin: "2px 0 0" }}>{METRICS.find((x) => x.id === spec.rank.metric)!.help}. 고른 종목은 같은 비중으로 나눠 삽니다.</p>

      <div className="notice" style={{ marginTop: 12 }}>
        <b>이 전략은 이렇게 움직입니다</b>
        <ul>{g.summary.map((t, k) => <li key={k}>{t}</li>)}</ul>
      </div>
    </div>
  );
}
