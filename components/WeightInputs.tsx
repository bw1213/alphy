"use client";
/** 종목별 비중(%) 입력. 값은 { "w_종목코드": 비중 } 형태로 전략 파라미터에 들어감 */
export function WeightInputs({ tickers, value, onChange, names }: {
  tickers: string[];
  value: Record<string, number | undefined>;
  onChange: (next: Record<string, number | undefined>) => void;
  names?: Record<string, string>;
}) {
  if (!tickers.length) return <p className="help">종목을 직접 입력하면 종목별 비중을 정할 수 있습니다.</p>;
  const set = tickers.some((t) => value["w_" + t] !== undefined);
  const sum = tickers.reduce((a, t) => a + (Number(value["w_" + t]) || 0), 0);
  const equal = Math.round((100 / tickers.length) * 10) / 10;
  return (
    <>
      <h3>종목별 비중 (%)</h3>
      <div className="row3">
        {tickers.map((t) => (
          <label className="f" key={t}>{names?.[t] ? `${names[t]} (${t})` : t}
            <input type="number" min={0} max={100} step={5} placeholder={set ? "0" : String(equal)}
              value={value["w_" + t] ?? ""}
              onChange={(e) => {
                const next = { ...value };
                if (e.target.value === "") delete next["w_" + t]; else next["w_" + t] = Number(e.target.value);
                onChange(next);
              }} />
          </label>
        ))}
      </div>
      <p className="help">{set ? `합계 ${sum}%${sum < 100 ? " (나머지는 현금)" : sum > 100 ? " (100%를 넘습니다)" : ""}` : "비우면 똑같이 나눕니다."}</p>
    </>
  );
}
