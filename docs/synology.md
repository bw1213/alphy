# Synology NAS에 배포하기 (Container Manager)

NAS의 Container Manager가 저장소 안의 `Dockerfile`로 이미지를 직접 빌드하고, `docker-compose.yml`로 실행합니다.
한 번 띄우면 NAS가 켜져 있는 동안 `http://NAS주소:3000`에서 항상 쓸 수 있습니다.

## 0. 확인할 것
- **DSM 7.2 이상**, 패키지 센터에서 **Container Manager** 설치
- Container Manager는 인텔/AMD(x86_64) 모델과 일부 ARM64 모델에서만 지원됩니다. 패키지 센터에서 검색되지 않으면 이 방법은 쓸 수 없습니다.
- 메모리 1GB 이상 여유 권장 (빌드할 때 `npm ci`와 `next build`가 메모리를 씁니다. 실행 중엔 100~200MB)

## 1. 코드 올리기
둘 중 편한 방법으로 NAS의 `/docker/kospi-backtest` 폴더에 저장소 내용을 둡니다.

**A. File Station (간단)**
1. GitHub에서 브랜치를 ZIP으로 받기: 저장소 → 브랜치 선택 → Code → Download ZIP
2. File Station → `docker` 공유 폴더 안에 `kospi-backtest` 폴더 생성
3. ZIP 압축을 풀어 나온 파일들(`Dockerfile`, `docker-compose.yml`, `package.json` …)이 `kospi-backtest` 바로 아래에 오도록 업로드

**B. SSH + git (업데이트가 쉬움)**
```bash
cd /volume1/docker
git clone -b <브랜치> https://github.com/bw1213/alphy.git kospi-backtest
```
(git은 패키지 센터의 Git Server 패키지를 설치하면 생깁니다. 비공개 저장소면 GitHub 토큰이 필요합니다.)

## 2. 프로젝트 만들기
1. Container Manager → **프로젝트** → **생성**
2. 프로젝트 이름: `kospi-backtest`
3. 경로: `/docker/kospi-backtest`
4. 소스: **기존 docker-compose.yml 사용** 선택 (내용이 자동으로 표시됨)
5. 웹 포털 설정은 건너뛰고 **완료** → 빌드가 시작됩니다 (처음엔 3~10분)
6. 상태가 "실행 중"이 되면 브라우저에서 `http://NAS-IP:3000` 접속

## 3. 데이터 폴더
`docker-compose.yml`이 NAS 폴더 두 개를 컨테이너에 연결합니다.

| NAS 폴더 | 용도 |
|---|---|
| `/docker/kospi-backtest/nas/cache` | 네이버 시세 캐시(하루 단위). 지워도 다시 받아옵니다 |
| `/docker/kospi-backtest/nas/csv` | '내 CSV 파일' 데이터. `005930.csv`, `KOSPI.csv`처럼 넣으면 바로 반영 |

### 권한 오류가 나면
컨테이너는 NAS 사용자 권한(`1026:100`)으로 실행됩니다. DSM에서 처음 만든 관리자 계정이 보통 이 번호입니다.
로그에 `EACCES` 가 보이면:
- SSH에서 `id` 를 실행해 내 uid/gid를 확인하고 `docker-compose.yml`의 `user:` 값을 바꾸거나,
- File Station → `nas` 폴더 → 속성 → 권한에서 Everyone에 읽기/쓰기를 줍니다.

## 4. 업데이트
- A 방법: 새 ZIP의 파일로 덮어쓰기 (`nas/` 폴더는 유지)
- B 방법: `cd /volume1/docker/kospi-backtest && git pull`

그다음 Container Manager → 프로젝트 → `kospi-backtest` → **작업 → 빌드**(다시 빌드 후 재시작).

## 5. 포트 바꾸기
3000번을 다른 서비스가 쓰고 있으면 `docker-compose.yml`의 `"${PORT:-3000}:3000"` 앞쪽 숫자를 바꿉니다. 예: `"3100:3000"` → `http://NAS-IP:3100`

## 6. 밖에서 접속하기 (선택)
**이 앱에는 로그인 기능이 없습니다.** 인터넷에 그대로 열면 누구나 쓸 수 있고, 네이버 시세 요청도 내 NAS에서 나갑니다.
안전한 순서대로:

1. **VPN / Tailscale (권장)** — 패키지 센터의 Tailscale 또는 VPN Server를 쓰면 포트를 열지 않고 밖에서 `http://NAS-IP:3000`에 접속할 수 있습니다.
2. **역방향 프록시 + 접근 제한** — 제어판 → 로그인 포털 → 고급 → 역방향 프록시 → 생성
   - 소스: HTTPS, 호스트 `kospi.내DDNS.synology.me`, 포트 443
   - 대상: HTTP, `localhost`, 포트 3000
   - 액세스 제어 프로필로 허용 IP를 제한하고, 제어판 → 보안 → 인증서에서 Let's Encrypt 인증서를 연결
   - 종목 수를 크게(200~300) 잡으면 첫 시세 수집에 1분 넘게 걸릴 수 있습니다. 시간 초과가 나면 역방향 프록시 규칙의 **고급 설정**에서 프록시 시간 제한을 300초로 늘리세요.

## 문제 해결
| 증상 | 확인 |
|---|---|
| 빌드가 메모리 부족으로 실패 | 다른 컨테이너를 잠시 멈추고 다시 빌드 |
| "네이버 증권에 접속하지 못했습니다" | NAS가 인터넷에 연결돼 있는지, 방화벽이 외부 HTTPS를 막는지 확인 |
| 화면은 뜨는데 CSV 종목이 안 보임 | 파일이 `nas/csv/`에 있는지, 첫 줄이 `Date,Open,High,Low,Close,Volume` 인지 |
| 로그 보기 | Container Manager → 컨테이너 → `kospi-backtest` → 로그 |
