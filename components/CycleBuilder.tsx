"use client";

import { describeCycle, type CycleSpec, type Unit } from "@/lib/strategies/cycle";

const small = { width: 90 } as const;
const row = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6, fontSize: 13 } as const;

function UnitPick({ value, onChange, pctLabel = "총자산의 %", wonLabel = "원" }: {
  value: Unit; onChange: (u: Unit) => void; pctLabel?: string; wonLabel?: string;
}) {
  return (
    <select value={value} style={{ width: 120, flex: "none" }} onChange={(e) => onChange(e.target.value as Unit)}>
      <option value="pct">{pctLabel}</option><option value="won">{wonLabel}</option>
    </select>
  );
}
const Num = ({ value, onChange, step = "any", min = 0 }: { value: number; onChange: (v: number) => void; step?: string | number; min?: number }) => (
  <input type="number" min={min} step={step} style={small} value={value} onChange={(e) => onChange(Number(e.target.value))} />
);

/** 적립 매수 + 하락 시 분할 매도 전략을 숫자만 넣어 만드는 화면 */
export default function CycleBuilder({ spec, onChange }: { spec: CycleSpec; onChange: (s: CycleSpec) => void }) {
  const set = <K extends keyof CycleSpec>(k: K, patch: Partial<CycleSpec[K]>) => onChange({ ...spec, [k]: { ...spec[k], ...patch } });
  const fallUnit = spec.drop.unit === "pct" ? "%" : "원(주당)";

  return (
    <div className="builder">
      <p className="help">아래 &quot;기간 · 종목&quot;의 <b>종목 직접 입력</b>에 넣은 종목마다 따로 적용됩니다(예: KODEX 200 = 069500). 매일 종가로 판단하고 다음 거래일 시가에 매매합니다.</p>

      <h3>1. 적립 매수</h3>
      <div style={row}>
        <select value={spec.buy.period} style={{ width: 130, flex: "none" }} onChange={(e) => set("buy", { period: e.target.value as CycleSpec["buy"]["period"] })}>
          <option value="W">매주</option><option value="M">매월</option><option value="Q">분기마다</option><option value="days">N영업일마다</option>
        </select>
        {spec.buy.period === "days" && <label className="inl"><Num value={spec.buy.days} min={1} step={1} onChange={(v) => set("buy", { days: v })} />영업일마다</label>}
        <UnitPick value={spec.buy.unit} onChange={(u) => set("buy", { unit: u, value: u === "pct" ? 5 : 500_000 })} />
        <Num value={spec.buy.value} onChange={(v) => set("buy", { value: v })} />{spec.buy.unit === "pct" ? "%" : "원"} 매수
      </div>

      <h3>2. 떨어지면 매도</h3>
      <div style={row}>
        최고가 대비
        <UnitPick value={spec.drop.unit} pctLabel="% 하락" wonLabel="원 하락(주당)"
          onChange={(u) => set("drop", u === "pct" ? { unit: u, value: 10, step: 5 } : { unit: u, value: 5000, step: 2500 })} />
        <Num value={spec.drop.value} onChange={(v) => set("drop", { value: v })} />{fallUnit} 이상 떨어지면
      </div>
      <div style={row}>
        <UnitPick value={spec.sell.unit} onChange={(u) => set("sell", { unit: u, value: u === "pct" ? 20 : 1_000_000 })} />
        <Num value={spec.sell.value} onChange={(v) => set("sell", { value: v })} />{spec.sell.unit === "pct" ? "%" : "원"} 매도 (매수는 멈춤)
      </div>
      <div style={row}>
        그 뒤 <Num value={spec.drop.step} onChange={(v) => set("drop", { step: v })} />{fallUnit} 더 떨어질 때마다 같은 금액 추가 매도, 최대
        <Num value={spec.drop.maxSteps} min={0} step={1} onChange={(v) => set("drop", { maxSteps: v })} />번 (0 = 다 팔 때까지)
      </div>
      <div style={row}>
        최고가 기준:
        <select value={spec.drop.peakDays > 0 ? "n" : "cycle"} style={{ width: 200, flex: "none" }}
          onChange={(e) => set("drop", { peakDays: e.target.value === "n" ? 250 : 0 })}>
          <option value="cycle">매수 사이클 시작 이후 최고 종가</option><option value="n">최근 N영업일 최고 종가</option>
        </select>
        {spec.drop.peakDays > 0 && <label className="inl"><Num value={spec.drop.peakDays} min={1} step={1} onChange={(v) => set("drop", { peakDays: v })} />영업일</label>}
      </div>

      <h3>3. 안정되면 다시 적립 <span className="help" style={{ fontWeight: 400 }}>켠 조건을 모두 만족하면 (0 = 안 봄)</span></h3>
      <div style={row}>바닥(최저 종가)에서 <Num value={spec.stable.rebound} onChange={(v) => set("stable", { rebound: v })} />% 이상 반등</div>
      <div style={row}>바닥 이후 <Num value={spec.stable.calmDays} min={0} step={1} onChange={(v) => set("stable", { calmDays: v })} />영업일 동안 신저가 없음</div>
      <div style={row}>종가가 <Num value={spec.stable.ma} min={0} step={1} onChange={(v) => set("stable", { ma: v })} />일 이동평균선 위</div>

      <div className="notice" style={{ marginTop: 12 }}>
        <b>이 전략은 이렇게 움직입니다</b>
        <ul>{describeCycle(spec).map((t, k) => <li key={k}>{t}</li>)}</ul>
        <p className="help" style={{ margin: 0 }}>매수는 현금 안에서 합니다. 매달 새 돈을 넣으려면 아래 &quot;자금 · 비용&quot;의 <b>매달 추가 입금</b>을 쓰세요. 현금이 다 떨어지면 적립은 쉬고, 입금이나 매도로 현금이 생기면 다시 삽니다.</p>
      </div>
    </div>
  );
}
