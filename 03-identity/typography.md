# Phase 3 — 타이포그래피 (v3, MCM 그래픽)

> **🟢 2026-06-28 최종 확정 (이 노트가 우선)**: 폰트 = **Pretendard 단일**(국·영문 한 가족 — 로고 워드마크·디스플레이·본문 전부). League Spartan 등 별도 디스플레이 폰트는 **사용하지 않음**. 로고 워드마크는 Pretendard 800(국문)/600(영문). 아래 'League Spartan' 서술은 폐기. 로고 전체 사양 → `logo-system.md`.

> 2026-06-21 개정. 본문 **Inter 삭제 → Pretendard로 통일**(국·영문 한 가족). **Fraunces Italic 액센트 제거**(폰트 통일). 디스플레이는 League Spartan 유지하되 **로고 확정 시 로고 레터링에 맞춰 변경될 수 있음(현재는 방향값)**.
> 미드센추리 그래픽 = **기하 산세리프(바우하우스·스위스)**. 볼드하되 그루비/사이키델릭 배제.
> 가구의 바우하우스 DNA와 같은 결. 무료·상업적 사용 가능 폰트 중심.

## 1. 폰트 시스템

| 역할 | 영문 | 국문 | 근거 |
|---|---|---|---|
| 디스플레이 (로고·헤드라인) | **League Spartan** (Black) | **G마켓 산스 / Pretendard Black** | 푸투라 계열 **기하 산세리프** — 바우하우스 직계. 볼드 키비주얼 (V1·V3) |
| 본문 (Body) | **Pretendard** | **Pretendard** | 국·영문 한 가족으로 통일 — 중립·고가독. 영문 그로테스크 자리도 Pretendard가 담당 |

- League Spartan: OFL 무료. 기하 산세 디스플레이의 대표격. **단, 로고가 확정되면 디스플레이 폰트가 로고 레터링에 맞춰 변경될 수 있음(현재는 방향값).**
- 본문은 Pretendard 단일 — Inter는 사용하지 않음(국·영문 폰트 통일).
- 대안 디스플레이(더 두껍게): Archivo Black, Anton(둘 다 무료) — RETROTIKA식 헤비 지오메트릭.
- 그루비/Cooper류는 **사용하지 않음** (가구와 톤차 발생). 세리프 이탤릭 액센트(Fraunces 등)도 폰트 통일을 위해 사용하지 않음.

## 2. 타입 스케일 (토큰)

| 토큰 | 폰트/굵기 | 크기/행간 | 용도 |
|---|---|---|---|
| `display/2xl` | League Spartan Black · 자간 -0.01em | 56px / 1.0 | 포스터·키비주얼(글자가 레이아웃) |
| `display/xl` | League Spartan Black | 40px / 1.05 | 간판·히어로 |
| `display/lg` | League Spartan Bold | 28px / 1.1 | 섹션 타이틀 |
| `heading/md` | Pretendard SemiBold | 22px / 1.3 | 소제목 |
| `body/lg` | Pretendard Regular | 18px / 1.6 | 리드 |
| `body/md` | Pretendard Regular | 16px / 1.6 | 본문 |
| `label/md` | Pretendard Medium · 대문자 | 14px / 1.4 | 라벨·모드 태그 |

## 3. 운용 규칙

- **빅 타이포가 주인공**: 디스플레이는 크고 과감하게, 글자 조형 자체가 그래픽(RETROTIKA/furn. 방식).
- 디스플레이는 기하 산세 **단일** — 한 화면 한 종류. (세리프 이탤릭 액센트는 폰트 통일로 사용 안 함.)
- 자간: 디스플레이 -0.01~ -0.02em(또렷·꽉 찬 조형), 본문 0.
- 대문자 + 약간의 자간으로 라벨/모드 태그 처리.
- 강조는 굵기·컬러블록으로, 밑줄·그림자 금지.

## 4. 모드 태그 (시그니처)

```
WORK · CLASS · GATHER
```
- League Spartan / 대문자 / 가운뎃점 구분. 컬러블록 위 크림/잉크로.

## 5. 접근성

- 본문 최소 16px. 12~14px 영역도 Pretendard(국·영문 통일).
- 기하 산세는 소문자 가독이 양호하나, 초대형 디스플레이는 대비 확보 필수.
