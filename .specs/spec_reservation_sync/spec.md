# spec_reservation_sync

> 스페이스클라우드에서 들어온 예약과 취소를 사람 손 없이 타입라운지 DB(`reservations` 테이블)로
> 옮기는 기능. 파트너 API(주 경로)와 알림 메일 파싱(백업 경로) 두 갈래가 같은 Supabase RPC로 모인다.

## 1. 개요

타입라운지는 무인 운영이라 예약이 들어와도 그것을 옮겨 적을 사람이 없다. 그런데 이 레포의 거의 모든
기능 — 입실·퇴실 기기 자동화, 안내 문자, 손님 제어 페이지의 시간창, 청소 스케줄 — 이 `reservations`
테이블 한 곳을 보고 돈다. **예약이 DB에 없으면 그 예약은 시스템에 존재하지 않는다.**

그래서 수집 경로를 둘 둔다. 하나가 죽어도 다른 하나가 받아낸다.

| | 파일 | 성격 | 주기 | 강점 | 약점 |
|---|---|---|---|---|---|
| **주** | `spacecloud-api-sync.js` | 브라우저 콘솔에서 사람이 실행 | 수동(반자동) | 연락처·이메일·인원·사용목적까지 완전 | 토큰이 24시간이면 죽고 갱신에 사람이 필요 |
| **백업** | `spacecloud-gmail-sync.gs` | Google Apps Script 무인 실행 | 15분 | 구글 서버에서 항상 돈다 | 알림 메일에 연락처·이메일·사용목적이 없다 |

두 경로 모두 **예약번호(`booking_no`)로 중복을 거른다.** DB에도 partial unique 인덱스가 있어
어느 쪽이 먼저 넣든 나중 것은 조용히 건너뛴다 — 같이 돌아도 안전하고, 몇 번을 돌려도 결과가 같다.

서로의 구멍이 정확히 맞물린다. 취소건은 **파트너 API가 예약자명을 마스킹**(`윤**`)하고 연락처를
주지 않는 반면, **Gmail 취소 메일에는 실명이 온다.** 반대로 연락처·이메일은 메일에 아예 실려오지
않고 API에만 있다 — 그 구멍은 백필(`fillContacts`)이 사후에 메운다.

### 이 스펙이 하지 않는 것 (Non-Requirements)

| 안 하는 것 | 사유 / 소유 스펙 |
|---|---|
| 안내 문자 발송·문구·장부 | `spec_guest_sms`가 소유한다. 이 스펙은 `sms_auto`·`deposit_required` 컬럼을 읽지도 쓰지도 않는다 |
| 입실·퇴실 기기 자동화, 시간창 판정 | `spec_reservation_automation`·`spec_space_control`. 이 스펙은 자동화가 읽을 행을 만들어 놓기만 한다 |
| 어드민 예약 관리 화면(캘린더·수동 추가·삭제·입퇴실 체크·시간 수정 모달) | 별도 스펙 없음 — 요구사항 정본은 PRD EPIC 1(US-1.5·US-1.6, `docs/prd/typelounge-ops/typelounge-ops-PRD.md`). 다만 이 스펙의 두 스크립트가 어드민과 **같은 RPC**를 쓴다 |
| 네이버 예약 등 스클 외 채널 | 처리 대상이 아니다. 추가하려면 `GMAIL_QUERY`와 파싱 함수를 확장해야 한다 |
| 예약 승인·취소를 스클 쪽으로 **되쓰기** | 파트너 API에 `approve`·`cancel` 엔드포인트가 있지만 쓰지 않는다. 이 스펙은 단방향 수집이다 |
| 파트너 토큰 무인 갱신 | 2026-08-04 실측으로 불가 판정(네이버 세션 없이는 로그인 폼에서 멈춘다). 반자동이 상한이다 |

## 기술 스택

프로젝트 공통(Supabase PostgreSQL · PostgREST RPC · PL/pgSQL `security definer` 함수)
+ 이 스펙 고유:

- **Google Apps Script** — `GmailApp`(검색·라벨), `PropertiesService`(스크립트 속성: 비밀번호·웹훅 URL·
  처리 기록), `LockService`(동시 실행 방지), `UrlFetchApp`(RPC·웹훅 호출), `MailApp`(실패 통보),
  `ScriptApp` 시간 기반 트리거, `Utilities.formatDate`(Asia/Seoul).
- **브라우저 콘솔 스크립트** — 의존성 없는 ES5 IIFE(`var scSync = (function(){...})()`).
  임포트가 불가능한 실행 환경(콘솔 붙여넣기)이라 **한 파일로 유지한다** — 소스 상단 주석에 근거가 있다.
  `fetch`·`localStorage`·`atob`만 쓴다.
- **스페이스클라우드 파트너 API** — 호스트센터 프론트가 쓰는 **비공식 내부 REST API**
  (`https://api.spacecloud.kr`). 문서화된 공개 API가 아니라 예고 없이 바뀔 수 있다 — 백업 경로를
  유지하는 이유가 이것이다.
- **Mattermost 인커밍 웹훅** — 등록·취소·실패·감사 알림. URL은 커밋하지 않고 스크립트 속성으로만 주입한다.

## 실행 환경

런타임이 셋이고, 셋의 성질이 이 기능의 설계를 거의 다 결정한다.

| 런타임 | 어디서 | 언제 | 제약 |
|---|---|---|---|
| Apps Script | Google 서버 (`nmwc.ai@gmail.com` 프로젝트) | `processSpaceCloudReservations` 15분 트리거 · `dailyAudit` 매일 09시 | 스크립트 속성 1개당 9KB 상한 → 처리 기록 300건 제한. 실행마다 전역 변수가 초기화된다 |
| 크롬 콘솔 | 운영자 PC, `partner.spacecloud.kr` 탭 | 사람이 실행할 때만 | 토큰이 브라우저 `localStorage`에만 있어 서버 단독 실행 불가. 토큰 수명 24시간, 리프레시 토큰 없음 |
| Supabase PostgreSQL | 클라우드 | 항상 | RPC는 anon key + 어드민 비밀번호로 인가. `admin_check`가 뿌리 |

- 배포 절차가 없다. Gmail 경로는 Apps Script 편집기에 파일 내용을 붙여넣고 `createTrigger()`를 1회
  실행하는 것이 설치의 전부이고, API 경로는 매번 콘솔에 붙여넣어 쓴다. 레포의 두 파일은 **원본 보관처**다.
- 시크릿은 코드에 넣지 않는다: 어드민 비밀번호는 스크립트 속성 `ADMIN_PASSWORD`(Gmail) 또는 콘솔
  인자(API), 웹훅 URL은 스크립트 속성 `MATTERMOST_WEBHOOK_URL`, 파트너 토큰은 브라우저 `localStorage`.
- Mattermost 서버는 현장 맥에서 cloudflared 터널로 노출된다. 맥이 잠들어 있으면 **알림만 유실되고
  예약 데이터는 정상 반영된다** — 알림 실패가 처리 결과를 오염시키지 않도록 예외를 전부 삼킨다.

## 2. 두 경로의 분업

같은 예약이라도 경로에 따라 채워지는 칸이 다르다. 이 표가 백필(`fillContacts`)이 존재하는 이유다.

| 필드 | 파트너 API | Gmail 메일 |
|---|---|---|
| `booking_no` | `d.id` | 본문 링크에서 정규식 추출 |
| `name` | `user_info.name` (취소건은 `윤**`로 마스킹) | 본문 `예약자명` (취소 메일도 실명) |
| `phone` · `email` | 있음 (취소건은 없음) | **없음** — 메일에 아예 실려오지 않는다 |
| `purpose` | `d.purpose` | **없음** |
| `guests` | `d.member_count` | 본문 `예약인원`에서 숫자만 |
| `option_text` | `d.options[].name` 조인 | 본문 `예약옵션` |
| `request` | `d.note` | 본문 `요청사항` |
| `amount` · `payment` | `d.paid_price` · `payment.pay_method`\|`pg_code` | 본문 `결제금액`·`결제수단` |
| `memo` | `space.space_name` | 본문 `예약공간` |
| `applied` | `d.created_at` (실제 신청 시각) | **메일 도착일** — 근사값이다 |

> 2026-08-03 원문 확인: 스클 "예약 완료" 메일에 오는 필드는 예약공간·예약내용·예약인원·예약자명·
> 결제수단·결제금액뿐이고, 전화번호·이메일 패턴은 원문에 0건이었다. **파서를 고쳐도 안 나온다.**

## 3. 데이터 구조(모델)

### 3-1. `reservations` 행 — 이 스펙이 쓰는 컬럼

타입은 `admin_add_reservation`의 인자 시그니처(`supabase/migrations/20260813111100_admin_rpc_recover.sql:35-55`)와
`admin.html`의 `mapRow`에서 복원했다.

```typescript
interface Reservation {
  id: string;                 // uuid. admin_set_cancelled·admin_delete_reservation의 p_id 타입
  source: string | null;      // text. 수집 경로 표기 — 두 스크립트 모두 '스클' 고정
  booking_no: string | null;  // text. 스클 예약번호(예: '10388381'). null = 수동 입력 예약
  applied: string | null;     // date. 신청일
  date: string;               // date. 이용 날짜 (YYYY-MM-DD)
  start_time: string;         // time. 입실 시각 (HH:MM:SS로 돌아온다 — 클라이언트가 5자로 자른다)
  end_time: string;           // time. 퇴실 시각. start_time 이하면 '익일 종료'로 해석된다
  guests: number | null;      // integer. 예약 인원
  purpose: string | null;     // text. 사용 목적 (API 경로에서만 채워진다)
  option_text: string | null; // text. 예약 옵션. RPC 인자명은 p_option 인데 컬럼명은 option_text 다
  request: string | null;     // text. 요청사항 (자유 입력)
  name: string;               // text. 예약자명. 두 경로 모두 없으면 등록하지 않는다
  phone: string | null;       // text. '010-4036-0713' 하이픈 표기 (DB 기존 표기에 맞춘다)
  email: string | null;       // text
  amount: number | null;      // integer. 결제 금액(원)
  payment: string | null;     // text. 결제수단
  memo: string | null;        // text. 예약공간 원문 — 별도 컬럼이 없어 여기에 그대로 넣는다
  cancelled: boolean;         // boolean not null default false. 취소는 삭제가 아니라 이 플래그다
}
```

### 3-2. 파트너 API 예약 상세 (수집 DTO, 쓰는 필드만)

```typescript
interface PartnerReservationDetail {
  id: number;                  // 예약번호. String(d.id) 로 booking_no 에 넣는다
  RSV_STAT_CD: ReservationStatus;
  created_at: string;          // 'YYYYMMDD' — toIsoDate 로 변환
  start_ymd: string;           // 'YYYYMMDD'
  start_hour: string | number;  // '16' → '16:00'
  end_hour: string | number;    // ⚠️ 포함(inclusive). '18' → 실제 종료는 19:00
  member_count?: number;
  purpose?: string;
  note?: string;               // 요청사항
  paid_price?: number | string;
  options?: Array<{ name?: string; title?: string }>;
  payment?: { pay_method?: string; pg_code?: string };
  space?: { space_name?: string };
  user_info?: { name?: string; phone?: string; email?: string };  // 목록에 없고 상세에만 있다
}

type ReservationStatus =
  | 'RSCMP'   // 예약확정
  | 'USEDC'   // 이용완료
  | 'RCCMP'   // 취소완료 — 이 상태면 이름이 마스킹되고 연락처·이메일이 없다
  | 'PAYCP'   // 결제완료
  | 'REFND';  // 환불
```

### 3-3. 취소 메일 파싱 결과

```typescript
interface ParsedCancellation {
  date: string;            // 'YYYY-MM-DD'
  start: string;           // 'HH:MM'
  end: string;             // 'HH:MM'
  name: string;            // 예약자명 — 후보가 여럿일 때 대상을 특정하는 유일한 단서
  reason: string | null;   // 취소사유
}
```

**취소 메일에는 예약번호가 없다.** 이 한 줄이 §7 취소 매칭 로직 전체의 원인이다.

### 3-4. 처리 기록 (`PROCESSED_MESSAGES` 스크립트 속성)

`{ [gmailMessageId: string]: number }` 형태의 JSON 하나. 값의 의미:

| 값 | 이름 | 의미 | 다음 실행에서 |
|---|---|---|---|
| `0` | `STATE_DONE` | 반영 완료 | 건드리지 않는다 |
| `-1` | `STATE_GIVEN_UP` | 3회 시도 소진, 사람이 봐야 한다 | 건드리지 않는다 (`reprocessMessages()`로만 되살린다) |
| `1` 이상 | (시도 횟수) | 지금까지 실패한 횟수 | 재시도한다 |

최근 300건(`MAX_ENTRIES`)만 남긴다 — 스크립트 속성 1개가 9KB 상한이고 엔트리 하나가 약 21바이트라
300건이면 6KB 안쪽이다. 넘치면 오래된 것부터 버린다. 버려진 메일이 아직 7일 창 안에 있으면 다시
처리되지만, **등록은 예약번호로 걸러지고 취소는 멱등이라 해롭지 않다.**

### 3-5. 시간 해석 규칙

| 규칙 | 내용 | 근거 |
|---|---|---|
| API `end_hour`는 포함값 | `start_hour:16, end_hour:18` → `p_start='16:00'`, `p_end='19:00'`. 반드시 `+1` | 2026-08-03 예약 9건 전수 대조. 단가 교차검증도 같은 결론(13-20 / 64,000원 = 8시간 × 8,000원) |
| `end_time <= start_time` = 익일 종료 | `22:00~02:00`·`18:00~00:00`을 정식 지원한다. 자동화·문자 스케줄이 같은 해석을 쓴다 | `automation/windows.ts`의 `endTime()`, `20260813113000_reservation_time_overnight.sql:41-45` |
| `end_hour = 23` | `p_end`가 `24:00`이 된다. PostgreSQL `time`은 이 값을 받지만 운영 시간상 발생한 적이 없다 | `automation/README.md` 제약 절 |

이 보정을 놓치면 **모든 예약이 1시간씩 짧게 들어간다.**

## 4. 데이터 저장 구조

```
public.reservations
  ← 예약 1건 = 1행. 두 수집 경로와 어드민이 같은 테이블에 쓴다
  reservations_booking_no_uidx  ← partial unique index (booking_no is not null)
```

### ⚠️ 이 테이블에는 `create table` 마이그레이션이 없다

`reservations`는 **마이그레이션 이전에 DB 편집기에서 직접 만들어져 라이브에만 정의가 있다.**
레포의 마이그레이션에는 이 테이블에 컬럼을 더하는 `alter table`과 이 테이블을 읽고 쓰는 함수만 있다.
같은 부류가 이미 사고를 냈다 — `admin_*` 함수 다섯 개(`admin_add_reservation` 포함)가 버전 관리 밖에서
옛 비밀번호를 본문에 평문으로 들고 있었고, 인가의 뿌리인 `admin_list_reservations`도 마찬가지로 라이브에만
정의가 있었다. 둘 다 2026-08-13에야 회수됐다(`20260813111100_admin_rpc_recover.sql` 머리말).

위 §3-1의 컬럼 목록은 그 회수 마이그레이션의 `insert into reservations(...)` 목록에서 복원한 것이다.
**DB 편집기에서 테이블·함수를 직접 만들지 않는다** — 그것이 이 상황을 만든 원인이다.

### 컬럼 소유권

| 묶음 | 컬럼 | 소유 |
|---|---|---|
| 식별·시간·손님·결제 | `id`·`source`·`booking_no`·`applied`·`date`·`start_time`·`end_time`·`guests`·`purpose`·`option_text`·`request`·`name`·`phone`·`email`·`amount`·`payment`·`memo` | **이 스펙**(라이브 생성, insert 목록에서 복원) |
| 취소 상태 | `cancelled` | **이 스펙** — `20260803000000_add_cancelled_status.sql` |
| 운영 체크 | `checkin_done`·`checkout_done`·`cleaning_done` | 어드민 UI. 라이브 정의만 있다(`20260813140000_cleaning_provenance.sql` 주석이 명시) |
| 기기 자동화 | `checkin_automation_at`·`checkout_automation_at` (timestamptz) | `spec_reservation_automation` — `20260807000000` |
| 안내 문자 | `sms_auto`·`deposit_required` (boolean not null default false) | `spec_guest_sms` — `20260808100000` |
| 청소 출처 | `cleaning_done_at`·`cleaning_done_source` (`'admin'`\|`'qr'`) | `spec_cleaning_sms` — `20260813140000` |

이 스펙의 두 스크립트는 **자기 묶음과 `cancelled`만 건드린다.** 나머지 컬럼은 읽지도 쓰지도 않는다 —
`admin_list_reservations`가 `setof reservations`라 행 전체가 실려 오지만 무시한다.

### 중복 방지 인덱스

```sql
create unique index if not exists reservations_booking_no_uidx
  on public.reservations (booking_no)
  where booking_no is not null;
```

`booking_no`가 없는 수동 입력(전화 예약 등)은 null이라 제약 대상에서 빠진다. **partial이라는 점이
Gmail 파서의 실패 처리를 결정한다** — 예약번호 추출에 실패했을 때 조용히 null로 넣으면 이 인덱스가
막지 못해 API 경로가 같은 예약을 둘째 행으로 또 등록한다. 그래서 §5-3처럼 에러로 승격한다.

## 5. 기술 구현 — 백업 경로 (Gmail → Supabase)

### 5-1. 파일 구조

```
spacecloud-gmail-sync.gs
  processSpaceCloudReservations()   ← 15분 트리거 진입점. 잠금 → 수집 → 건별 처리 → 라벨 → 기록 저장
  collectMessages()                 ← 대상 메시지를 시간 오름차순으로 모은다
  parseReservationEmail(message)    ← 예약 완료 메일 → admin_add_reservation 인자
  parseCancellationEmail(message)   ← 취소 완료 메일 → ParsedCancellation
  parsePeriod(content) / extractField(html, label)
  submitReservation() / cancelReservation()   ← RPC 호출 + 알림
  listReservations() / invalidateReservations()  ← 실행 1회짜리 목록 캐시
  loadStore() / saveStore()         ← PROCESSED_MESSAGES 읽기·쓰기(300건 프루닝)
  notifyMattermost() / buildReservationMessage() / buildCancellationMessage() / buildErrorMessage()
  dailyAudit() / checkFreshness() / auditReservations(days)   ← 감사
  reprocessMessages() / createTrigger()                       ← 운영 도구
```

### 5-2. 처리 단위는 스레드가 아니라 **메시지**다

스페이스클라우드는 모든 예약 메일의 제목이 같아서 Gmail이 한 스레드로 묶는다. 예전에는 스레드에
라벨을 붙이고 `-label:`로 걸렀는데, **라벨이 붙은 뒤 같은 스레드로 들어온 메일이 쿼리에서 통째로
사라져 예약이 조용히 누락됐다.** 2026-08-03 예약 스레드는 09:12~14:04 5건이 한 덩어리였고, 15분
트리거가 그걸 한 번에 담는 것은 불가능하다.

지금은 처리한 `messageId`를 스크립트 속성에 남겨 거른다. **라벨은 사람이 Gmail에서 훑어보기 위한
표시일 뿐 재처리 여부를 결정하지 않는다** — 라벨을 손으로 떼도 다시 처리되지 않고, 재처리는
`reprocessMessages()`로만 한다.

### 5-3. 한 번의 실행

```
processSpaceCloudReservations()
  1. LockService.tryLock(5000ms) 실패 → 즉시 종료 (수동 실행과 트리거가 겹치는 경우)
  2. 스크립트 속성 ADMIN_PASSWORD 없으면 throw
  3. collectMessages()
       GmailApp.search(GMAIL_QUERY, 0, 50)  ← 스레드 단위 검색
       스레드 안 메시지마다 발신자(office@spacecloud.kr)와 제목을 **다시 확인**
         (검색 결과 스레드에 무관한 메시지가 섞일 수 있다)
       도착 시각 오름차순 정렬
  4. 메시지마다:
       기록이 0(완료) 또는 -1(포기)이면 건너뛴다
       제목에 '취소 완료' 포함 → cancelReservation(parseCancellationEmail(...))
       아니면                    → submitReservation(parseReservationEmail(...))
       성공 → 기록 0, 스레드를 성공으로 표시
       실패 → 시도 횟수 +1
                < 3회: 기록에 횟수만 남기고 조용히 다음 실행(15분 뒤)에서 재시도
                = 3회: 기록 -1, 실행 계정 메일 + Mattermost로 1회 통보, 스레드를 실패로 표시
  5. 라벨 적용 — 이번 실행에서 건드린 스레드에만
       실패 있음 → spacecloud-error / 아니면 spacecloud-processed
  6. finally: 여기까지의 기록을 반드시 저장한다
       (도중에 무엇이 터지든 저장하지 않으면 다음 실행이 같은 걸 또 반영한다)
```

**정렬이 핵심이다.** 취소 메일이 그 예약의 등록 메일보다 먼저 처리되면 취소할 대상을 못 찾아
실패한다 — 2026-08-03 10:53 "취소 대상 예약을 찾지 못했습니다"가 그 사례다. 도착 순서대로 처리하면
예약이 항상 먼저 들어간다.

**재시도를 3회로 둔 이유**: 일시적인 RPC 오류는 대개 재시도에서 낫고, 진짜 문제만 45분 뒤 한 번
알림이 나간다. 15분마다 같은 실패를 알리면 알림 자체가 무시된다.

### 5-4. 메일 파싱

| 항목 | 방법 |
|---|---|
| 검색 쿼리 | `from:office@spacecloud.kr subject:("예약 완료" OR "취소 완료") newer_than:7d` |
| 필드 추출 | `<td>레이블</td><td>값</td>` 쌍을 잡는 정규식(`extractField`) → 태그 제거 · `&nbsp;` 치환 · trim |
| 기간 | `예약내용` 값에서 `YYYY/MM/DD H시 - H시` 정규식 → `date`·`start`·`end`(각 `HH:00`) |
| 예약번호 | 본문에서 `reservation%2F(\d+)` 또는 `reservation/(\d+)` |
| 신청일(`applied`) | 메일 도착 시각을 Asia/Seoul `yyyy-MM-dd`로 |
| 인원 | `예약인원` 값의 첫 숫자 |
| 금액 | `결제금액` 값에서 숫자만 남긴 뒤 Number |

**예약자명과 예약번호는 실패하면 에러다.** 둘 다 없으면 조용히 넘어가지 않고 재시도·포기 경로를
탄다. 예약번호를 null로 넣으면 partial unique 인덱스가 못 막아 중복 행이 생기기 때문이다(§4).

### 5-5. 등록 (`submitReservation`)

```
예약번호가 이미 목록에 있으면 → 아무것도 하지 않고 종료 (중복 등록 방지)
admin_add_reservation 호출
목록 캐시 무효화   ← 안 버리면 방금 넣은 예약을 뒤이은 취소 처리가 못 찾는다
Mattermost '새 예약' 알림
```

목록 캐시는 **한 실행 안에서만 산다**(Apps Script는 실행마다 전역을 초기화한다). 메시지 단위로
처리하면서 매 건 목록을 다시 받으면 RPC 호출이 메시지 수만큼 늘어난다.

## 6. 기술 구현 — 주 경로 (파트너 API → Supabase)

### 6-1. 파일 구조

```
spacecloud-api-sync.js  (전역 `scSync` 하나만 노출)
  readToken()      ← localStorage 토큰 읽기 + JWT exp 검사
  ensureSession()  ← 만료 시 네이버 OAuth 버튼을 눌러 재로그인 유도
  fetchAll()       ← 목록 전 페이지 + 건별 상세
  toPayload(d, password)  ← API 상세 → admin_add_reservation 인자 (end_hour + 1 보정)
  run(password, {dryRun}) ← 수집 → 대조 → 등록·취소 반영
  fillContacts(password, {dryRun})  ← 빈 연락처·이메일만 백필
  hyphenPhone(p)   ← '01040360713' → '010-4036-0713'
  rpc(name, payload)
```

### 6-2. 실행

```js
await scSync.run('<어드민 비밀번호>', { dryRun: true })  // 미리보기, DB 변경 없음
await scSync.run('<어드민 비밀번호>')                    // 신규 등록 + 취소 반영
await scSync.fillContacts('<어드민 비밀번호>')           // 빈 연락처·이메일만 백필
await scSync.fetchAll()                                  // 수집만 (비밀번호 불필요)
```

크롬에서 `https://partner.spacecloud.kr/reservation`(로그인 상태)을 열고 콘솔에 파일 전체를
붙여넣은 뒤 위를 실행한다. 비밀번호는 **콘솔 인자로만** 다룬다 — 코드에 박지 않는다.

### 6-3. `run()`의 대조 규칙

```
details = fetchAll()                                   // 스클 쪽 전량
existing = rpc('admin_list_reservations', {password})  // DB 쪽 전량
byBookingNo = existing 중 booking_no 있는 것만 색인

예약마다:
  DB에 없음 + 예약자명 없음        → skipped('예약자명 없음')
  DB에 없음 + 취소 상태(RCCMP)     → admin_add_reservation 후 즉시 admin_set_cancelled
                                      → maskedAdds 로 따로 보고(이름이 마스킹된 채 들어간다)
  DB에 없음                        → admin_add_reservation → added
  DB에 있음 + 스클은 취소 + DB는 활성 → admin_set_cancelled → cancelled
  그 외                            → skipped('이미 반영됨')
```

취소건도 **일단 등록한다** — 이용 이력이 비면 안 되기 때문이다. 마스킹된 이름으로 들어가므로
실명이 필요하면 Gmail 취소 메일을 보고 어드민에서 보완한다.

### 6-4. 연락처 백필 (`fillContacts`)

Gmail 경로로 들어온 예약은 연락처·이메일이 비어 있다. 이걸 사후에 메우는 전용 경로다.

- `admin_fill_contact` RPC는 `coalesce(nullif(기존, ''), nullif(새 값, ''))`로 **빈 칸만 채운다.**
  이미 값이 있으면 그대로 둔다 — 수동으로 고친 값이 API 값에 밀리면 안 되고, 그래서 몇 번을 돌려도
  결과가 같다.
- 취소건(`RCCMP`)은 API가 연락처를 주지 않아 자동으로 건너뛴다. **확정 시점에 미리 수집해두지
  않으면 그 손님 연락처는 영구히 못 가져온다.**
- DB에 없는 예약번호를 만나면 RPC가 예외를 던지고, 스크립트는 그 건만 `skipped`에 담고 계속 진행한다.

2026-08-03 최초 백필: 연락처 3건 반영, 자동화 도입 전 예약 2건 신규 등록. `10388712`는 취소건이라
API가 연락처를 주지 않았지만 같은 예약자의 확정 건으로 동일인이 확인돼 **사람이 수동으로 채웠다** —
자동 백필로는 절대 안 채워지는 값이다.

### 6-5. 인증 — 24시간마다 사람이 필요하다

| 항목 | 실측 결과 (2026-08-03 / 2026-08-04) |
|---|---|
| 토큰 위치 | `localStorage["spacecloud__userInfo"].accessToken` |
| 헤더 | `Authorization: Bearer <token>` |
| 수명 | **정확히 24시간** (JWT 클레임은 `partner_id`·`exp` 뿐) |
| 리프레시 토큰 | **없음** |
| 인증 쿠키 | **없음** (쿠키는 전부 GA·채널톡·Datadog) |
| `/partner/users/get_token` 자체 갱신 | **불가** (401 `Missing token` — 소셜 콜백 전용) |
| 네이버 OAuth 무인 통과 | **불가** — 네이버 세션이 없으면 `nid.naver.com/nidlogin.login`에서 멈춘다 |

`readToken()`은 로그아웃 시 앱이 `localStorage`에 `{}`를 써놓는 것까지 방어한다 — `accessToken`이
undefined인 채 `.split`을 부르면 TypeError로 터져 `ensureSession()`의 안내에 닿지 못한다.

**결론: 무인화가 안 된다. 토큰 갱신만 사람이 하는 반자동이 상한이다.**
`contact-backfill/`(`session.js`·`spike-token.js`)은 이 결론을 만든 검증 도구이고 자동화 본체가
아니다. 열린 질문은 "네이버 '로그인 상태 유지'를 켜면 세션이 며칠 버티는가"이며, 답이 나오기 전에
무인 경로를 짜는 것은 두 번째 추측이다.

## 7. 취소 반영

### 7-1. 취소는 삭제가 아니다

`admin_set_cancelled(p_password, p_id, p_value)`가 `cancelled` 플래그만 바꾼다. 행은 남는다 —
어드민 날짜 목록에 '취소됨' 배지로 보이고, 캘린더 칩에서만 빠진다. 행을 지우면 이용 이력과
문자·자동화 기록이 함께 사라진다.

### 7-2. Gmail 취소 매칭 결정 트리

취소 메일에는 예약번호가 없다(§3-3). 그래서 (날짜 + 시작 + 종료)로 후보를 찾고 **예약자명으로
특정한다.** 후보를 찾을 때 `cancelled`를 먼저 걸러내지 않는 것이 중요하다 — 걸러내면 "이미 취소된
예약"과 "존재하지 않는 예약"이 구분되지 않는다.

```
candidates = 같은 (date, start, end) 인 모든 행 (취소 여부 무관)
active     = candidates 중 !cancelled

candidates 가 비었나?
  예 → 에러 (실패 통보 + Mattermost, 3회 재시도 후 포기)
      예: 자동화 도입 전에 만들어진 예약

취소 메일에 이름이 있나?
  예 → (1) 같은 이름의 **취소된** 후보가 있나?
         예 → 이 취소는 이미 반영됨 → 활성 행을 건드리지 않고 종료
              단, 같은 이름의 **활성 행까지** 있으면 Mattermost로 사람을 부른다 (아래)
       (2) 같은 이름의 활성 후보를 고른다
       (3) 못 골랐는데 취소된 후보가 있으면 → 재처리로 보고 종료

match 가 없으면 active[0]   ← 단일 공간이라 한 슬롯의 활성 예약은 최대 1건이므로 모호하지 않다
active 도 비었으면 → 이미 취소됨(재처리) → RPC·알림 없이 조용히 종료

admin_set_cancelled(match.id, true) → 목록 캐시 무효화 → Mattermost '예약 취소' 알림
```

**(1)에서 사람을 부르는 이유.** 같은 이름의 취소 행과 활성 행이 함께 있으면 해석이 둘로 갈린다:
이미 반영된 취소의 재처리이거나, 같은 사람이 재예약한 뒤 그걸 다시 취소한 것이거나. 예약번호가
없어 코드로는 못 가른다. 안전한 쪽(안 건드림)을 택하되 **조용히 넘어가지는 않는다** — 후자였다면
취소된 줄 아는 손님의 예약이 살아 있고, 그 시각에 냉난방·조명이 그대로 돈다. 사람이 어드민에서
1분이면 확인할 수 있어 알리는 비용이 놓치는 비용보다 싸다.

**알려진 한계**: 같은 사람이 취소 → 재예약 → 다시 취소하면 두 번째 취소가 (1)에 걸려 자동 반영되지
않는다. 재처리와 구분할 수 없어서다. **놓친 취소(안전)가 무고한 취소(위험)보다 낫다**는 선택이고,
일 1회 감사와 수동 대조로 보완한다.

### 7-3. API 경로의 취소는 다르다

API에는 예약번호와 상태 코드가 있으므로 이름 대조가 필요 없다. `RSV_STAT_CD === 'RCCMP'`이고 DB가
활성이면 바로 취소 처리한다. **같은 취소를 두 경로가 서로 다른 근거로 판정한다** — 예약번호(강함)와
이름+시간(약함)이고, 강한 쪽이 주 경로다.

## 8. 감사 · 건강 점검

건별 실패는 재시도·포기가 알리지만, **"메일이 아예 안 온다"는 그 자체로 아무 알림이 없다.**
2026-08-09 자동화가 3일 침묵한 실측이 이 감사를 만든 계기다.

| 함수 | 언제 | 무엇을 |
|---|---|---|
| `dailyAudit()` | 매일 09시 트리거 | ① 신선도 ② 대조. 신선도를 **먼저·독립적으로** 돌린다 — 대조는 비밀번호·RPC에 의존해 실패할 수 있고 그게 신선도 알림을 삼키면 안 된다 |
| `checkFreshness()` | `dailyAudit` 안에서 | 매칭 메일의 최신 도착 시각이 `STALE_DAYS`(3일)를 넘으면 Mattermost 경보. 마지막 경보 시각을 `LAST_HEALTH_ALERT_AT`에 남겨 3일에 한 번만 알린다 |
| `auditReservations(days)` | `dailyAudit` 안에서 · 수동 | **진단 전용, 아무것도 바꾸지 않는다.** 메일과 DB를 대조해 누락·미반영·파싱 실패를 모은다. 인자를 비우면 30일. 불일치가 있으면 상위 10건을 Mattermost로 |
| `reprocessMessages()` | 수동 | 처리 기록을 비워 7일 창 안의 메일을 재처리시킨다. 포기한 건을 원인 해결 후 되살릴 때 |
| `createTrigger()` | 설치 시 1회 | 두 트리거를 설치한다. 같은 핸들러의 기존 트리거를 지우고 다시 만들어 **중복 설치되지 않는다** |

`STALE_DAYS`가 3인 이유: 실측(3일 침묵)이 기준이고, `LOOKBACK`(7일) 이하여야 쿼리 창 안에서 실제로
측정된다 — 더 크게 잡으면 메일이 창 밖으로 밀려 신선도를 못 잰다.

## 9. API / RPC

### 9-1. 이 스펙이 호출하는 Supabase RPC

| RPC | 호출자 | 인자 | 하는 일 |
|---|---|---|---|
| `admin_list_reservations` | 양쪽 | `p_password` | `setof reservations` 전량. **아홉 개의 `admin_*` 함수가 이 함수로 비밀번호를 검증한다**(`perform` 관용구) — 인가의 뿌리다. 정렬을 걸지 않고 취소건도 그대로 내린다(정렬·필터는 클라이언트가 한다) |
| `admin_add_reservation` | 양쪽 | `p_password`·`p_source`·`p_booking_no`·`p_applied`·`p_date`·`p_start`·`p_end`·`p_guests`·`p_purpose`·`p_option`·`p_request`·`p_name`·`p_phone`·`p_email`·`p_amount`·`p_payment`·`p_memo` | 행 1건 insert 후 그 행을 반환 |
| `admin_set_cancelled` | 양쪽 | `p_password`·`p_id`·`p_value` | `cancelled` 플래그만 갱신 |
| `admin_fill_contact` | API 경로 | `p_password`·`p_booking_no`·`p_phone`·`p_email` | 빈 연락처·이메일만 채운다. 없는 예약번호면 예외 |

네 함수 모두 `security definer` + `search_path = public`이고, 비밀번호 검증은 `admin_check`로 모인다
(`admin_fill_contact`는 `admin_list_reservations`를 경유해 같은 뿌리에 닿는다). 호출은 PostgREST
`POST /rest/v1/rpc/<name>` + anon key 헤더다.

> 2026-08-13 이전에는 `admin_add_reservation`·`admin_set_cancelled`가 본문에 비밀번호 리터럴을 직접
> 들고 있었고 일부는 버전 관리 밖에 있었다. 지금은 전부 `admin_check` 위임이다. 상세는 `spec_admin_auth`.

### 9-2. 스페이스클라우드 파트너 API

베이스: `https://api.spacecloud.kr` · 헤더 `Authorization: Bearer <token>`

| 용도 | 엔드포인트 | 이 스펙에서 |
|---|---|---|
| 예약 목록(페이지네이션) | `GET /partner/reservations?page=N` | 사용 — `res.page.pages`까지 순회하며 id만 모은다 |
| 예약 상세 | `GET /partner/reservations/:id` | 사용 — **연락처·이메일·인원·요청사항은 목록에 없고 상세에만 있다** |
| 예약 승인 / 취소 | `POST .../approve`, `.../cancel` | 사용하지 않음(단방향 수집) |
| 변경요청 승인 / 거절 | `.../reservation_change_requests/:changeId/{approve,reject}` | 사용하지 않음 |
| 공간·상품·가격 | `/partner/spaces/*`, `/partner/products/*` | 사용하지 않음 |
| 문의·리뷰 답글 | `/partner/questions/*`, `/partner/reviews/:id/comments` | 사용하지 않음 |
| 운영 리포트 | `/partner/operation_reports` | 사용하지 않음 |

### 9-3. Gmail

| 항목 | 값 |
|---|---|
| 발신자 | `office@spacecloud.kr` |
| 쿼리 | `from:<발신자> subject:("예약 완료" OR "취소 완료") newer_than:7d` |
| 검색 상한 | 스레드 50개(처리 루프·신선도) / 100개(감사) |
| 라벨 | `spacecloud-processed` · `spacecloud-error` (사람이 보는 표시 전용) |

## 10. 알림 (Mattermost)

`e-alert-typelounge` 채널로 보낸다. 발송 경로는 인커밍 웹훅이고 URL은 스크립트 속성으로만 주입한다.
공개 주소(`https://mm.nmwc.ai.kr/hooks/...`)여야 한다 — Apps Script는 구글 서버에서 실행되므로
`localhost`에 도달할 수 없다.

| 알림 | 언제 | 내용 |
|---|---|---|
| **새 예약** | `admin_add_reservation` 성공 후 | 예약자(인원)·일시·결제·옵션·요청·예약번호 표 + 어드민 링크 |
| **예약 취소** | `admin_set_cancelled` 성공 후 | 예약자·일시·사유·예약번호 |
| **예약 자동등록 실패** | 3회 소진 시 1회 | 메일 제목·날짜·오류 + `reprocessMessages()` 안내 |
| **취소 판별 불가** | §7-2 (1)의 모호한 경우 | 날짜·시간·이름 + "재예약을 다시 취소한 것이라면 어드민에서 직접 취소해 주세요" |
| **신선도 경보** | 3일 이상 매칭 메일 0건 | 확인할 것(쿼리·트리거 상태·실행 기록) |
| **감사 불일치** | `dailyAudit` 대조에서 불일치 발견 | 상위 10건 + 초과 건수 |

설계 규칙 셋:

1. **알림은 RPC가 성공한 뒤에만 보낸다.** 중복으로 등록을 건너뛴 경우엔 알리지 않는다.
2. **알림 실패는 예약 처리에 영향을 주지 않는다.** `notifyMattermost`는 모든 예외를 삼키고 로그만
   남긴다. 그러지 않으면 Mattermost가 잠시 죽었을 때 정상 등록된 예약까지 실패로 기록돼 재시도
   대상이 된다.
3. **자유 입력을 무해화한다.** 요청사항에 `|`나 개행이 들어와도 마크다운 표가 깨지지 않게 이스케이프한다.

알림 지연은 최대 15분(트리거 주기)이다.

## 11. 의존성 / 관련 스펙

| 스펙 | 관계 |
|---|---|
| `spec_admin_auth` | 네 RPC의 비밀번호 검증(`admin_check`)이 거기 정의돼 있다. 비밀번호를 회전하면 Apps Script 스크립트 속성 `ADMIN_PASSWORD`도 같이 바꿔야 백업 경로가 멈추지 않는다 |
| `spec_guest_sms` | 이 스펙이 만든 행을 읽어 안내 문자를 보낸다. 연락처가 비어 있으면 첫 통이 못 나가므로 §6-4 백필이 문자의 선행 조건이다 |
| `spec_reservation_automation` | 이 스펙이 만든 행의 `date`·`start_time`·`end_time`으로 입실 준비·퇴실 종료를 돈다. **`end_hour + 1` 보정을 놓치면 기기가 1시간 일찍 꺼진다** |
| `spec_cleaning_sms` | `reservations`를 틱마다 스냅샷 비교해 변경을 감지한다 — 이 스펙이 어느 경로로 쓰든 한 테이블로 모이는 것이 그 감지 방식의 전제다 |
| `spec_space_control` | 손님 제어 페이지의 시간창 판정이 이 행의 `cancelled`와 시각을 본다 |

어드민 화면(캘린더·수동 추가·삭제·시간 수정 모달)은 별도 스펙이지만 **같은 네 RPC를 공유한다.**
시간 수정(`admin_set_time`)은 `end_time <= start_time`을 익일 종료로 허용하므로, 이 스펙이 쓰는
시간 해석(§3-5)과 같은 규칙을 따른다.

## 파일(페이지) 구성

| 파일 | 경로 | 설명 |
| --- | --- | --- |
| `spacecloud-api-sync.js` | `06-applications/automation/` | 주 경로. 파트너 API 수집 → 등록·취소 반영·연락처 백필. 브라우저 콘솔용 ES5 단일 파일 |
| `spacecloud-gmail-sync.gs` | `06-applications/automation/` | 백업 경로. 알림 메일 파싱 → 등록·취소 반영, 15분 무인 실행 + 일 1회 감사 |
| `README.md` | `06-applications/automation/` | 두 경로의 설치·운영 절차, 실측 근거, 막혔을 때 표 |
| `README.md` · `session.js` · `spike-token.js` · `package.json` | `06-applications/automation/contact-backfill/` | 백필 무인화 가능성 검증 도구. **자동화 본체가 아니다** |
| `20260803000000_add_cancelled_status.sql` | `supabase/migrations/` | `cancelled` 컬럼 + `admin_set_cancelled` |
| `20260803010000_unique_booking_no.sql` | `supabase/migrations/` | `booking_no` partial unique 인덱스 |
| `20260803020000_admin_fill_contact.sql` | `supabase/migrations/` | `admin_fill_contact` — 빈 칸만 채우는 백필 RPC |
| `20260813111000_admin_use_secret.sql` | `supabase/migrations/` | `admin_set_cancelled`·`admin_list_reservations`를 `admin_check` 위임으로 전환 |
| `20260813111100_admin_rpc_recover.sql` | `supabase/migrations/` | 라이브에만 있던 `admin_add_reservation` 외 4개를 레포로 회수. **`reservations` 컬럼 목록의 복원 근거** |
| `admin.html` | `06-applications/` | 같은 RPC를 쓰는 어드민 화면(별도 스펙). `mapRow`가 컬럼명 대조의 근거 |

## 12. 확인이 필요한 항목

| 항목 | 왜 확인이 안 되나 |
|---|---|
| [확인 필요: `reservations.id`의 기본값 생성 방식(`gen_random_uuid()` 등)] | `create table` 정의가 라이브에만 있어 레포에서 알 수 없다 |
| [확인 필요: `cancelled`·`sms_auto`·`deposit_required` 외 컬럼의 not null·기본값 제약] | 같은 이유. RPC 시그니처는 인자 타입만 알려준다 |
| [확인 필요: Gmail 경로가 자정 종료를 원문에서 어떻게 표기하는지] | `parsePeriod`가 `\d{1,2}시`만 받아 `24시`인지 `0시`인지 원문 없이는 판정 불가 |
| [확인 필요: `applied`의 경로별 의미 차이가 의도인지] | API는 실제 신청 시각(`created_at`), Gmail은 메일 도착일이다. 근거 문서에 이 차이에 대한 판단이 없다 |

## 13. 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-14 | 최초 작성 — 이미 라이브인 구현을 역기획으로 정리 |
