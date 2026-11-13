/**
 * 코드 없이 전략 만들기: 화면에서 고른 조건(BuilderSpec)을 전략 코드와 파라미터로 바꾼다.
 * 만들어진 코드는 직접 작성한 전략과 똑같이 실행·저장되고, 숫자는 모두 파라미터(p.xxx)로 빠져서 민감도 검사도 된다.
 */
export type MetricId = "ret" | "maGap" | "maCross" | "rsi" | "vol" | "value" | "highRatio" | "lowRatio" | "price";

export interface MetricDef {
  id: MetricId;
  label: string;
  /** 값의 단위 */
  unit: string;
  /** 기간 입력 개수 (0, 1, 2) */
  periods: 0 | 1 | 2;
  defaults: { n: number; m: number; value: number };
  help: string;
  /** ctx 표현식. n, m 은 파라미터 이름 */
  expr: (n: string, m: string) => string;
}

export const METRICS: MetricDef[] = [
  { id: "ret", label: "수익률", unit: "%", periods: 1, defaults: { n: 120, m: 0, value: 0 },
    help: "최근 n일 동안 오른 비율", expr: (n) => `ctx.ret(t, ${n}) * 100` },
  { id: "maGap", label: "이동평균선 대비 주가", unit: "%", periods: 1, defaults: { n: 60, m: 0, value: 0 },
    help: "종가가 n일 이동평균선보다 몇 % 위에 있는지 (0 이상 = 이평선 위)", expr: (n) => `(ctx.close(t) / ctx.sma(t, ${n}) - 1) * 100` },
  { id: "maCross", label: "단기 이평선 대비 장기 이평선", unit: "%", periods: 2, defaults: { n: 20, m: 60, value: 0 },
    help: "n일 이평선이 m일 이평선보다 몇 % 위에 있는지 (0 이상 = 정배열)", expr: (n, m) => `(ctx.sma(t, ${n}) / ctx.sma(t, ${m}) - 1) * 100` },
  { id: "rsi", label: "RSI", unit: "", periods: 1, defaults: { n: 14, m: 0, value: 30 },
    help: "0~100. 보통 30 이하는 과매도, 70 이상은 과매수", expr: (n) => `ctx.rsi(t, ${n})` },
  { id: "vol", label: "변동성", unit: "%", periods: 1, defaults: { n: 60, m: 0, value: 3 },
    help: "최근 n일 하루 등락률의 표준편차. 낮을수록 덜 출렁임", expr: (n) => `ctx.volatility(t, ${n}) * 100` },
  { id: "value", label: "하루 거래대금", unit: "억원", periods: 1, defaults: { n: 20, m: 0, value: 10 },
    help: "최근 n일 평균 거래대금. 너무 작은 종목을 거를 때", expr: (n) => `ctx.tradingValue(t, ${n}) / 1e8` },
  { id: "highRatio", label: "최고가 대비 현재가", unit: "%", periods: 1, defaults: { n: 250, m: 0, value: 95 },
    help: "최근 n일 최고 종가의 몇 % 수준인지 (100 = 신고가)", expr: (n) => `ctx.close(t) / ctx.highest(t, ${n}, "close") * 100` },
  { id: "lowRatio", label: "최저가 대비 현재가", unit: "%", periods: 1, defaults: { n: 250, m: 0, value: 120 },
    help: "최근 n일 최저 종가의 몇 % 수준인지 (100 = 신저가)", expr: (n) => `ctx.close(t) / ctx.lowest(t, ${n}, "close") * 100` },
  { id: "price", label: "주가", unit: "원", periods: 0, defaults: { n: 0, m: 0, value: 1000 },
    help: "오늘 종가", expr: () => `ctx.close(t)` },
];
const metric = (id: string) => METRICS.find((m) => m.id === id) ?? METRICS[0];

export interface Condition { metric: MetricId; n: number; m: number; op: ">=" | "<="; value: number }

export interface BuilderSpec {
  /** KOSPI 지수가 marketMa 일 이평선 아래면 전량 현금 (0 = 끔) */
  marketMa: number;
  /** 모두 만족하는 종목만 */
  filters: Condition[];
  /** 남은 종목을 이 기준으로 줄 세움 */
  rank: { metric: MetricId; n: number; m: number; dir: "desc" | "asc" };
  topK: number;
}

export const defaultSpec = (): BuilderSpec => ({
  marketMa: 120,
  filters: [
    { metric: "value", n: 20, m: 0, op: ">=", value: 10 },
    { metric: "maGap", n: 60, m: 0, op: ">=", value: 0 },
  ],
  rank: { metric: "ret", n: 120, m: 0, dir: "desc" },
  topK: 10,
});

const int = (v: unknown, lo: number, hi: number, d: number) => {
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d;
};

/** 저장된 값·화면 입력을 안전한 범위로 정리 */
export function normalizeSpec(x: any): BuilderSpec {
  const d = defaultSpec();
  const periods = (id: MetricId, n: unknown, m: unknown) => {
    const md = metric(id);
    return { n: md.periods >= 1 ? int(n, 1, 500, md.defaults.n) : 0, m: md.periods === 2 ? int(m, 1, 500, md.defaults.m) : 0 };
  };
  const filters: Condition[] = (Array.isArray(x?.filters) ? x.filters : d.filters).slice(0, 8).map((c: any) => {
    const id = metric(c?.metric).id;
    const v = Number(c?.value);
    return { metric: id, ...periods(id, c?.n, c?.m), op: c?.op === "<=" ? "<=" : ">=", value: Number.isFinite(v) ? v : metric(id).defaults.value };
  });
  const rid = metric(x?.rank?.metric ?? d.rank.metric).id;
  return {
    marketMa: int(x?.marketMa, 0, 500, d.marketMa),
    filters,
    rank: { metric: rid, ...periods(rid, x?.rank?.n, x?.rank?.m), dir: x?.rank?.dir === "asc" ? "asc" : "desc" },
    topK: int(x?.topK, 1, 50, d.topK),
  };
}

const describeMetric = (id: MetricId, n: number, m: number) => {
  const md = metric(id);
  if (md.periods === 0) return md.label;
  if (md.periods === 2) return `${n}일 이평선이 ${m}일 이평선보다 높은 정도`;
  return `${n}일 ${md.label}`;
};

export interface Generated { code: string; params: Record<string, number>; warmup: number; summary: string[] }

/** 조건 → 전략 코드 + 파라미터 + 필요한 워밍업 일수 + 사람이 읽는 설명 */
export function generate(input: BuilderSpec): Generated {
  const s = normalizeSpec(input);
  const params: Record<string, number> = { topK: s.topK };
  const lines: string[] = ["// 조건 고르기로 만든 전략 (숫자는 아래 파라미터에서 바뀝니다)"];
  const summary: string[] = [];
  let maxPeriod = 1;
  const use = (v: number) => { maxPeriod = Math.max(maxPeriod, v); };

  if (s.marketMa > 0) {
    params.marketMa = s.marketMa; use(s.marketMa);
    lines.push("if (ctx.bench() < ctx.benchSma(p.marketMa)) return {};   // 시장이 약하면 전량 현금");
    summary.push(`KOSPI 지수가 ${s.marketMa}일 이동평균선 아래면 주식을 모두 팔고 현금으로 둡니다.`);
  }
  const conds: string[] = [];
  s.filters.forEach((c, k) => {
    const md = metric(c.metric), i = k + 1;
    if (md.periods >= 1) { params[`c${i}n`] = c.n; use(c.n); }
    if (md.periods === 2) { params[`c${i}m`] = c.m; use(c.m); }
    params[`c${i}v`] = c.value;
    conds.push(`${md.expr(`p.c${i}n`, `p.c${i}m`)} ${c.op} p.c${i}v`);
    summary.push(`거르기: ${describeMetric(c.metric, c.n, c.m)} ${c.value}${md.unit} ${c.op === ">=" ? "이상" : "이하"}인 종목만 남깁니다.`);
  });
  const rm = metric(s.rank.metric);
  if (rm.periods >= 1) { params.rankN = s.rank.n; use(s.rank.n); }
  if (rm.periods === 2) { params.rankM = s.rank.m; use(s.rank.m); }
  const score = rm.expr("p.rankN", "p.rankM");
  lines.push("const picks = ctx.topBy(");
  lines.push(`  (t) => ${s.rank.dir === "desc" ? "" : "-("}${score}${s.rank.dir === "desc" ? "" : ")"},   // 줄 세우는 기준`);
  lines.push("  p.topK,");
  if (conds.length) {
    lines.push("  (t) =>");
    conds.forEach((c, k) => lines.push(`    ${c}${k < conds.length - 1 ? " &&" : ","}`));
  }
  lines.push(");");
  lines.push("return ctx.equal(picks);   // 같은 비중으로 보유");
  summary.push(`고르기: 남은 종목을 ${describeMetric(s.rank.metric, s.rank.n, s.rank.m)} ${s.rank.dir === "desc" ? "높은" : "낮은"} 순으로 줄 세워 위에서 ${s.topK}종목을 같은 비중으로 보유합니다.`);
  // 최고가·변동성 등은 n 일치 데이터가 있어야 하므로 가장 긴 기간 + 여유
  return { code: lines.join("\n"), params, warmup: maxPeriod + 2, summary };
}
