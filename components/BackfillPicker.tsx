"use client";

import { PROXIES, proxyCurrency, proxyName, suggestSpec } from "@/lib/data/backfill";
import { AUTO_PICK as AUTO, type BackfillPick, type BackfillState } from "@/lib/data/backfillPick";
import { isUsTicker } from "@/lib/data/market";
import Info from "./Info";
import { useNameOf } from "./StockSearch";
import { withCode } from "@/lib/strategies/universe";

const groups = [...new Set(PROXIES.map((p) => p.group))];
const levText = (lev: number) => (lev === 1 ? "" : ` ×${lev}`);

export default function BackfillPicker({ tickers, value, onChange }: { tickers: string[]; value: BackfillState; onChange: (v: BackfillState) => void }) {
  const set = (t: string, p: Partial<BackfillPick>) => onChange({ ...value, picks: { ...value.picks, [t]: { ...(value.picks[t] ?? AUTO), ...p } } });
  const nameOf = useNameOf(tickers);
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        상장 전 기간은 지수로 채우기
      </label>
      {value.on && (
        <>
          <p className="help">시작일보다 늦게 상장한 종목만 채웁니다. 참고용입니다.<Info>상장 전 기간을 고른 지수의 하루 움직임으로 이어 붙입니다. 레버리지·인버스는 하루 수익률 × 배수에서 금리 비용과 보수를 뺍니다. 미국 지수는 그날 환율로 원화로 바꾸고, 환헤지(H)를 켜면 달러 수익률을 그대로 씁니다. 커버드콜·액티브처럼 지수와 운용 방식이 다른 ETF 는 비슷하게만 따라갑니다. 자동 매매는 실제 시세만 씁니다.</Info></p>
          {tickers.map((t) => {
            const p = value.picks[t] ?? AUTO;
            const sug = suggestSpec(t);
            const autoLabel = sug ? `자동: ${proxyName(sug.chain[0])}${levText(sug.lev)}${sug.hedged ? " (H)" : ""}` : "자동: 이름으로 추정";
            const canHedge = !isUsTicker(t) && p.proxy !== "auto" && p.proxy !== "none" && proxyCurrency(p.proxy) === "USD";
            return (
              <div key={t} className="row" style={{ marginTop: 6, alignItems: "flex-end" }}>
                <label className="f" style={{ flex: "2 1 220px" }}>{withCode(nameOf(t), t)}
                  <select value={p.proxy} onChange={(e) => {
                    const v = e.target.value;
                    // 직접 고를 땐 이 종목의 기본 배수·보수를 먼저 채워 둠
                    const keep = p.proxy === "auto" || p.proxy === "none";
                    set(t, keep && sug ? { proxy: v, lev: String(sug.lev), fee: String(sug.fee), hedged: !!sug.hedged } : { proxy: v });
                  }}>
                    <option value="auto">{autoLabel}</option>
                    <option value="none">채우지 않음</option>
                    {groups.map((g) => (
                      <optgroup key={g} label={g}>
                        {PROXIES.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                {p.proxy !== "auto" && p.proxy !== "none" && (
                  <>
                    <label className="f" style={{ flex: "1 1 70px" }}>배수<input value={p.lev} placeholder="1" onChange={(e) => set(t, { lev: e.target.value })} /></label>
                    <label className="f" style={{ flex: "1 1 70px" }}>보수 %/년<input value={p.fee} placeholder="0" onChange={(e) => set(t, { fee: e.target.value })} /></label>
                    {canHedge && (
                      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, paddingBottom: 8 }}>
                        <input type="checkbox" style={{ width: "auto", flex: "none" }} checked={p.hedged} onChange={(e) => set(t, { hedged: e.target.checked })} />환헤지
                      </label>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
