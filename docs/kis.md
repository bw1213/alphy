# 한국투자증권(KIS) Open API 연동

앱에서 한국투자증권 API로 할 수 있는 것:

| 기능 | 위치 | 필요한 것 |
|---|---|---|
| 백테스트용 일봉 시세(수정주가) + KOSPI 지수 | 백테스트 화면 → 데이터 → **한국투자증권 API** | 실전 또는 모의 앱키 |
| 현재가 조회 | `/trade` 주문 화면 | 실전 또는 모의 앱키 |
| 잔고 조회, 매수·매도 주문 | `/trade` | 모의(또는 실전) 앱키 + 계좌번호 + `TRADE_API_TOKEN` |

주문은 **기본이 모의투자**입니다. 실전 주문은 환경변수 두 개(`KIS_TRADE_ENV=real`, `KIS_ALLOW_REAL_ORDERS=yes`)를 모두 넣어야만 나갑니다.

## 1. 계좌와 앱키 받기

메뉴 이름은 바뀔 수 있으니 막히면 [KIS Developers](https://apiportal.koreainvestment.com) 안내를 보세요.

1. **한국투자증권 계좌 개설** — 한국투자 앱에서 비대면으로 개설 (종합계좌, 계좌번호 `12345678-01` 형식)
2. **모의투자 신청** — 한국투자증권 홈페이지 또는 앱의 모의투자 메뉴에서 신청하면 모의투자 계좌번호가 따로 나옵니다 (`5001xxxx-01` 형태)
3. **Open API 서비스 신청** — 홈페이지 로그인 → 트레이딩 → Open API → **KIS Developers 서비스 신청**
   - 실전 계좌로 한 번, 모의투자 계좌로 한 번 신청하면 각각 **앱키(App Key)와 앱시크릿(App Secret)**이 나옵니다
   - 앱시크릿은 비밀번호처럼 다루세요. 채팅·메일·깃허브에 붙여넣지 마세요
4. 앱키는 유효기간이 있습니다(보통 1년). 만료되면 같은 메뉴에서 재발급합니다

> 시세만 쓸 거라면 모의투자 키만으로도 됩니다. 다만 모의투자는 **초당 2건** 정도로 호출이 제한돼서 100종목 × 5년을 처음 받으면 10분 넘게 걸립니다.
> 실전 앱키를 넣어 두면 시세는 실전 서버(초당 20건)로 받고, 주문은 여전히 모의투자로만 나갑니다.

## 2. NAS에 키 넣기

`docker-compose.yml`과 같은 폴더(`/docker/kospi-backtest/`)에 `.env` 파일을 만듭니다. `.env.example`을 복사해서 채우면 됩니다.

```ini
KIS_MOCK_APP_KEY=PSxxxxxxxxxxxxxxxx
KIS_MOCK_APP_SECRET=xxxxxxxx...
KIS_MOCK_ACCOUNT=50012345-01

# 선택: 시세를 빠르게
KIS_REAL_APP_KEY=
KIS_REAL_APP_SECRET=

KIS_TRADE_ENV=mock
TRADE_API_TOKEN=아무도-못-맞출-긴-문자열
```

- File Station에서 만들 경우: 텍스트 편집기로 `env.txt`를 만들어 올린 뒤 이름을 `.env`로 바꿉니다
- `.env`는 `.gitignore`에 들어 있어 저장소에 올라가지 않습니다
- 바꾼 뒤에는 Container Manager → 프로젝트 → `kospi-backtest` → **작업 → 중지 → 시작** (또는 빌드)
- 잘 들어갔는지는 `http://NAS-IP:3000/trade`의 **연결 상태**에서 확인합니다 (키 값은 화면에 나오지 않음)

## 3. 사용

**백테스트**: 데이터를 "한국투자증권 API"로 고르고 실행합니다. 받은 시세는 `nas/cache/kis/`에 하루 동안 저장됩니다.
시총 상위 N 종목 목록은 KIS에 적당한 API가 없어 여전히 네이버에서 가져옵니다. 네이버가 막혀 있으면 "종목 직접 입력"을 쓰세요.

**주문·잔고**: `/trade`에서 주문 비밀번호(`TRADE_API_TOKEN`)를 넣고 잔고 조회·주문을 합니다.
- 시장가/지정가, 매수/매도. "주문 확인" → 한 번 더 "실행"을 눌러야 나갑니다
- 장 시간(평일 09:00~15:30) 밖의 주문은 증권사에서 거부됩니다
- 주문 내역은 컨테이너 로그에 `[kis-order]`로 남습니다

## 동작 방식 / 제약
- 접근토큰은 24시간 유효하고 **1분에 1번만 발급**됩니다. 앱이 `nas/cache/kis/token-*.json`에 저장해 재사용합니다 (이 폴더를 남에게 공유하지 마세요)
- 호출 제한(실전 20건/초, 모의 2건/초)에 맞춰 자동으로 간격을 두고, 한도 초과 응답이 오면 잠시 쉬었다 재시도합니다
- 일봉은 한 번에 100건씩 오므로 기간이 길면 여러 번 나눠 받습니다
- 모의투자 서버는 일부 API(예: 지수 일봉)를 지원하지 않을 수 있습니다. KOSPI 지수를 못 받으면 네이버 지수로 대체하고 경고를 띄웁니다

## 보안
- 주문·잔고 API는 `TRADE_API_TOKEN`이 없으면 꺼져 있고, 있으면 요청 헤더로 같은 값을 보내야 합니다
- 이 앱엔 로그인 기능이 없습니다. **실전 주문을 켤 거면 NAS를 인터넷에 직접 열지 말고** VPN/Tailscale로만 접속하세요 ([synology.md](synology.md) 6번)

## 코드 위치
```
lib/kis/config.ts    환경변수 → 자격 증명, 실전 주문 잠금
lib/kis/client.ts    토큰 발급·캐시, 호출 간격, 재시도
lib/kis/market.ts    일봉·지수·현재가
lib/kis/trading.ts   주문(order-cash), 잔고(inquire-balance)
lib/kis/auth.ts      주문 API 비밀번호 확인
app/api/kis/*        status · quote · balance · order
app/trade/page.tsx   주문·잔고 화면
```
