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
npm test             # 엔진·데이터·KIS·설정 테스트
```

**한국투자증권 API:** 시세 수집과 모의투자 주문·잔고(`/trade`). 앱키·주문 대상·백테스트 기본값은 웹 설정 화면(`/settings`)에서 넣습니다 → [docs/kis.md](docs/kis.md)

**Synology NAS:** main 머지 시 GitHub Actions → GHCR → Watchtower로 자동 배포됩니다. 설정은 [docs/synology.md](docs/synology.md).

## 화면 구성
- **전략**: 기본 제공 3개(모멘텀+시장필터, 이동평균 정배열, RSI 과매도 반등) 중 선택하고 파라미터 조절
- **내 전략**: JavaScript 코드로 직접 작성. "이 전략의 코드를 열어 직접 수정하기"로 기본 전략을 복사해서 시작할 수 있고, 브라우저에 저장됩니다
- **운용 규칙**: 리밸런싱 주기(매일/매주/매월/분기), 손절·익절 %
- **추천 종목**: 결과의 "추천 종목" 탭에 마지막 날 종가 기준으로 전략이 고른 종목과 목표 비중이 나옵니다. "이 비중으로 주문 목록 만들기"를 누르면 주문 화면(`/trade`)에서 내 잔고와 비교해 살 종목·팔 종목 목록을 만들고, 확인 후 한 번에 주문합니다
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
| 네이버 증권 | 일봉(수정주가)과 KOSPI 시총 순위. `.cache/`에 저장하고 새 날짜만 이어 받음 |
| 한국투자증권 API | 일봉(수정주가)·KOSPI 지수. 앱키 필요, 시총 순위는 네이버 사용 ([docs/kis.md](docs/kis.md)) |
| 내 CSV | `data/csv/{종목코드}.csv`, 지수는 `KOSPI.csv` |
| 가짜 데이터 | 랜덤 데이터. 코드 동작 확인용 |

**생존편향:** 기본 종목 목록은 '현재' 시총 상위라서 과거에 상장폐지된 종목이 빠지고, 성과가 실제보다 좋게 나옵니다.
"과거 시점의 시총 상위 종목 사용"을 켜면 분기마다 그 시점의 시총 상위 종목으로 목록을 바꾸고(KRX 정보데이터시스템), 상장폐지된 종목도 포함합니다.
KRX 를 못 쓰는 환경이면 `data/csv/universe.csv`(`date,code,name`)에 시점별 목록을 직접 넣고 "내 CSV"로 돌릴 수 있습니다.

## 검증 (과최적화 점검)
결과의 "검증" 탭에서 확인합니다.
- **앞 기간과 뒤 기간**: 앞 70%와 뒤 30%의 CAGR·MDD·샤프를 따로 보여 줍니다. 파라미터는 앞 구간만 보고 정하고 뒤 구간은 마지막에 한 번만 확인하세요
- **1년 보유 수익률 분포**: 아무 날에 시작해 1년 뒤 30% 이상이었던 비율, 가장 나빴던 1년
- **파라미터 민감도**: 숫자 파라미터를 하나씩 ±20% 바꿔 다시 돌린 결과. 조금 바꿨는데 크게 떨어지면 우연히 맞은 값입니다

## 가정
- 신호: t일 종가 → 체결: t+1일 시가, 정수 주, 매도 후 매수
- 수수료 0.015%(양방향), 슬리피지 0.1%, 매도세 연도별(2024 0.18%, 2025 0.15%, 2026 0.20%) — `lib/engine/costs.ts`
- 거래정지(거래량 0) 종목은 그날 매매하지 않음
- 시세가 끊긴 뒤 10영업일 넘게 다시 나오지 않는 종목은 상장폐지로 보고 마지막 종가에 청산
- 보유 비중 차이가 2%p 미만이면 수량 조정 생략(불필요한 비용 방지)

## 구조
```
app/page.tsx              입력 화면
components/Results.tsx    결과 차트·표
app/api/data/route.ts     데이터 API
lib/engine/               엔진(engine, context, metrics, costs, indicators)
lib/strategies/index.ts   기본 전략 + 사용자 코드 컴파일
lib/data/                 네이버 수집, 캐시, CSV, 가짜 데이터
lib/kis/                  한국투자증권 API (토큰, 시세, 주문, 잔고)
app/trade/page.tsx        주문·잔고 화면
tests/engine.test.ts      테스트
```

![화면](docs/screenshot.png)

Python 버전(pykrx/FinanceDataReader 기반 CLI)은 `python/` 폴더에 있습니다.

## 보안 · 밖에서 접속
앱 전체가 관리자 로그인 뒤에 있습니다(`middleware.ts`). 처음 접속하면 컨테이너 로그의 설정 코드로 비밀번호를 만들고,
설정 → 보안에서 2단계 인증(휴대폰 인증 앱), 최근 로그인 기록, 모든 기기 로그아웃을 관리합니다.
인터넷에서 `https://alphy.devsean.me` 로 여는 방법(DSM 역방향 프록시, 인증서, 공유기, 방화벽)은 [docs/external-access.md](docs/external-access.md).
