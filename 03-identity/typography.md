# Phase 3 — 타이포그래피

> 미드센추리의 따뜻함(세리프) + 정밀한 중립(산세리프) 페어링.
> 국문/영문 모두 무료·상업적 사용 가능한 폰트로 선정(초기 비용·웹 적용 고려).

## 1. 폰트 시스템

| 역할 | 국문 | 영문 | 근거 |
|---|---|---|---|
| 디스플레이 (제목·로고) | **마루부리 (Maru Buri)** | **Fraunces** | 따뜻한 명조/올드스타일 — 미드센추리 클래식감 (V1·V3) |
| 본문 (Body) | **Pretendard** | **Inter** | 모던 그로테스크 — 정밀·중립·고가독 (V4) |

- 마루부리: 네이버 제공, 상업적 사용 가능. 이름의 '마루'가 우드 무드와도 호응.
- Fraunces / Inter / Pretendard: OFL, 웹·인쇄 자유 사용.

대체 폰트(미설치 환경): 디스플레이 국문 → 본명조(Noto Serif KR), 본문 국문 → 본고딕(Noto Sans KR).

## 2. 타입 스케일 (토큰)

| 토큰 | 폰트/굵기 | 크기/행간 | 용도 |
|---|---|---|---|
| `display/xl` | Maru Buri / Fraunces SemiBold | 40px / 1.2 | 히어로·간판 |
| `display/lg` | Maru Buri / Fraunces SemiBold | 32px / 1.25 | 섹션 타이틀 |
| `heading/md` | Pretendard / Inter SemiBold | 24px / 1.3 | 소제목 |
| `body/lg` | Pretendard / Inter Regular | 18px / 1.6 | 리드 문단 |
| `body/md` | Pretendard / Inter Regular | 16px / 1.6 | 기본 본문 |
| `label/md` | Pretendard / Inter Medium | 14px / 1.4 | 라벨·캡션 |
| `mode/tag` | Fraunces / Inter Medium · 자간 +0.08em | 14px / 1.4 · 대문자 | WORK·CLASS·GATHER 모드 태그 |

## 3. 운용 규칙

- **한 화면에 디스플레이는 하나** — 여백 우선(V2 절제).
- 본문은 산세리프로만, 세리프는 제목·브랜드 요소에 한정.
- 자간: 국문 본문 0 ~ -0.01em, 디스플레이 -0.02em(또렷). 모드 태그만 대문자+양수 자간.
- 행간 본문 1.6 이상 확보(편안한 가독).
- 강조는 **굵기(Medium/SemiBold)** 로, 색·밑줄 남용 금지.

## 4. 모드 태그 타이포 (브랜드 시그니처)

```
WORK   ·   CLASS   ·   GATHER
```
- Fraunces/Inter Medium, 대문자, 자간 +0.08em, 가운뎃점(·)으로 구분.
- 멀티유즈 정체성을 한 줄로 보여주는 **반복 사용 요소** — 사이니지·웹·인스타에 공통.

## 5. 접근성

- 본문 최소 16px, 모바일에서도 14px 미만 금지.
- 명조는 작은 크기에서 가독 저하 → 12~14px 영역은 산세리프(Pretendard) 사용.
