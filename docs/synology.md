# Synology NAS에 배포하기 (Container Manager)

**자동 배포 구조:** main 브랜치에 머지 → GitHub Actions가 테스트 후 Docker 이미지를 만들어 `ghcr.io/bw1213/alphy:latest`에 올림 → NAS의 Watchtower가 5분마다 확인해서 새 이미지면 앱 컨테이너를 교체.
NAS에서 빌드하지 않고, 공유기 포트를 열 필요도 없습니다. 처음 한 번만 아래대로 설정하면 이후엔 PR 머지만 하면 됩니다.

## 0. 확인할 것
- **DSM 7.2 이상**, 패키지 센터에서 **Container Manager** 설치 (DS220+ 지원)
- 실행 중 메모리 100~200MB

## 1. GitHub 쪽 (처음 한 번)
1. 이 변경이 main에 머지되면 저장소 → **Actions** 탭에서 `docker` 워크플로가 초록색으로 끝나는지 확인 (3~5분)
2. github.com/bw1213 → **Packages** → `alphy` → **Package settings** → Danger Zone → **Change visibility → Public**
   - 저장소가 공개라서 이미지를 공개해도 새로 드러나는 건 없습니다. 앱키(`.env`)는 이미지에 들어가지 않습니다.
   - 비공개로 두려면 NAS에서 로그인이 필요합니다 (아래 "비공개 이미지" 참고).

## 2. NAS 쪽 (처음 한 번)
1. File Station → `docker` 공유 폴더 안에 `alphy` 폴더 생성
2. 저장소의 `docker-compose.yml` 하나만 그 폴더에 업로드 (소스 코드 전체는 필요 없음)
3. 같은 폴더 안에 `nas/cache`, `nas/csv` 폴더 생성
4. Container Manager → **프로젝트** → **생성**
   - 프로젝트 이름: `alphy`, 경로: `/docker/alphy`
   - 소스: **기존 docker-compose.yml 사용** → **완료**
5. 컨테이너 두 개(`alphy`, `alphy-watchtower`)가 실행되면 `http://NAS-IP:3000` 접속 → 로그인 화면에서 관리자 비밀번호 만들기 (설정 코드는 Container Manager → 컨테이너 → `alphy` → 로그)
6. 한국투자증권 앱키 등은 `http://NAS-IP:3000/settings`에서 넣습니다 ([kis.md](kis.md) 2번)

이후 main에 머지할 때마다 5~10분 안에 NAS에 자동 반영됩니다. 확인: Container Manager → 컨테이너 → `alphy-watchtower` → 로그에 `Found new ghcr.io/bw1213/alphy:latest image`.

### 비공개 이미지로 둘 때
GitHub → Settings → Developer settings → Personal access tokens (classic) → `read:packages` 권한으로 토큰 발급 후, NAS에 SSH로 접속해서:
```bash
sudo docker login ghcr.io -u bw1213        # 비밀번호 자리에 토큰
```
그리고 `docker-compose.yml`의 watchtower `volumes:`에 `- /root/.docker/config.json:/config.json:ro` 한 줄을 추가합니다.

## 3. 데이터 폴더
`docker-compose.yml`이 NAS 폴더 두 개를 컨테이너에 연결합니다.

| NAS 폴더 | 용도 |
|---|---|
| `/docker/alphy/nas/cache` | `config/`: 설정 화면에서 저장한 값(앱키 등). **지우지 마세요.** 나머지는 시세 캐시(하루 단위)라 지워도 다시 받아옵니다 |
| `/docker/alphy/nas/csv` | '내 CSV 파일' 데이터. `005930.csv`, `KOSPI.csv`처럼 넣으면 바로 반영 |

### 권한 오류가 나면
컨테이너는 NAS 사용자 권한(`1026:100`)으로 실행됩니다. DSM에서 처음 만든 관리자 계정이 보통 이 번호입니다.
로그에 `EACCES` 가 보이면:
- SSH에서 `id` 를 실행해 내 uid/gid를 확인하고 `docker-compose.yml`의 `user:` 값을 바꾸거나,
- File Station → `nas` 폴더 → 속성 → 권한에서 Everyone에 읽기/쓰기를 줍니다.

### 한국투자증권 앱키·설정
웹 화면 `/settings`에서 넣습니다. 자세한 내용은 [kis.md](kis.md).
`.env`는 실전 주문 잠금 해제(`KIS_ALLOW_REAL_ORDERS`)를 쓸 때만 필요합니다 (`.env.example` 참고).

### 예전 버전에서 넘어올 때
예전 `docker-compose.yml`에는 `KIS_TRADE_ENV=${KIS_TRADE_ENV:-mock}`가 있어서 화면의 주문 대상이 모의투자로 고정(🔒)됩니다.
NAS의 `docker-compose.yml`을 새 파일로 바꾸고 프로젝트를 다시 시작한 뒤, `.env`에 있던 앱키를 설정 화면에 옮겨 넣으세요.
(그대로 둬도 `.env` 값으로 계속 동작합니다. `TRADE_API_TOKEN`은 관리자 비밀번호로 쓰입니다)

## 4. 업데이트
자동입니다. main에 머지 → Actions 빌드(3~5분) → Watchtower 반영(최대 5분).
- 바로 반영하고 싶으면: Container Manager → 프로젝트 → `alphy` → **작업 → 중지 후 시작**(최신 이미지를 다시 받음)
- `docker-compose.yml` 자체가 바뀐 경우(환경변수 추가 등)만 NAS의 파일을 새 것으로 바꾸고 프로젝트를 다시 시작하세요.
- 문제가 생긴 버전을 되돌리려면 `image:`를 `ghcr.io/bw1213/alphy:sha-<커밋7자리>`로 고정합니다 (Watchtower는 고정 태그가 바뀌지 않으니 갱신하지 않음).

### NAS에서 직접 빌드 (선택)
GitHub을 거치지 않고 NAS에서 소스로 빌드하려면, 저장소 전체를 `/docker/alphy`에 두고 SSH에서:
```bash
cd /volume1/docker/alphy
sudo docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 5. 포트 바꾸기
3000번을 다른 서비스가 쓰고 있으면 `docker-compose.yml`의 `"${PORT:-3000}:3000"` 앞쪽 숫자를 바꿉니다. 예: `"3100:3000"` → `http://NAS-IP:3100`

## 6. 밖에서 접속하기 (https://alphy.devsean.me)
DSM 역방향 프록시 + Let's Encrypt 인증서로 엽니다. 단계별 안내와 보안 설정은 [external-access.md](external-access.md).
앱 전체가 로그인 뒤에 있지만, **공유기에서 3000 번 포트를 직접 열지는 마세요** (HTTPS 없이 비밀번호가 오갑니다).

### 예전 `kospi-backtest` 이름으로 이미 만들었다면
Container Manager → 프로젝트 → `kospi-backtest` → 작업 → 중지 후 삭제 → `docker/kospi-backtest/nas` 폴더를 `docker/alphy/nas` 로 옮기고 위 2단계대로 새로 만듭니다.
설정(`nas/cache/config`)을 옮기면 앱키·비밀번호가 그대로 유지됩니다.

## 문제 해결
| 증상 | 확인 |
|---|---|
| 머지했는데 NAS에 반영이 안 됨 | 저장소 Actions 탭에서 `docker` 실패 여부 → `alphy-watchtower` 로그 확인 |
| `pull access denied` / `unauthorized` | 패키지가 비공개. 1-2 단계로 공개하거나 "비공개 이미지" 설정 |
| "네이버 증권에 접속하지 못했습니다" | NAS가 인터넷에 연결돼 있는지, 방화벽이 외부 HTTPS를 막는지 확인 |
| 화면은 뜨는데 CSV 종목이 안 보임 | 파일이 `nas/csv/`에 있는지, 첫 줄이 `Date,Open,High,Low,Close,Volume` 인지 |
| 로그 보기 | Container Manager → 컨테이너 → `alphy` → 로그 |
