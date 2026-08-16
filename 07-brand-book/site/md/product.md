# TYPE LOUNGE — Product (Component System)

> 타입라운지 컴포넌트 시스템.
> **프로덕트 = 공간 사이니지 · 인쇄물 + 운영 웹 3종**(이용 안내 · 공간 제어 · 어드민 — 「07. Web」).
> **Atom 먼저, Molecule/Organism은 Atom 조합으로.** 이름은 기존 HTML 실제 클래스(`.panel .mode .floor .logo .arrow`)와 토큰(`--spine-*`)을 그대로 채택.
> **공간 사이니지의 확정 사양·설치 실물·안내문 템플릿은 `signage.md`가 정본이다.** 이 문서는 컴포넌트(Atom/Molecule/Organism) 관점만 다룬다.

**목차**: Principles · Components · Surface & Materials · Iconography · States · Accessibility · Web

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

> 여기서는 **어떤 Atom·Molecule으로 조립되는가**만 적는다.
> 위치·물성·내용·설치 사진·유도 시퀀스는 `signage.md`의 「02. 사인 인벤토리」가 정본이다 — 양쪽에 두면 발주 사양이 한쪽만 고쳐진다.

| # | 사인 | 조합 |
|---|---|---|
| E-1 | **1층 입간판** | Floor Header + Wordmark + Type Board |
| E-2 | **대문 현판** | Wordmark + Type Board |
| E-3 | **계단 중간 현판** | Wordmark + Floor Header |
| I-1 | **자석 안내판** | Notice Sheet × N |
| I-2 | **문 라벨** | Pictogram + `label` |

- **Notice Sheet**(신규 Molecule) = `Pictogram` + 제목 + 본문 + `Wordmark`. 세로 A5 420×595 고정 규격 — `signage.md`의 「03. 안내문 템플릿」, 생성기 `04-signage/gen_notice.py`.
- 다섯 종이 전부 같은 Atom 다섯 개에서 나온다. **새 사인을 만들기 전에 기존 조합으로 되는지부터 본다.**
- 조립 시 고정값: 타입 태그 순서는 실물 기준 **`WORK │ GATHERING │ CLASS`**, 층 표기는 `3F`(국문 `3층` 아님).

---

## 03. Surface & Materials

물리 재질 위계. (디지털의 surface/elevation을 공간 재질로 치환.)

**재질·부착 사양표의 정본은 `signage.md`의 「05. 재질 · 부착 위계」다.** 발주에 쓰는 값이라 한 곳에만 둔다.
여기서는 컴포넌트가 재질에 의존하는 지점만 적는다.

- 인쇄물 Atom(Notice Sheet · 문 라벨)은 **반투명 트레이싱지**를 전제로 그린다 — 뒤 레이어가 비쳐 보이므로 여백을 재질의 일부로 취급한다.
- 오렌지는 인쇄면이 아니라 **고정 오브제**(마스킹테이프 · 실버 클립 · 원형 자석)에만 올라간다. 컴포넌트 안에 오렌지 면을 넣지 않는 이유다.
- 겹쳐 쌓는 레이어드 메커니즘 자체는 `signage.md`의 「03. 부착 방식이 디자인의 일부다」.

### 형태 토큰
| 토큰 | 값 | 비고 |
|---|---|---|
| `radius/sm` | 2px | 기하 — 거의 직각 |
| `radius/md` | 8px | 카드 |
| `space/*` | 4·8·16·24·40·64px | 8px 베이스 스케일 |

> 형태 토큰의 정본은 이 문서다(원본 `03-identity/design-tokens.md`). 사이니지 도면도 이 값을 쓴다.

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

(웹 화면의 인터랙션 상태·터치 타겟은 「07. Web」.)

---

## 06. Accessibility (KWCAG 준용)

- **픽토그램 + 텍스트 라벨 병행** — 색·기호만으로 정보 전달 금지.
- **명도 대비 ≥ 4.5:1** — `spine/ink` on `spine/white` 충족. 오렌지는 대형/면에만.
- **한글 + 필요한 영문 병기**. 화장실·비상 동선 명확 표기.
- **낮은 층고 대응** — 시선 높이 사인 1.4~1.6m, 천장 행잉 지양(머리 충돌 방지).
- **모션** — `prefers-reduced-motion` 존중(예약 UI).

---

## 07. Web (운영 화면)

무인 운영을 실제로 굴리는 웹 3종. **모두 라이브다** — 정본은 `06-applications/`의 각 HTML이고,
여기서는 컴포넌트 관점만 적는다. 손님이 QR·이용 안내 CRM으로 들어오는 접점이라 사이니지와 한 몸이다.

| 화면 | 주소 | 쓰는 사람 | 접속 |
|---|---|---|---|
| **이용 안내** `guest-guide.html` | [typelounge.vercel.app](https://typelounge.vercel.app/) | 손님 | 공개 |
| **공간 제어** `guest-control.html` | [/control](https://typelounge.vercel.app/control) | 손님 | `GUEST_PASSWORD` |
| **예약 관리 어드민** `admin.html` | [/admin](https://typelounge.vercel.app/admin) | 운영자 | 어드민 비밀번호 |

> 손님은 **공간 QR·이용 안내 CRM**을 통해 `/control` 로 들어온다. 사이니지가 이 링크의 출발점이라
> 안내문 문구가 바뀌면 이 화면도 같이 봐야 한다.

### 07a. Web Atoms

토큰 이름은 웹에서 **짧은 형(`--ink` `--white` `--orange` `--hair` `--mute`)** 을 쓴다.
사이니지 문서의 `--spine-*` 와 같은 3색이지만, 코드에 있는 이름이 이 문서의 이름이다(원칙 2).

| Atom | 실제 | 사양 |
|---|---|---|
| **Wordmark** | `.wordmark` | 600 · 34px · 자간 -0.02em. 세 화면 모두 헤더 자리에 단독 |
| **Section Label** | `h2` | 600 · 13px · 대문자 · 자간 +0.14em · `var(--orange)`. 오렌지가 본문이 아니라 **라벨에만** 오는 자리 |
| **Card** | `.dev-card` `.notice` | 흰 배경 · `1px var(--hair)` · `radius/md` 8px · 패딩 14~16px |
| **Button** | `.all-row button` `.add-btn` `.dev-btn` | 흰 배경 · 잉크 텍스트 · 헤어라인 테두리 · 8px · **최소 높이 48~52px** |
| **Pill** | `.status-btn` `.temp-input` | `radius/999px`. 완료는 `.done` = 잉크 반전 |
| **Modal** | `.modal-box` | 12px · 최대 280px · 오버레이 `rgba(22,19,15,.45)` |

### 07b. Organisms

- **이용 안내** = 찾아오는 길(지도) + 공간 이용법 + 시설 + 안내(CCTV·쓰레기·퇴실) + 안내문 다운로드.
  실내 안내문(`signage.md`「03」)과 **같은 문구**를 말한다 — 둘이 어긋나면 손님이 먼저 안다.
- **공간 제어** = 비밀번호 게이트(`들어가기`) → 전체 켜기/끄기 → 기기 카드(온도 `−`/`+` · 모드 · 바람) + 상태 새로고침.
- **어드민** = 사이드 탭(`예약관리` · `공간 제어` · `CCTV`) + 예약 캘린더 + 기기 관리 + 실시간·녹화 되감기.

### 07c. 손가락이 기준이다

- **터치 타겟 44~52px.** 온도 입력의 스피너를 죽인 이유가 여기 있다 — 48px 안에 2px 화살표가 생기면 못 누른다.
- **폭 320px 기준**으로 버튼 4개가 들어가야 한다. 넘치면 폰트를 줄이지 말고 패딩을 줄이고 줄바꿈을 허용한다.
- 상태는 **색만으로 말하지 않는다** — `ON`/`OFF` 글자와 함께 간다(06. Accessibility).
- 오렌지는 라벨·경고(`.warn`)·삭제(`.del-btn`)에만. 인쇄물에서 오렌지를 오브제로 제한한 것과 같은 규칙이다.

### 아직 없는 것

**예약 화면은 어드민에서 운영자가 넣는다.** 손님이 직접 잡는 예약 UI(캘린더·타입 선택·결제·입퇴실 QR)는
아직 없다. 생기면 위 Atom을 그대로 쓰고, 그때의 컴포넌트 이름을 **그대로** 채운다(추정 금지).