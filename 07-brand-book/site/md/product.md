# TYPE LOUNGE — Product (Component System)

> 타입라운지 컴포넌트 시스템.
> **현재 프로덕트 = 공간 사이니지 · 인쇄물.** 예약 웹/앱은 추후 확장(「07. Reservation UI」).
> **Atom 먼저, Molecule/Organism은 Atom 조합으로.** 이름은 기존 HTML 실제 클래스(`.panel .mode .floor .logo .arrow`)와 토큰(`--spine-*`)을 그대로 채택.
> 원본: `06-applications/*.html`, `04-signage/signage-system.md` · `interior-wayfinding.md` · `pictograms.md`, `03-identity/design-tokens.md`.
> **공간 사이니지의 확정 사양·설치 실물·안내문 템플릿은 `signage.md`가 정본이다.** 이 문서는 컴포넌트(Atom/Molecule/Organism) 관점만 다룬다.

**목차**: Principles · Components · Surface & Materials · Iconography · States · Accessibility · Reservation UI

> **표기 원칙**: "버튼은 파란색" ❌ → "`.mode` active, `var(--spine-orange)`" ✅. 색·크기는 항상 토큰으로 지시한다.

---

## 01. Principles

1. **Atom 먼저** — Molecule/Organism은 Atom 조합으로만 정의한다.
2. **이름은 실제 클래스·토큰을 그대로** — `.panel .mode .floor .logo .arrow` · `--spine-*`. 새 이름을 발명하지 않는다.
3. **색·크기는 토큰으로 지시** — "버튼은 파란색" ❌ → `.mode` active, `var(--spine-orange)` ✅.
4. **추정 금지** — 실제 화면·Figma가 생기면 그때의 컴포넌트 이름을 그대로 채운다.

> **사이니지 6원칙**(자가안내 · 찾아오게 만들기 · 도형이 글자보다 먼저 · 소수·정밀·절제 · 레이어 분리 · 낮은 층고)은 `signage.md`의 「01. Principles」가 정본이다. 양쪽에 복사해두면 한쪽만 고쳐져 조용히 어긋난다.

---

## 02. Components

### 02a. Atoms — 자주 쓰는 컴포넌트 5개

#### 1. Color Token
| | |
|---|---|
| **Element** | `var(--spine-orange)` `var(--spine-white)` `var(--spine-ink)` |
| **Usage** | 모든 색 적용의 단일 출처 (화이트·잉크·오렌지 3색) |
| **States** | — |
| **금지** | HEX 하드코딩(`#E2531E` ❌), 오렌지 소형 본문 텍스트, 한 화면 오렌지 블록 3개+ |

#### 2. Wordmark
| | |
|---|---|
| **Element** | `.logo` (인라인 SVG) — `logo-wordmark-{v,h}-{ink,white}.svg` / currentColor |
| **Usage** | 로고 배치. 세로 2줄=프라이머리, 가로 1줄=헤더·명함 |
| **States** | `ink` / `white` / `current` (배경 따라 채움색 반전, 형태 동일) |
| **금지** | 비율 변형·기울임, 3선 두께·간격·개수 변경, 폰트 텍스트 대체, 클리어스페이스 침범 |

#### 3. Type Tag
| | |
|---|---|
| **Element** | `.mode` (컨테이너 `.modes`) — `WORK` · `CLASS` · `GATHERING` |
| **Usage** | 3타입 표기. Paperlogy 400 아웃라인 · 대문자 · 자간 +0.05em · 4pt 프레임 (소형 5~10mm) |
| **States** | `default` / `active`(현재 타입 = `var(--spine-orange)`) |
| **금지** | 소문자, "옵션·패키지" 워딩, 3개 외 임의 타입 |

`active` 상태 예시 — 버튼 UI가 아니라, 현재 타입을 오렌지로 표시하는 사이니지 태그다.

```tl-pills
WORK | CLASS · active* | GATHERING
```

#### 4. Pictogram
| | |
|---|---|
| **Element** | `picto-*.svg` **20종** (`04-signage/`) — 목록·규칙은 `signage.md`의 「04. 픽토그램」 |
| **Usage** | 편의·방향·금지 안내. viewBox 100 · 선 두께 2.7 · stroke를 아웃라인(면)으로 변환해 납품 |
| **States** | 단색(ink / white) · 포인트(orange) |
| **금지** | 세트 외 아이콘 혼용, 입체·장식, **텍스트 라벨 없이 단독 사용** |

#### 5. Directional Arrow
| | |
|---|---|
| **Element** | `.arrow` (SVG, 사각형 조립형 — 기하 도형 화살표) |
| **Usage** | 층·동선 길찾기. 도형·컬러블록이 먼저 안내 |
| **States** | `up` / `down` / `side` |
| **금지** | 글자만으로 길안내, 곡선·화려한·얇은 선 화살표 |

### 02b. Molecules — Atom 2~3개 조합

- **Floor Header** = `Directional Arrow` + `.floor`(층) + `.sub`(멀티유즈 라운지·합정). 층 안내 상단부.
- **Type Board** = `Type Tag` × 3 + `Pictogram`(타입 3종) + 한 줄 카피. 교체형 카드.
- **Guide Row** = `Pictogram` + `label/md` 텍스트(예: `[wifi] 와이파이`). 이용 가이드·웨이파인딩 한 줄.
- **Notice Sheet** = `Pictogram` + 제목 + 본문 + `Wordmark`. 실내 안내문 1장 — 세로 A5 고정 규격(`signage.md`의 「03. 안내문 템플릿」).
- **Business Card** = `Wordmark`(가로) + `Color Token` 면. 앞/뒤 2면.

### 02c. Organisms — 사인 인벤토리 (2026-08-06 설치 확정 5종)

> **설치 완료·확정본.** 이전 목업 단계의 "실버 알루미늄 + 반투명 골판 아크릴" 사양은 폐기됐다.
> 상세·사진·유도 시퀀스는 `signage.md`의 「02. 사인 인벤토리」.

| # | 사인 | 조합 | 물성 (확정) | 내용 |
|---|---|---|---|---|
| E-1 | **1층 입간판** | Floor Header + Wordmark + Type Board | **T형 아이보리 철제** (T자 베이스 자립형) | 계단 픽토 · TYPE LOUNGE · `WORK│GATHERING│CLASS` · `3F` · 영문 소개 카피 · Powered by NMWC |
| E-2 | **대문 현판** | Wordmark + Type Board | **무광 아크릴** | TYPE LOUNGE · `WORK│GATHERING│CLASS` · 영문 소개 카피 · Powered by NMWC |
| E-3 | **계단 중간 현판** | Wordmark + Floor Header | **무광 아크릴** | TYPE LOUNGE(우측 정렬) · 계단 픽토 + `3F` |
| I-1 | **자석 안내판** | Notice Sheet × N | 블랙 프레임 스틸 자석보드 + **세로 A5 트레이싱지 자석 레이어드** | 와이파이(QR·ID/PW) · 냉난방기 · 블루투스 스피커 · TV · 조명 |
| I-2 | **문 라벨** | Pictogram + `label` | 트레이싱지 + **실버 자석 메모홀더 클립 바** | `STAFF ROOM / Do not enter` · `TOILET` |

```tl-shots
assets/photo/stand-1f.jpg | E-1 | 1층 입간판 | T형 아이보리 철제
assets/photo/plate-gate.jpg | E-2 | 대문 현판 | 무광 아크릴
assets/photo/plate-stairs.jpg | E-3 | 계단 중간 현판 | 무광 아크릴 · 간유리면
assets/photo/board-magnet.jpg | I-1 | 자석 안내판 | 세로 A5 트레이싱지 자석 레이어드
assets/photo/label-staffroom.jpg | I-2 | 문 라벨 · 스태프룸 | 자석 메모홀더 클립 바
assets/photo/label-restroom.jpg | I-2 | 문 라벨 · 화장실 | 같은 문법
```

- 사진 원본: `07-brand-book/assets/photo/` — 설치 실물·유도 시퀀스의 정본은 `signage.md`의 「02. 사인 인벤토리」.
- **Notice Sheet**(신규 Molecule) = `Pictogram` + 제목 + 본문 + `Wordmark`. 세로 A5 420×595 고정 규격 — `signage.md`의 「03. 안내문 템플릿」, 생성기 `04-signage/gen_notice.py`.
- **레이어드 메커니즘** = 트레이싱지 인쇄물을 **자석으로 겹쳐 쌓기**(각인 대체). 오브제(원형 자석·실버 클립·오렌지 마스킹테이프)로 고정·장식하며, **오렌지는 이 오브제에만** 등장한다.
- 타입 태그 순서는 실물 기준 **`WORK │ GATHERING │ CLASS`**. 층 표기는 `3F`(국문 `3층` 아님).

---

## 03. Surface & Materials

물리 재질 위계. (디지털의 surface/elevation을 공간 재질로 치환.)

| 요소 | 재질(물성) | 비고 |
|---|---|---|
| 1층 입간판 | **T형 아이보리 철제** | 자립(T자 베이스) |
| 대문 현판 · 계단 중간 현판 | **무광 아크릴** | 벽면 · 간유리면 직접 부착 |
| 이용 가이드 보드 | 블랙 프레임 스틸 자석보드 | 반투명 트레이싱지 인쇄물 자석 부착 |
| 문 라벨 | 트레이싱지 | 실버 자석 메모홀더 클립 바 |
| 안내물 인쇄 | **반투명 트레이싱지** (세로 A5) | 한 겹 쌓인 레이어드 톤 |
| 포인트 | 오렌지 마스킹테이프 | 실버 클립 · 원형 자석과 함께 |

### 형태 토큰
| 토큰 | 값 | 비고 |
|---|---|---|
| `radius/sm` | 2px | 기하 — 거의 직각 |
| `radius/md` | 8px | 카드 |
| `space/*` | 4·8·16·24·40·64px | 8px 베이스 스케일 |

### 레이어드 메커니즘 (시그니처)
- **트레이싱지 인쇄물을 자석으로 겹쳐 쌓기**(각인 대체) — 겹쳐진 층이 곧 "모드의 겹침" 컨셉이다. 비용 절감이 1차 이유가 아니다.
- 안내문(I-1)은 **자석 교체형** — 내용이 바뀌면 종이 한 장만 다시 뽑아 갈아 끼운다.
- 문구 오브제(실버 클립·원형 자석·오렌지 마스킹테이프)로 레이어를 쌓고 고정 + 장식.

---

## 04. Iconography

→ 상세는 `brand.md`의 「04. Iconography」. 프로덕트 적용 규칙만:
- 모든 픽토그램은 **텍스트 라벨과 병행**(색·기호만으로 정보 전달 금지).
- 방향·자가안내 픽토(QR·입퇴실·결제)가 무인 운영에서 특히 중요.

---

## 05. States

컴포넌트 공통 상태.

| 상태 | 적용 | 표현 |
|---|---|---|
| `default` | Type Tag, 픽토 | 잉크 단색 |
| `active` | Type Tag(현재 타입) | `var(--spine-orange)` 강조 |
| `inverted` | Wordmark, 픽토 | 어두운/오렌지 배경 → 화이트 |
| `point` | 픽토 | 포인트 1색(orange) |

(예약 UI 추가 시 hover·focus·disabled·loading 등 인터랙션 상태 확장 — 「07. Reservation UI」.)

---

## 06. Accessibility (KWCAG 준용)

- **픽토그램 + 텍스트 라벨 병행** — 색·기호만으로 정보 전달 금지.
- **명도 대비 ≥ 4.5:1** — `spine/ink` on `spine/white` 충족. 오렌지는 대형/면에만.
- **한글 + 필요한 영문 병기**. 화장실·비상 동선 명확 표기.
- **낮은 층고 대응** — 시선 높이 사인 1.4~1.6m, 천장 행잉 지양(머리 충돌 방지).
- **모션** — `prefers-reduced-motion` 존중(예약 UI).

---

## 07. Reservation UI (추후 확장) — placeholder

> 무인 자동화 운영의 웹/앱 예약 화면. **현재 미구현 — 추가될 여지 있음(재은).** 자리만 확보.

추가 시 이 섹션에 웹 Atom을 아래 규칙으로 정의한다:
- 폰트 = **Paperlogy**(400/600), 색 = 위 Color Token 재사용.
- 예: `btn-primary` = `var(--spine-orange)` 배경 · 화이트 텍스트 / `:hover` = `motion/fast` 120ms.
- 예상 Atom: Button · Input · Card · Modal · Badge · Calendar(예약 슬롯).
- 예상 Organism: 예약 캘린더 · 타입 선택 · 결제 · 입퇴실 QR.
- 실제 화면·Figma가 생기면 그때의 컴포넌트 이름을 **그대로** 채운다(추정 금지).
