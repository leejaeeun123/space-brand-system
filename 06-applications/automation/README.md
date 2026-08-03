# SpaceCloud 예약 자동 반영

`admin.html`이 쓰는 Supabase RPC(`admin_add_reservation` / `admin_set_cancelled`)로 스페이스클라우드
예약을 반영한다. **경로가 둘이다 — API가 주 경로, Gmail이 백업.**

| | 파일 | 역할 |
|---|---|---|
| **주** | `spacecloud-api-sync.js` | 파트너 API에서 직접 수집. 연락처·이메일·인원·사용목적까지 채운다. 수동 실행 |
| **백업** | `spacecloud-gmail-sync.gs` | 알림 메일 파싱. 15분 트리거로 항상 돌아 누락을 막는다 |

두 경로 모두 예약번호(`booking_no`)로 중복을 거르므로 **같이 돌아도 안전하다**
(DB에도 `booking_no` unique index가 있다). 어느 쪽이 먼저 넣든 나중 것은 건너뛴다.

**왜 둘 다 두는가** — API는 데이터가 완전하지만 24시간마다 사람이 재로그인해야 하고 브라우저가 필요하다.
Gmail은 필드가 부실하지만 구글 서버에서 무인으로 항상 돈다. 서로의 구멍을 정확히 메운다.
특히 **취소건은 API가 예약자명을 마스킹**(`윤**`)하고 연락처를 안 주는데, Gmail 취소 메일에는 실명이 온다.

---

## 백업 경로 — Gmail → Supabase

`office@spacecloud.kr`에서 오는 "예약 완료"/"취소 완료" 메일을 감지해 자동 반영하는 Google Apps Script.

## 설치

1. https://script.google.com → 새 프로젝트 생성 (Gmail을 수신하는 계정, 즉 `nmwc.ai@gmail.com`으로 로그인한 상태에서).
2. `spacecloud-gmail-sync.gs` 내용을 통째로 붙여넣기.
3. 좌측 톱니바퀴(프로젝트 설정) → **스크립트 속성** → 속성 추가:
   - 키: `ADMIN_PASSWORD`
   - 값: `admin.html` 로그인에 쓰는 그 관리자 비밀번호
   - 키: `MATTERMOST_WEBHOOK_URL`
   - 값: `https://mm.nmwc.ai.kr/hooks/<웹훅 ID>` (Mattermost 알림용. 아래 "Mattermost 알림" 참고. 비워두면 알림만 조용히 생략되고 예약 처리는 정상 동작)
4. 함수 선택 드롭다운에서 `createTrigger` 선택 후 실행 → Gmail 권한 승인 팝업 승인.
   (15분마다 `processSpaceCloudReservations`를 도는 트리거가 1회 생성됨)
5. 확인: `processSpaceCloudReservations`를 수동으로 한 번 실행해보고 실행 로그(보기 → 실행 기록)에서 에러가 없는지 확인.

## 동작 방식

- 검색 쿼리: `from:office@spacecloud.kr subject:("예약 완료" OR "취소 완료") -label:spacecloud-processed -label:spacecloud-error`
- **예약 완료 메일**: 본문 표(예약공간·예약내용·예약인원·예약옵션·요청사항·예약자명·결제수단·결제금액)를 정규식으로 추출해 `admin_add_reservation` 호출.
  - "MY 예약 상세 페이지" 링크에서 예약번호(예: `10388381`)를 함께 추출해 `p_booking_no`로 저장.
  - `예약공간`(예: `[오픈특가]TYPE LOUNGE`)은 별도 컬럼이 없어 `p_memo`에 원문 그대로 저장.
- **취소 완료 메일**: 예약번호가 없어 (날짜, 시작/종료 시간)으로 기존 예약을 찾아 `admin_set_cancelled`로 **삭제가 아닌 상태 변경**만 수행 (`cancelled = true`). admin.html에는 "취소됨" 배지로 표시됨.
  - 일치하는 예약을 못 찾으면(예: 자동화 도입 전에 만들어진 예약) 에러로 처리 — 실패 알림 메일로 수동 확인 유도.
- 처리된 스레드는 `spacecloud-processed` 라벨을, 파싱/등록/취소 실패 시 `spacecloud-error` 라벨을 붙이고 실행 계정 메일로 실패 알림을 보냄 (재처리 대상에서 제외되므로 원인 해결 후 라벨을 수동으로 떼어내면 다음 실행 때 재시도됨).
- 중복 등록 방지: `LockService`로 동시 실행(수동 실행과 15분 트리거가 겹치는 경우 등)을 막고, 예약번호가 이미 등록돼 있으면 등록을 건너뜀. DB에도 `booking_no` unique index가 있어 이중 안전장치.

## Mattermost 알림

예약 등록 / 취소 반영 / 처리 실패가 발생하면 Mattermost `e-alert-typelounge` 채널로 알림을 보낸다.

- 발송 경로: Mattermost **인커밍 웹훅**. URL은 커밋하지 않고 스크립트 속성 `MATTERMOST_WEBHOOK_URL`로만 주입한다.
- 반드시 공개 주소(`https://mm.nmwc.ai.kr/hooks/...`)를 쓴다. Apps Script는 구글 서버에서 실행되므로 `localhost:8065`에 도달할 수 없다.
- 알림 시점은 각 RPC가 **성공한 뒤**다. 중복 예약으로 등록을 건너뛴 경우엔 알리지 않는다.
- **알림 실패는 예약 처리에 영향을 주지 않는다.** `notifyMattermost`는 모든 예외를 삼키고 로그만 남긴다. 이렇게 하지 않으면 Mattermost가 잠시 죽었을 때 정상 등록된 예약까지 `spacecloud-error` 라벨이 붙어 재처리 대상에서 빠진다.
- 서버가 맥에서 cloudflared 터널로 노출되므로, 맥이 잠들어 있으면 알림만 유실되고 예약 데이터는 정상 반영된다.
- 알림 지연은 최대 15분(트리거 주기)이다.
- 요청사항처럼 자유 입력 값에 `|`나 개행이 들어와도 표가 깨지지 않도록 무해화한다.

## 범위 / 제약

- 스페이스클라우드(`스클`) 메일만 처리. 네이버 예약 메일은 다루지 않음(추가 필요 시 `GMAIL_QUERY`와 파싱 함수를 확장).
- 취소는 (날짜+시작+종료 시간) 일치로만 찾음 — 같은 시간대에 동시 예약이 2건 이상 있는 경우는 가정하지 않음(단일 공간 운영이라 실질적으로 불가능).
- 인당/전화/이메일 등 이 메일에 없는 필드는 비워둠 → **주 경로(API)가 이 구멍을 메운다.**

---

## 주 경로 — 파트너 API → Supabase

`spacecloud-api-sync.js`. 호스트센터 프론트가 쓰는 내부 REST API에서 예약을 직접 받아온다.

### 실행

1. 크롬에서 `https://partner.spacecloud.kr/reservation` 열기 (로그인 상태)
2. 개발자도구 콘솔에 `spacecloud-api-sync.js` 전체를 붙여넣기
3. 실행:
   ```js
   await scSync.run('<admin.html 비밀번호>', { dryRun: true })  // 미리보기, DB 변경 없음
   await scSync.run('<admin.html 비밀번호>')                    // 신규 예약 등록 + 취소 반영
   await scSync.fillContacts('<admin.html 비밀번호>')           // 기존 예약의 빈 연락처·이메일만 백필
   await scSync.fetchAll()                                      // 수집만 (비밀번호 불필요)
   ```

예약번호로 중복을 거르므로 **몇 번을 돌려도 안전하다.**

### 연락처 백필 (`fillContacts`)

Gmail 경로로 들어온 예약은 연락처·이메일이 비어 있다. 이걸 사후에 메우는 전용 경로다.
`admin_fill_contact` RPC(`supabase/migrations/20260803020000_admin_fill_contact.sql`)를 쓰며,
**이미 값이 있는 칸은 절대 덮어쓰지 않는다** — 수동으로 고친 값이 API 값에 밀리지 않도록.

2026-08-03 최초 백필 결과:

- 연락처 3건 반영 — `10388751`·`10388716`·`10388381`
- 자동화 도입 전 예약 2건 신규 등록 — `10361422`(이용완료)·`10340295`(취소, 마스킹 상태로 등록)
- `10388712`는 취소건이라 API가 연락처를 주지 않았지만, 같은 예약자(윤단비)의 확정 건과
  동일인이 확인되어 수동으로 채움 — **API 자동 백필로는 절대 안 채워지는 값이다.**

결과: DB 9건이 파트너 API 9건과 일치하고, 그중 8건이 연락처를 갖췄다.
남은 `10340295`는 취소·마스킹 상태라 어느 경로로도 연락처를 얻을 수 없다.

### 인증 — 24시간마다 재로그인이 필요하다

2026-08-03 실측으로 확인된 제약:

| 항목 | 결과 |
|---|---|
| 토큰 위치 | `localStorage["spacecloud__userInfo"].accessToken` |
| 헤더 | `Authorization: Bearer <token>` |
| 수명 | **정확히 24시간** (JWT 클레임은 `partner_id`·`exp` 뿐) |
| 리프레시 토큰 | **없음** |
| 인증 쿠키 | **없음** (쿠키는 전부 GA·채널톡·Datadog) |
| `/partner/users/get_token`으로 자체 갱신 | **불가** (401 `Missing token` — 소셜 콜백 전용) |

즉 만료되면 **재로그인만이 유일한 길**이다. 두 경로가 있고 **둘 다 동작을 확인했다**:

- **A. 네이버 OAuth (권장)** — 로그인 페이지에서 "네이버로 호스트 로그인" 클릭 한 번.
  비밀번호가 개입하지 않고, 네이버 세션만 살아 있으면 리다이렉트만으로 새 24시간 토큰이 발급된다.
  `scSync.ensureSession()`이 이 버튼을 눌러준다. 계정은 네이버 연동만 켜져 있다(카카오 OFF).
- **B. 이메일+비밀번호 (폴백)** — 크롬 자동입력이 채워둔 폼을 제출. 2026-08-03 통과 확인.
  단 Cloudflare Turnstile(invisible 모드)이 걸려 있고, 자동입력은 그 크롬 프로필에만 있으므로
  **다른 프로필·헤드리스 환경으로는 이식되지 않는다.** A가 막혔을 때만 쓴다.

네이버 세션 자체가 끊기면(몇 달에 한 번) 그때만 사람이 네이버에 로그인하면 된다.

### 엔드포인트

베이스: `https://api.spacecloud.kr`

| 용도 | 엔드포인트 |
|---|---|
| 예약 목록 (페이지네이션) | `GET /partner/reservations?page=N` |
| 예약 상세 | `GET /partner/reservations/:id` |
| 예약 승인 / 취소 | `POST .../approve`, `.../cancel` |
| 변경요청 승인 / 거절 | `.../reservation_change_requests/:changeId/{approve,reject}` |
| 공간·상품·가격 | `/partner/spaces/*`, `/partner/products/*` |
| 문의·리뷰 답글 | `/partner/questions/*`, `/partner/reviews/:id/comments` |
| 운영 리포트 | `/partner/operation_reports` |

**연락처·이메일·인원·요청사항은 목록에 없고 상세에만 있다** — 그래서 건별로 상세를 한 번 더 부른다.

상태 코드: `RSCMP` 예약확정 · `USEDC` 이용완료 · `RCCMP` 취소완료 / `PAYCP` 결제완료 · `REFND` 환불

### ⚠️ `end_hour`는 포함(inclusive)이다

API가 `start_hour:"16", end_hour:"18"`이면 **실제 이용은 16시~19시 3시간**이다.
호스트 페이지에도 "16~19 시, 3 시간"으로 표시된다. 그래서 `p_end`는 반드시 `end_hour + 1`.

2026-08-03 예약 9건 전수 대조로 확인했다. 단가로도 교차 검증된다 —
`13-20 / 64,000원`은 inclusive 8시간 × 8,000원으로 정확히 떨어지지만
exclusive 7시간이면 9,142.86원이라는 단가가 나온다.

**이걸 놓치면 모든 예약이 1시간씩 짧게 들어간다.**

### 제약

- **비공식 API다.** 호스트센터 프론트(CRA SPA)가 쓰는 내부 엔드포인트로, 문서화된 공개 API가 아니다.
  예고 없이 스펙이 바뀔 수 있다 — 그래서 Gmail 백업 경로를 유지한다.
- **취소건은 개인정보가 마스킹된다.** `RCCMP` 상태면 예약자명이 `윤**`로 오고 연락처·이메일이 아예 없다.
  확정 시점에 미리 수집해두지 않으면 그 손님 연락처는 영구히 못 가져온다.
  스크립트는 이런 건을 `maskedAdds`로 따로 보고한다. 실명이 필요하면 Gmail 취소 메일을 보면 된다.
- **브라우저가 필요하다.** 토큰이 브라우저 localStorage에만 있어 서버 단독 실행이 불가능하다.
- `end_hour`가 23이면 `p_end`가 `24:00`이 된다. PostgreSQL `time` 타입은 이 값을 받지만,
  운영 시간상 실제로 발생한 적은 없다.
