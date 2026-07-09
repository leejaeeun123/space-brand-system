# MODE LOUNGE — Product (Component System)

> 모드라운지 컴포넌트 시스템. 참조 구조: 모회사 노모컴퍼니(NMWC) 프로덕트(`nmwc.ai.kr/product`).
> **현재 프로덕트 = 공간 사이니지 · 인쇄물.** 예약 웹/앱은 추후 확장(§07).
> **Atom 먼저, Molecule/Organism은 Atom 조합으로.** 이름은 기존 HTML 실제 클래스(`.panel .mode .floor .logo .arrow`)와 토큰(`--spine-*`)을 그대로 채택.
> 원본: `06-applications/*.html`, `04-signage/signage-system.md` · `interior-wayfinding.md` · `pictograms.md`, `03-identity/design-tokens.md`.

**목차**: Principles · Components · Surface & Materials · Iconography · States · Accessibility · Reservation UI

> **표기 원칙**: "버튼은 파란색" ❌ → "`.mode` active, `var(--spine-orange)`" ✅. 색·크기는 항상 토큰으로 지시한다.

---

## 01. Principles

1. **자가안내 우선 (Self-guide first)** — 무인 자동화 운영. 사인이 곧 안내 데스크. 입실→이용→퇴실을 사용자가 혼자 완결.
2. **도형이 글자보다 먼저** — 도형·컬러블록 기반 직관 길찾기. 글자는 보조.
3. **소수·정밀·절제** — 52.49㎡ 작은 공간. 꼭 필요한 사인 5종만.
4. **레이어 분리** — 외부·창문은 컬러블록 과감, 실내는 우드·브라스·블랙 물성 중심(가구를 이기지 않게).
5. **낮은 층고(약 2m) 대응** — 시선 높이 사인 1.4~1.6m, 천장 행잉 지양.

---

## 02. Components

### 02a. Atoms — 자주 쓰는 컴포넌트 5개

#### 1. Color Token
| | |
|---|---|
| **Element** | `var(--spine-orange)` `var(--spine-cream)` `var(--spine-ink)` · `var(--block-green)` `var(--block-cobalt)` · `var(--material-brass)` `var(--material-walnut)` |
| **Usage** | 모든 색 적용의 단일 출처 |
| **States** | — |
| **금지** | HEX 하드코딩(`#E2531E` ❌), 오렌지·브라스 소형 본문 텍스트, 한 화면 컬러블록 3개+ |

#### 2. Wordmark
| | |
|---|---|
| **Element** | `.logo` (인라인 SVG) — `logo-wordmark-{v,h}-{ink,white}.svg` / currentColor |
| **Usage** | 로고 배치. 세로 2줄=프라이머리, 가로 1줄=헤더·명함 |
| **States** | `ink` / `white` / `current` (배경 따라 채움색 반전, 형태 동일) |
| **금지** | 비율 변형·기울임, 3선 두께·간격·개수 변경, 폰트 텍스트 대체, 클리어스페이스 침범 |

#### 3. Mode Tag
| | |
|---|---|
| **Element** | `.mode` (컨테이너 `.modes`) — `WORK` · `CLASS` · `GATHERING` |
| **Usage** | 3모드 표기. Paperlogy 600 · 대문자 · 자간 +0.12em · 가운뎃점 |
| **States** | `default` / `active`(현재 모드 = `var(--spine-orange)`) |
| **금지** | 소문자, "옵션·패키지" 워딩, 3개 외 임의 모드, 자간 좁힘 |

#### 4. Pictogram
| | |
|---|---|
| **Element** | `picto-*.svg` 9종 (`04-signage/`) — toilet(화장실)·wifi·coffee·stairs·room·umbrella·extinguisher·no·nosmoke |
| **Usage** | 편의·방향·금지 안내. 24×24 · 1.5px 스트로크 |
| **States** | 단색(ink / cream) · 포인트(orange) |
| **금지** | 세트 외 아이콘 혼용, 입체·장식, **텍스트 라벨 없이 단독 사용** |

#### 5. Directional Arrow
| | |
|---|---|
| **Element** | `.arrow` (SVG, 사각형 조립형 — 미드센추리 도형 화살표) |
| **Usage** | 층·동선 길찾기. 도형·컬러블록이 먼저 안내 |
| **States** | `up` / `down` / `side` |
| **금지** | 글자만으로 길안내, 곡선·화려한·얇은 선 화살표 |

### 02b. Molecules — Atom 2~3개 조합

- **Floor Header** = `Directional Arrow` + `.floor`(층) + `.sub`(멀티유즈 라운지·합정). 층 안내 상단부.
- **Mode Board** = `Mode Tag` × 3 + `Pictogram`(모드 3종) + 한 줄 카피. 교체형 카드.
- **Guide Row** = `Pictogram` + `label/md` 텍스트(예: `[wifi] 와이파이`). 이용 가이드·웨이파인딩 한 줄.
- **Business Card** = `Wordmark`(가로) + `Color Token` 면. 앞/뒤 2면.

### 02c. Organisms — 사인 인벤토리 (목업 기준 3종)

> 2026-07-05 컨셉맵 + 목업 기준. 재질은 **실버 철제·반투명 아크릴·트레이싱지·자석**으로 통일(각인 대체).

| 사인 | 조합 | 물성 | 내용 |
|---|---|---|---|
| **입간판 · 외부 명판** | Floor Header + Wordmark + Mode Board | 실버 알루미늄 프레임 + 반투명 골판 아크릴 | 화살표 + `3층` · MODE LOUNGE · 멀티유즈 라운지·합정 · WORK·CLASS·GATHERING |
| **자석 안내판**(이용 가이드) | Guide Row × N + Wordmark | 실버 자석보드 + 반투명 트레이싱지 인쇄물을 **자석으로 레이어드 겹침** | 간단한 가운데정렬 + 픽토그램 — WIFI(ID/PW), 모드별 안내(WORK MODE 등) |
| **아크릴 명패**(시설 표기) | Pictogram + `label` | 반투명 아크릴 + **투명 스티커 부착** | 오렌지 픽토 + 화장실 · 대문 MODE LOUNGE 등 이용시설 표기 |

- 목업: `06-applications/{stand,notice-board,restroom-signage,door-plate}-*.png`.
- **레이어드 메커니즘** = 반투명 아크릴·트레이싱지에 인쇄해 **자석으로 겹쳐 쌓기**(고가 각인 대체). 문구 오브제(클립·자석·마스킹테이프)로 고정·장식, 포인트는 스티커로.

---

## 03. Surface & Materials

물리 재질 위계. (디지털의 surface/elevation을 공간 재질로 치환.)

| 요소 | 재질(물성) | 비고 |
|---|---|---|
| 입간판 · 외부 명판 프레임 | 실버 알루미늄 프로파일(철제) | 반투명 골판 아크릴 패널 |
| 이용 가이드 보드 | 실버 자석보드 | 반투명 트레이싱지 인쇄물 자석 부착 |
| 시설 명패 | 반투명 아크릴 | 투명 스티커 부착(각인 대체) |
| 안내물 인쇄 | 종이 · **반투명 트레이싱지** | 한 겹 쌓인 레이어드 톤 |
| 포인트 | 오렌지 스티커 · 문구 오브제 | 클립·자석·마스킹테이프 |

### 형태 토큰
| 토큰 | 값 | 비고 |
|---|---|---|
| `radius/sm` | 2px | 기하 — 거의 직각 |
| `radius/md` | 8px | 카드 |
| `space/*` | 4·8·16·24·40·64px | 8px 베이스 스케일 |

### 레이어드 메커니즘 (시그니처)
- **반투명 아크릴 + 트레이싱지 인쇄** 부착(각인 대체) — "레이어드" 질감이 브랜드 컨셉과 일치.
- 모드 안내판(I-2)은 **자석/카드 슬롯 교체형** — 모드 전환 시 카드만 교체.
- 문구 오브제(클립·자석·마스킹테이프)로 레이어를 쌓고 고정 + 장식.

---

## 04. Iconography

→ 상세는 `brand.md` §04. 프로덕트 적용 규칙만:
- 모든 픽토그램은 **텍스트 라벨과 병행**(색·기호만으로 정보 전달 금지).
- 방향·자가안내 픽토(QR·입퇴실·결제)가 무인 운영에서 특히 중요.

---

## 05. States

컴포넌트 공통 상태.

| 상태 | 적용 | 표현 |
|---|---|---|
| `default` | Mode Tag, 픽토 | 잉크 단색 |
| `active` | Mode Tag(현재 모드) | `var(--spine-orange)` 강조 |
| `inverted` | Wordmark, 픽토 | 어두운/오렌지 배경 → 화이트 |
| `point` | 픽토 | 포인트 1색(orange) |

(예약 UI 추가 시 hover·focus·disabled·loading 등 인터랙션 상태 확장 — §07.)

---

## 06. Accessibility (KWCAG 준용)

- **픽토그램 + 텍스트 라벨 병행** — 색·기호만으로 정보 전달 금지.
- **명도 대비 ≥ 4.5:1** — `spine/ink` on `spine/cream` 충족. 오렌지·브라스는 대형/면에만.
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
- 예상 Organism: 예약 캘린더 · 모드 선택 · 결제 · 입퇴실 QR.
- 실제 화면·Figma가 생기면 그때의 컴포넌트 이름을 **그대로** 채운다(추정 금지).
