# alphy — KOSPI 백테스트 웹

브라우저에서 전략을 고르거나 직접 코드로 작성해 KOSPI 종목 과거 성과를 확인하는 웹 서비스입니다.
Next.js 15 + TypeScript. 백테스트 계산은 브라우저에서, 시세 수집은 서버(API 라우트)에서 합니다.

## 실행
Node.js 20 이상이 필요합니다.
```bash
npm install
npm run dev          # 개발 모드 → http://localhost:3000
# 또는
npm run build && npm start
npm test             # 엔진 테스트 (11개)
```

**Synology NAS / Docker:** `docker compose up -d --build` → http://NAS-IP:3000. 자세한 순서는 [docs/synology.md](docs/synology.md).

## 화면 구성
- **전략**: 기본 제공 3개(모멘텀+시장필터, 이동평균 정배열, RSI 과매도 반등) 중 선택하고 파라미터 조절
- **내 전략**: JavaScript 코드로 직접 작성. "이 전략의 코드를 열어 직접 수정하기"로 기본 전략을 복사해서 시작할 수 있고, 브라우저에 저장됩니다
- **운용 규칙**: 리밸런싱 주기(매일/매주/매월/분기), 손절·익절 %
- **결과**: CAGR(목표 30% 달성 여부), MDD, 샤프, 승률, 자산 곡선(KOSPI·연 30% 목표선 비교), 낙폭, 연도별 수익률, 매매 내역(CSV 다운로드), 현재 보유 종목

## 내 전략 코드 작성법
장 마감 후 호출되며 `{ 종목코드: 비중 }`을 반환하면 다음 영업일 시가에 그 비중으로 매매합니다.
`{}`는 전량 현금, `null`은 이번엔 매매 안 함입니다.
```js
// 20일 수익률 상위 p.k 종목 동일비중, KOSPI 120일선 아래면 현금
if (ctx.bench() < ctx.benchSma(120)) return {};
return ctx.equal(ctx.topBy((t) => ctx.ret(t, 20), p.k));
```
사용 가능한 함수: `close/open/high/low/volume(t, ago)`, `ret(t, n, skip)`, `sma`, `rsi`, `volatility`,
`highest/lowest`, `tradingValue`, `bench/benchSma`, `held()`, `weight(t)`, `pnl(t)`, `topBy`, `equal`.
전체 목록은 `lib/engine/context.ts`. 미래 데이터는 구조적으로 조회할 수 없습니다.

## 데이터
| 소스 | 설명 |
|---|---|
| 네이버 증권 | 일봉(수정주가)과 KOSPI 시총 순위. `.cache/`에 하루 동안 캐시 |
| 내 CSV | `data/csv/{종목코드}.csv`, 지수는 `KOSPI.csv` |
| 가짜 데이터 | 랜덤 데이터. 코드 동작 확인용 |

**생존편향 주의:** 네이버 시총 순위는 '현재' 기준이라 과거에 상장폐지된 종목이 빠집니다. 과거 성과가 실제보다 좋게 나올 수 있어요.

## 가정
- 신호: t일 종가 → 체결: t+1일 시가, 정수 주, 매도 후 매수
- 수수료 0.015%(양방향), 슬리피지 0.1%, 매도세 연도별(2024 0.18%, 2025 0.15%, 2026 0.20%) — `lib/engine/costs.ts`
- 거래정지(거래량 0) 종목은 그날 매매하지 않음
- 보유 비중 차이가 2%p 미만이면 수량 조정 생략(불필요한 비용 방지)

## 구조
```
app/page.tsx              입력 화면
components/Results.tsx    결과 차트·표
app/api/data/route.ts     데이터 API
lib/engine/               엔진(engine, context, metrics, costs, indicators)
lib/strategies/index.ts   기본 전략 + 사용자 코드 컴파일
lib/data/                 네이버 수집, 캐시, CSV, 가짜 데이터
tests/engine.test.ts      테스트
```

![화면](docs/screenshot.png)

Python 버전(pykrx/FinanceDataReader 기반 CLI)은 `python/` 폴더에 있습니다.
