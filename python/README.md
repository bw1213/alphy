# KOSPI 백테스트 (kbt)

내 전략을 파이썬 파일 하나로 정의해서 KOSPI 종목에 바로 백테스트하는 환경입니다.

## 설치 · 실행 (내 PC)
```bash
pip install -r requirements.txt
python run.py --list                                   # 등록된 전략 목록
python run.py --strategy momentum --start 2015-01-01   # pykrx(KRX) 데이터로 실행
python run.py --strategy momentum --source fdr         # pykrx 가 막히면 FinanceDataReader
python run.py --strategy ma_cross --params '{"short": 10, "long": 50}'
python run.py --strategy momentum --tickers 005930,000660,035420,005380
python tests/test_engine.py                            # 엔진 정합성 테스트
```
결과는 `results/<전략>_<시각>/` 에 `equity.png`(자산곡선·KOSPI·연30% 목표선·낙폭), `trades.csv`, `equity.csv`, `summary.json` 으로 저장됩니다.
처음 실행 시 데이터를 내려받아 `data/cache/` 에 저장하므로 두 번째부터는 빠릅니다.

## 내 전략 추가하기
`kbt/strategies/_template.py` 를 복사해 `kbt/strategies/my_rule.py` 로 만들고 `target_weights()` 만 고치면
자동 등록되어 `python run.py --strategy my_rule` 로 실행됩니다.

```python
class MyRule(Strategy):
    name = "my_rule"
    params = {"lookback": 60, "top_k": 5}
    rebalance = "M"          # D/W/M/Q 또는 N영업일
    stop_loss = 0.1          # 선택: 평단 -10% 손절
    def target_weights(self, ctx):       # 장 마감 후 호출, 오늘까지 데이터만 보임
        c = ctx.close                    # 날짜 x 티커
        ret = c.iloc[-1] / c.iloc[-self.p.lookback] - 1
        picks = ret.nlargest(self.p.top_k).index
        return {t: 1 / self.p.top_k for t in picks}   # {티커: 비중}, 다음날 시가 체결
```
`ctx` 에는 `open/high/low/close/volume`, `positions`, `avg_price`, `cash`, `equity`, `benchmark`(KOSPI 지수)가 있습니다.
`None` 을 반환하면 그날은 매매하지 않고, `{}` 를 반환하면 전량 현금화합니다.

## 기본 제공 예시 전략
| 이름 | 내용 |
|---|---|
| `momentum` | 월말 6개월(최근 1개월 제외) 수익률 상위 10종목 동일비중, KOSPI 200일선 아래면 현금 |
| `ma_cross` | 20/60일 이평 정배열 종목 주간 보유, 최대 10종목, 손절 -10% |
| `rsi_reversal` | 상승추세 종목의 RSI<30 매수, RSI>60 매도, 익절 +15%·손절 -7% |

## 현실 반영 가정
- **체결**: t일 종가로 신호 → t+1일 시가 체결 (미래 데이터 사용 없음). 정수 주, 매도 먼저 후 매수.
- **비용**: 수수료 0.015%(양방향), 슬리피지 0.1%, 매도 시 거래세+농특세 연도별 법정세율
  (2023 0.20%, 2024 0.18%, 2025 0.15%, 2026~ 0.20%). `--commission --slippage --sell-tax` 로 변경.
- **거래정지**(거래량 0) 종목은 그날 매매 안 함. 수정주가 사용.
- **유니버스**: 시작일 시점 KOSPI 시총 상위 N(기본 100), 보통주만.
  pykrx 는 그 시점 상장 종목을 쓰지만, 시작일 이후 신규 상장 종목은 포함되지 않습니다.
  fdr 소스는 현재 상장 목록만 주므로 과거 구간에서 생존편향(상장폐지 종목 누락)이 생깁니다.
- 성과 평가 시 목표(연 30%) 대비 CAGR, 연도별 달성 여부를 함께 출력합니다.
