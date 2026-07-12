# MODE LOUNGE — Brand

> 모드라운지 비주얼 아이덴티티 시스템. 참조 구조: 모회사 No More Work Company(NMWC) 디자인 시스템(`nmwc.ai.kr/brand`).
> 최종 확정본 (2026-07-06). 폰트=Paperlogy 단일 · 웨이트 400/600 · 로고=레이어드 E 워드마크(심볼 없음).
> 원본: `03-identity/logo-system.md` · `color-palette.md` · `typography.md`, `04-signage/pictograms.md`, `01-strategy/visual-principles.md`.

**목차**: Logo · Color · Typography · Iconography · Imagery · Motion · Assets

---

## 01. Logo

**심볼 없음 — 워드마크 자체가 로고.** MODE의 `E` 세로획을 없애고 **가로 3선(동일폭)** 을 남긴 "레이어드 E"가 코어 아이덴티티. 3선 = 쌓인 층 = **WORK · CLASS · GATHERING**.

### Primary Mark
- **프라이머리 = 세로 2줄** (`MODE` / `LOUNGE`), 가운데 정렬 — 레이아웃 원칙과 일치.
- **베리에이션 = 가로 1줄** (`MODE LOUNGE`) — 배너·웹 헤더·명함.
- 국·영 병기 시 국문 위 / 영문 아래. 사이니지는 영문 중심.

### 파일 (납품용 벡터 · 폰트 의존성 없음)

| 파일 | 형태 | 색 | 용도 |
|---|---|---|---|
| `logo-wordmark-v-ink.svg` | 세로 2줄 | 잉크 `#16130F` | **프라이머리** · 밝은 배경 |
| `logo-wordmark-v-white.svg` | 세로 2줄 | 화이트 `#ffffff` | 어두운·오렌지 배경 |
| `logo-wordmark-h-ink.svg` | 가로 1줄 | 잉크 | 배너·웹 헤더·명함 |
| `logo-wordmark-h-white.svg` | 가로 1줄 | 화이트 | 어두운·오렌지 배경 |
| `logo-wordmark-v.svg` / `-h.svg` | 세로 / 가로 | `currentColor` | 웹·CSS `color` 제어 |

경로 접두: `03-identity/`. 재현 스크립트 `gen600.py` (입력 `Paperlogy-6SemiBold.ttf`, E 3선 두께비 0.15).

### Color 사용

| 배경 | 워드마크 색 |
|---|---|
| 화이트 / 라이트 | 잉크 `#16130F` |
| 잉크 / 다크 | 화이트 `#ffffff` |
| 오렌지 `#E2531E` | 화이트 `#ffffff` |

라이트/다크는 **형태·비율·정렬 100% 동일, 채움색만 반전**. 3선도 본체와 같은 색.

### Clearspace · Minimum Size
- **클리어스페이스**: 대문자 높이(cap)의 약 **1/2** 을 사방 여백으로.
- **최소 크기**: 세로 락업 높이 ≥ 24px(디지털) / ≥ 12mm(인쇄). 이하에서는 가로 1줄 사용.

### Don'ts
비율 변형·기울임 / 3선 개수·두께·간격 변경 / 3선을 서로 다른 폭으로 / E에 세로획 되살리기 / 채움색 외 컬러 / 클리어스페이스 침범 / 폰트 텍스트로 대체.

---

## 02. Color

브랜드 식별은 **3색(화이트·잉크·오렌지)** 으로 압축. **레이어 분리** — 디지털·마케팅은 오렌지 컬러블록 과감하게, 실내 사이니지는 블랙·화이트 물성 중심으로 차분하게(가구를 이기지 않게).

> HEX/RGB = 디지털 확정값. CMYK/Pantone은 근사 — 인쇄·사이니지 발주 전 실물 스와치 확인 필수.

| 이름 | HEX | 토큰 | 쓰임새 |
|---|---|---|---|
| **번트 오렌지** | `#E2531E` | `spine/orange` | **엑센트** — 즉시 인지. 컬러블록·대형 타이포·로고(화이트 위) |
| **화이트** | `#ffffff` | `spine/white` | **메인** — 밝은 배경·레터링(흰색 종이) |
| **잉크 블랙** | `#16130F` | `spine/ink` | **메인** — 본문 텍스트·블록 |

### 사용 비율
```
메인 (white + ink)        ████████████████████  ~80%
엑센트 (orange)           █████                 ~20%
```
한 화면에 오렌지 컬러블록은 **1~2개까지**.

### 검증된 페어 · 대비

| 배경 | 요소 | 용도 | 대비 |
|---|---|---|---|
| white | ink / orange | 본문·정보 | ink on white ✅ AAA |
| ink | white / orange | 야간·포스터 | white on ink ✅ AAA |
| orange | white / ink | 메인 키비주얼 | white on orange ✅ AA(대형만) |

> **금지**: 오렌지를 **작은 본문 텍스트 색**으로 사용(대비 부족). 면·블록·대형 타이포·로고에만.

---

## 03. Typography

**Paperlogy 단일** (무료 상업 사용 · fonts-archive · 웨이트 100~900, 국·영문 한 폰트). 각진 기하 골격 = "정돈된" 키워드의 타이포적 표현.

| 역할 | 패밀리 | 웨이트 | 쓰임새 |
|---|---|---|---|
| 로고 워드마크 | **Paperlogy** | **600** | `MODE LOUNGE` / `모드라운지` · E 레이어 커스텀 |
| 디스플레이(헤드라인·간판) | Paperlogy | 600 | 포스터·히어로·섹션 타이틀 |
| 소제목 | Paperlogy | 600 | |
| 본문 (Body) | Paperlogy | **400 · 600** | 기본 400, 강조 600 |
| 라벨·모드 태그 | Paperlogy | 600 (대문자) | WORK · CLASS · GATHERING |

전 시스템 **2-웨이트(400 / 600)** 통일.

### 자간
| 구분 | 자간 |
|---|---|
| 영문 로고·디스플레이 | **−2%** (−0.02em) |
| 국문 로고·디스플레이 | 0% |
| 본문 | 0% |
| 라벨·모드 태그(대문자) | **+0.12~0.14em** |

### 타입 스케일
| 토큰 | 웨이트 | 크기 / 행간 | 용도 |
|---|---|---|---|
| `display/2xl` | 600 · 영문 −2% | 56px / 1.0 | 포스터·키비주얼 |
| `display/xl` | 600 | 40px / 1.05 | 간판·히어로 |
| `display/lg` | 600 | 28px / 1.1 | 섹션 타이틀 |
| `heading/md` | 600 | 22px / 1.3 | 소제목 |
| `body/lg` | 400 | 18px / 1.6 | 리드 |
| `body/md` | 400 | 16px / 1.6 | 본문 |
| `label/md` | 600 · 대문자 | 14px / 1.4 | 라벨·모드 태그 |

### 운용
- **가운데 정렬 기본** (안내문 위주, 위/아래 배치). 강조는 **굵기(600)·컬러블록**으로. 밑줄·그림자 금지.
- 그루비/세리프 이탤릭 액센트 사용 안 함. 본문 최소 16px, 초소형 라벨(≥12px)은 자간 소폭 확보.

---

## 04. Iconography

기하 라인 픽토그램. 일관된 그리드·선 굵기로 "고른(curated)" 인상.

| 속성 | 값 |
|---|---|
| 그리드 | **24×24**, 2px 패딩 |
| 선 굵기 | **1.5px 균일**(24 그리드 기준) · 끝단 square · 조인 miter |
| 형태 | 기하 + 약한 곡선, 직각은 `radius/sm`(2px) |
| 컬러 | `spine/ink` 기본 / 반전 시 `spine/white` / 컬러블록 위 가능. 파일은 `currentColor` |
| 채움 | 라인 위주 인상 유지 — 단 **납품 SVG는 stroke를 아웃라인(면)으로 변환**(스트로크·폰트 의존 0) |

### 세트 (9종, `04-signage/picto-*.svg`)
- **편의**: `wifi` · `coffee`(탕비) · `toilet`(화장실) · `room` · `umbrella`
- **방향/안전**: `stairs` · `extinguisher`
- **금지**: `no` · `nosmoke`
- **모드 3종(시그니처, 제작 예정)**: WORK(데스크+램프) · CLASS(매트+사람) · GATHERING(둘러앉은 아크)
- **방향 화살표**: 사각형을 쌓아 만든 **도형 조립 화살표**(기하 톤).

### 규칙
- **픽토그램은 항상 텍스트 라벨과 병행**(색·기호만으로 정보 전달 금지 — 접근성). 라벨 = Paperlogy `label/md`.
- 세트 외 아이콘 혼용·입체·장식 금지. 선 굵기 고정.

### 다운로드 — 픽토그램 (아웃라인 SVG, currentColor)
[wifi](assets/picto/picto-wifi.svg) · [coffee](assets/picto/picto-coffee.svg) · [toilet](assets/picto/picto-toilet.svg) · [room](assets/picto/picto-room.svg) · [stairs](assets/picto/picto-stairs.svg) · [umbrella](assets/picto/picto-umbrella.svg) · [extinguisher](assets/picto/picto-extinguisher.svg) · [no](assets/picto/picto-no.svg) · [nosmoke](assets/picto/picto-nosmoke.svg)

### 다운로드 — 모드 태그 (Paperlogy 400 · 자간 +0.05em · 4pt 프레임 아웃라인)

| 모드 | 잉크(라이트 배경) | 화이트(잉크·오렌지 배경) | currentColor(웹) |
|---|---|---|---|
| WORK | [ink](assets/mode/mode-work-ink.svg) | [white](assets/mode/mode-work-white.svg) | [current](assets/mode/mode-work.svg) |
| CLASS | [ink](assets/mode/mode-class-ink.svg) | [white](assets/mode/mode-class-white.svg) | [current](assets/mode/mode-class.svg) |
| GATHERING | [ink](assets/mode/mode-gathering-ink.svg) | [white](assets/mode/mode-gathering-white.svg) | [current](assets/mode/mode-gathering.svg) |

> 원본(소스): `04-signage/`. 브랜드북 사본: `07-brand-book/assets/{picto,mode}/`. 재생성 스크립트 `04-signage/outline_picto.py`(픽토)·`gen_modes.py`(모드 태그).

---

## 05. Imagery

기하 그래픽 무드. 코어 무드를 바우하우스·스위스·기하로 표현. **그루비/사이키델릭 배제**.

### 비주얼 형용사 (지향)
볼드·웜 / 기하 / 정제된 / 물성 있는 / 절제된 위트(면이 겹쳐 생기는 교집합).

### Do
- **컷아웃 콜라주**: 디자인 가구를 색면·블롭 위에 얹기(furn. 방식).
- **레이어드 톤**: 또렷하지 않고 **한 겹 쌓인 느낌** — 반투명·트레이싱지·종이 물성.
- 하이 콘트라스트 + 웜 새추레이션. 번트 오렌지 베이스 + 블랙 앵커.
- 문구 오브제(클립·포스트잇·자석·마스킹테이프)를 꾸밈 요소로 상시 운용.

### Don't
- 차가운 테크 미니멀(SaaS 화이트) / 그루비·사이키델릭 흐물 레터링 / 소심한 파스텔·그레이지 일색 / 디테일 과잉 러스틱 장식 / 납작한 플랫 일러스트 일색.

### 레이어 분리
| 레이어 | 톤 |
|---|---|
| 디지털·마케팅 | 컬러블록 과감 — 볼드 기하 그래픽 |
| 실제 공간 사이니지 | 블랙·화이트 물성 중심 — 차분하게 |

---

## 06. Motion

**절제가 원칙.** 장식 모션 금지, 기능 전환만.

| 토큰 | 값 | 용도 |
|---|---|---|
| `motion/fast` | 120ms ease-out | 탭·토글 |
| `motion/base` | 240ms cubic-bezier(0.16, 1, 0.3, 1) | 패널 전환 |

- `prefers-reduced-motion` 존중. 공간 사이니지는 정적(모션 없음)이 기본.
- (추후 예약 UI에서만 위 토큰 적용 — 상세 → `product.md`.)

---

## 07. Assets

| 파일 | 용도 | 사양 |
|---|---|---|
| `logo-wordmark-{v,h}-{ink,white}.svg` | 워드마크 4종 | 폰트 아웃라인, 무의존 |
| `logo-wordmark-{v,h}.svg` | 워드마크 currentColor | 웹·CSS |
| `04-signage/picto-*.svg` (9종) | 픽토그램 세트 | viewBox 100, **아웃라인(면)**, `currentColor` |
| `04-signage/mode-*.svg` (9종) | 모드 태그 WORK·CLASS·GATHERING | Paperlogy 400 아웃라인 · 자간 +0.05em · 4pt 프레임 · ink/white/currentColor |
| `03-identity/favicon.svg` | 브라우저 탭 | ⚠️ 심볼 기반 — **워드마크(3선) 기반 재제작 필요** |

### 남은 작업
- [ ] 워드마크(3선) 기반 파비콘/앱 아이콘 재제작
- [ ] 모드 3종 라인 픽토 SVG 제작
- [ ] 사이니지용 단색 각인판(트레이싱지/아크릴) 사양
- [ ] AI(.ai) 마스터 — 필요 시 SVG에서 변환
