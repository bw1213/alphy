"use client";

import { useState } from "react";
import { FAMILIES, type Candidate } from "@/lib/finder/candidates";
import { type FinderReport } from "@/lib/finder/search";
import Info from "./Info";

const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`);
const VERDICT = {
  high: { label: "비교적 믿을 만함", cls: "ok" },
  mid: { label: "보통 (일부 점검 통과 못 함)", cls: "" },
  low: { label: "믿기 어려움 (과최적화 가능성 큼)", cls: "no" },
} as const;

export default function FinderResults({ report, holdName, onApply, onClose }: {
  report: FinderReport;
  /** 매수 후 보유 비교 대상 이름 (예: "3종목 똑같이") */
  holdName: string;
  onApply: (c: Candidate) => void;
  onClose: () => void;
}) {
  const r = report;
  const b = r.best;
  const h = r.hold;
  const [all, setAll] = useState(false);
  const v = VERDICT[r.verdict];
  const beatsHold = h ? b.test.cagr > h.test.cagr : null;
  const shown = all ? r.rows : r.rows.slice(0, 10);

  return (
    <div className="card finder">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>찾은 전략</h2>
        <span className={`badge ${v.cls}`}>믿을 수 있는 정도: {v.label}</span>
        <button className="link" style={{ marginLeft: "auto" }} onClick={onClose}>닫기</button>
      </div>
      <p className="desc" style={{ fontSize: 15, color: "var(--text)", marginTop: 8 }}><b>{b.c.name}</b><Info>{FAMILIES[b.c.family].help}</Info></p>
      <p className="help">후보 {r.tried}개 중 1등<Info>앞으로의 성과는 확인 구간 쪽에 가깝습니다.</Info></p>

      <div className="tablewrap" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr><th>구간</th><th>전략<br />연수익</th><th>전략<br />낙폭</th>{h && <><th>보유<br />연수익</th><th>보유<br />낙폭</th></>}</tr>
          </thead>
          <tbody>
            <tr><td>고르는 구간<span className="help period">{r.start} ~ {r.splitDate}</span></td><td>{pct(b.train.cagr)}</td><td>{pct(b.train.mdd)}</td>{h && <><td>{pct(h.train.cagr)}</td><td>{pct(h.train.mdd)}</td></>}</tr>
            <tr><td><b>확인 구간</b><span className="help period">{r.splitDate} ~ {r.end}</span></td><td><b>{pct(b.test.cagr)}</b></td><td>{pct(b.test.mdd)}</td>{h && <><td>{pct(h.test.cagr)}</td><td>{pct(h.test.mdd)}</td></>}</tr>
            <tr><td>전체</td><td>{pct(b.full.cagr)}</td><td>{pct(b.full.mdd)}</td>{h && <><td>{pct(h.full.cagr)}</td><td>{pct(h.full.mdd)}</td></>}</tr>
          </tbody>
        </table>
      </div>

      {beatsHold === false && (
        <div className="notice" style={{ marginTop: 10 }}>
          확인 구간에서는 이 전략이 매수 후 보유보다 못했습니다. 이 종목·기간에서는 사고팔기보다 그냥 들고 있는 편이 나았을 가능성이 큽니다.
        </div>
      )}

      <h3>점검</h3>
      <ul className="checks">
        {r.checks.map((c) => (
          <li key={c.label}><span className={`badge ${c.ok ? "ok" : "no"}`}>{c.ok ? "통과" : "못 함"}</span> {c.label} <span className="help">{c.detail}</span></li>
        ))}
      </ul>

      {r.walk && (
        <details style={{ marginTop: 8 }}>
          <summary>해마다 다시 고르기 결과 ({r.walk.years.length}년): 연 {pct(r.walk.cagr)}{r.walk.holdCagr != null && <> · 보유 연 {pct(r.walk.holdCagr)}</>}</summary>
          <p className="help">매년 1월 그때까지의 데이터로 1등을 골라 1년 썼다면의 결과입니다.</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th>연도</th><th className="l">그해 고른 전략</th><th>수익률</th><th>보유</th></tr></thead>
              <tbody>
                {r.walk.years.map((y) => (
                  <tr key={y.year}><td>{y.year}</td><td className="l" style={{ whiteSpace: "normal" }}>{y.pick}</td><td>{pct(y.ret)}</td><td>{pct(y.hold)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="btns" style={{ marginTop: 12 }}>
        <button className="primary" style={{ width: "auto" }} onClick={() => onApply(b.c)}>이 전략으로 백테스트 열기</button>
      </div>
      

      <h3>후보 순위 (고르는 구간 기준)</h3>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>순위</th><th className="l">전략</th><th>고르는 구간</th><th>낙폭</th><th>확인 구간</th><th>낙폭</th><th>전체</th><th>매매</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.c.id}>
                <td>{x.rank}</td>
                <td className="l" style={{ whiteSpace: "normal", minWidth: 220 }}>{x.c.name}</td>
                <td>{pct(x.train.cagr)}</td><td>{pct(x.train.mdd)}</td>
                <td>{pct(x.test.cagr)}</td><td>{pct(x.test.mdd)}</td>
                <td>{pct(x.full.cagr)}</td>
                <td>{x.trainTrades + x.testTrades}</td>
                <td><button className="link" onClick={() => onApply(x.c)}>열기</button></td>
              </tr>
            ))}
            {h && (
              <tr className="muted"><td>–</td><td className="l">매수 후 보유 ({holdName})</td><td>{pct(h.train.cagr)}</td><td>{pct(h.train.mdd)}</td><td>{pct(h.test.cagr)}</td><td>{pct(h.test.mdd)}</td><td>{pct(h.full.cagr)}</td><td>–</td><td></td></tr>
            )}
          </tbody>
        </table>
      </div>
      {r.rows.length > 10 && <p className="help"><button className="link" onClick={() => setAll(!all)}>{all ? "상위 10개만 보기" : `전체 ${r.rows.length}개 보기`}</button></p>}

      <div className="notice" style={{ marginTop: 12 }}>
        <b>꼭 읽어 주세요.</b> 과거 시세로 계산한 결과라 앞으로의 수익을 보장하지 않습니다. 실제 돈을 넣기 전에 모의투자로 먼저 확인하세요.
        <Info>후보를 많이 시험할수록 우연히 과거에만 잘 맞은 설정이 1등이 되기 쉬워서, 1등의 &quot;고르는 구간&quot; 수익률은 실제보다 부풀려져 있습니다. 확인 구간과 해마다 다시 고르기 결과를 함께 보세요.</Info>
      </div>
    </div>
  );
}
