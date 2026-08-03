# space-brand-system

**타입라운지(TYPE LOUNGE)** — 합정역 3층 멀티유즈 라운지의 **브랜드 시스템 + 무인 운영 시스템**.
전략·네이밍·아이덴티티·사이니지 정본과, 실제로 공간을 돌리는 예약 어드민·자동화·공간 제어·CCTV가
한 레포에 있다.

## 현재 상태 (2026-08-03)

브랜드는 확정됐고, 운영 시스템은 라이브다.

| | |
|---|---|
| 공간 | 서울 마포구 월드컵로3길 31-32, 3층 · 전용 52.49㎡ · **층고 약 2m** |
| 용도 | 회의실 / 촬영 스튜디오 / 파티룸(모임) — **무인 자동화 운영(셀프 이용)** |
| 판매 채널 | 스페이스클라우드 `[오픈특가]TYPE LOUNGE` |
| 네이밍 | 🟢 **타입라운지 (TYPE LOUNGE)** 확정 (2026-06-25) |
| 로고 | 🟢 **레이어드 E 워드마크 단독 — 심볼 없음** (2026-07-05 · 이전 겹침·팬 심볼안은 폐기) |
| 폰트 | 🟢 **Paperlogy 단일** · 400/600 2웨이트 (2026-07-06) |
| 컬러 | 🟢 **화이트 · 잉크 · 오렌지 3색** (2026-07-12) |
| 라이브 | 게스트 가이드 `typelounge.vercel.app` · 어드민 `/admin` |

## 어디부터 보나

| 하려는 일 | 문서 |
|---|---|
| 브랜드 전체 훑기 | [`05-design-system/README.md`](./05-design-system/README.md) — 우산 문서 |
| 로고·컬러·타이포 쓰기 | [`07-brand-book/brand.md`](./07-brand-book/brand.md) · 토큰 원본 [`03-identity/design-tokens.md`](./03-identity/design-tokens.md) |
| 카피 쓰기 · 톤 맞추기 | [`07-brand-book/bx.md`](./07-brand-book/bx.md) |
| 사이니지·인쇄물 만들기 | [`07-brand-book/product.md`](./07-brand-book/product.md) · [`04-signage/`](./04-signage/) |
| **합정 맥 세팅(현장)** | [`06-applications/onsite-handoff.md`](./06-applications/onsite-handoff.md) ← 여기부터 |
| 예약이 왜 자동으로 들어오나 | [`06-applications/automation/README.md`](./06-applications/automation/README.md) |

## 구조

```
CLAUDE.md          작업 규칙 — 정본 우선순위·PR 방식·되돌리면 안 되는 결정
PLAN.md            초기 구축 계획 (이력 — 현재 상태는 이 README가 말한다)
01-strategy/       discovery · positioning · personas · brand-voice · visual-principles · moodboard
02-naming/         naming-criteria · candidates · validation
03-identity/       logo-system(로고 정본) · color-palette · typography · design-tokens
                   + 로고 SVG · 탐색 시안 HTML(v2~v18)
04-signage/        signage-system · exterior-signage · interior-wayfinding · pictograms · notice-copy
05-design-system/  README (우산 문서) · concept-keywords
06-applications/   admin.html · guest-guide.html · 사이니지 시안 · 목업 PNG · 설치 체크리스트(control/cctv/onsite)
                   automation/     스페이스클라우드 예약 자동 반영 (파트너 API + Gmail)
                   control-agent/  합정 상주 맥 에이전트 (MQTT 중계 + MediaMTX 관찰)
07-brand-book/     brand · bx · product (+ 렌더 HTML) — 위 정본에서 파생된 문서
supabase/          migrations/ · functions/control/ (Edge Function)
public/            배포 대상 — 06-applications/ 심링크
assets/            무드보드 · 레퍼런스 · 목업
```

## 운영 시스템

손님은 스페이스클라우드에서 예약하고, 예약은 자동으로 DB에 들어오며, 조명·냉난방·CCTV는 어드민 한
화면에서 다룬다. 현장에 사람이 상주하지 않는다.

| 영역 | 무엇 | 어디 |
|---|---|---|
| 게스트 가이드 | 이용 안내 + 영상정보처리기기 법정 고지 | `06-applications/guest-guide.html` → `/` |
| 어드민 | 입장 · 예약관리 · 공간 제어 · CCTV | `06-applications/admin.html` → `/admin` |
| 예약 자동 반영 | 파트너 API(주) + Gmail 15분 트리거(백업) → Supabase RPC | [`automation/`](./06-applications/automation/README.md) |
| 냉난방 | LG ThinQ Cloud API (HTTPS) — 현장 장비 불필요 | [`functions/control/`](./supabase/functions/control/README.md) |
| 조명 | Tasmota → 로컬 mosquitto → 상주 에이전트 → Supabase Realtime | [`control-agent/`](./06-applications/control-agent/README.md) |
| CCTV | Tapo RTSP → MediaMTX(녹화 7일) → cloudflared → 어드민 | [`cctv-setup.md`](./06-applications/cctv-setup.md) |

**합정에 맥 1대가 상주한다** — 조명과 CCTV가 여기에 의존한다(냉난방은 클라우드라 무관).
**영상은 Supabase를 지나가지 않는다** — 서버는 '카메라가 살아 있나'만 알고, 프레임은
브라우저가 합정 맥에서 직접 받는다. 카메라는 **출입구(`entrance`) + 실내 라운지(`lounge`) 2대**다.

### 배포

`main`에 머지되면 GitHub Actions가 Vercel로 올린다(`public/**` · `admin.html` · `guest-guide.html` ·
`vercel.json` 변경 시). `public/`은 `06-applications/`를 가리키는 **심링크**라 원본만 고치면 된다.

## 남은 일

1. `[대기]` **가격대** — 확정 시 포지셔닝 톤 재조정
2. **상표(KIPRIS 43·41류)·도메인·SNS 핸들 라이브 확인** — `02-naming/validation.md` §0
3. **`ux.md`** — 앱·무인 자동화 UX 문서만 아직 없다(brand·bx·product는 작성 완료)
4. **CCTV 실기기 검증** — 카메라 미구매. 가짜 스트림로 전 구간(C-4b)은 밟을 수 있다

> 작업 규칙·정본 우선순위·되돌리면 안 되는 결정은 **[CLAUDE.md](./CLAUDE.md)** 에 있다.
