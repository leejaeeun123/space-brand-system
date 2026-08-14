# spec_guest_sms

> 예약한 손님에게 나가는 안내 문자 5종(청소 보증금·예약 확정·입실·퇴실 15분 전·퇴실)을 예약 흐름에 맞춰 자동으로 보내고, 나간 것과 못 나간 것을 전부 장부에 남기는 스펙. 운영자는 어드민 예약 카드의 문자 박스에서 켜고 끄고, 문구를 확인하고, 손으로 보낸 것도 표시한다.

## 1. 개요

타입라운지는 상주 인력이 없다. 지금까지 입실·퇴실 안내는 어드민이 문구를 복사해 손으로 보냈고, 사람이 보내는 한 '늦게 갔다'와 '아예 안 갔다'를 아무도 모른다. 이 스펙은 그 두 가지를 시스템이 알게 만든다.

핵심 동작 셋:

1. **예약마다 옵트인.** `reservations.sms_auto`가 켜진 예약만 자동 발송 대상이다. 기본값은 `false` — 기본을 `true`로 두면 이미 등록된 과거·미래 예약 전부에 문자가 나간다.
2. **두 입구, 한 경로.** 어드민 클릭도 pg_cron 자동 스윕도 같은 `dispatch()`를 지난다. 나누면 '어드민으로는 되는데 자동으로는 안 나가는' 차이가 조용히 생기고, 그 차이는 손님이 문자를 못 받은 뒤에야 발견된다.
3. **선점이 중복을 막는다.** 발송 **전에** `reservation_sms`에 `sending` 행을 먼저 넣고, 부분 유니크 인덱스가 겹친 호출 중 하나만 통과시킨다. '보내기 전에 이미 보냈나 확인'하는 방식은 두 호출이 나란히 통과한다 — `automate` action은 anon key로 누구나 부를 수 있어 틱이 겹칠 수 있다.

문자는 전부 90바이트를 넘어 **LMS**로 나간다(2026-08-14 기준 45원/건, 예약 1건당 최대 225원). 유료라는 사실이 실패 처리 설계를 지배한다 — 결과가 불분명하면 **다시 보내지 않는 쪽**을 고른다.

**범위 밖:** 청소 담당자에게 나가는 문자는 `spec_cleaning_sms`, 공간 지원 신청·페이백 결과 문자는 `spec_support_apply`가 다룬다. 같은 SOLAPI 클라이언트를 쓰지 않는 별도 계통이다.

## 2. 기술 스택

프로젝트 공통(Supabase Edge Functions · Deno · PostgreSQL · 정적 HTML 어드민)에 더해 이 스펙 고유:

- **SOLAPI** 문자 발송 REST API (`https://api.solapi.com`, `POST /messages/v4/send-many/detail`). SDK를 쓰지 않는다 — 인증이 HMAC-SHA256인데 서명 입력이 `date + salt`뿐이라(URL도 본문도 안 들어간다) Web Crypto(`crypto.subtle`)만으로 충분하다.
- **pg_cron + pg_net** — 1분마다 Edge Function `control`의 `automate` action을 찌른다. 스케줄러는 anon key만 있으면 되고 어드민 비밀번호를 심을 필요가 없다.
- **@supabase/supabase-js v2** (`jsr:@supabase/supabase-js@2`) — Edge Function 안에서 service_role로 장부를 읽고 쓴다.
- **Mattermost incoming webhook** — 발송 결과 알림 한 건 한 줄.

## 3. 실행 환경

| 층 | 환경 |
| --- | --- |
| 발송 로직 | Supabase Edge Functions (Deno), 함수명 `control`. 런타임 TZ는 **UTC** — KST 계산은 `automation/windows.ts`의 `targetTime`·`endTime`을 반드시 경유한다 |
| 스케줄 | Supabase PostgreSQL의 pg_cron, 1분 주기 |
| 장부 | Supabase PostgreSQL, 테이블 `public.reservation_sms` (RLS 켜짐, 정책 0개) |
| 어드민 화면 | 정적 `admin.html`, Vercel 배포. 브라우저(모바일·데스크톱) |
| 벤더 | SOLAPI 선불 잔액. 발신번호는 사전등록제(「전기통신사업법」 §84-2)라 등록된 번호만 쓸 수 있다 |

## 4. 접근 제어

문자 action 4종은 **전부 admin 전용**이다. `auth.ts`의 `GUEST_ACTIONS`(`list`·`command`·`automate`)에 아무것도 넣지 않아, 손님 요청은 핸들러에 닿기 전 라우팅 단계에서 403으로 잘린다.

**미리보기(`sms_preview`)까지 막는 것이 의도한 설계다.** 문구에 예약 일시가 들어가고, 그것이 곧 '언제 이 공간이 비는가'라는 정보이기 때문이다.

장부 테이블은 RLS가 켜져 있고 정책이 하나도 없다 — anon·authenticated는 전부 막히고, `SECURITY DEFINER` RPC와 Edge Function의 service_role만 닿는다. 손님 페이지가 같은 anon key를 쓰기 때문에 이 구조가 필요하다.

RPC(`admin_set_phone`·`admin_set_deposit`·`admin_list_sms`)는 비밀번호 검증을 전부 `admin_list_reservations`에 위임한다. 평문 비밀번호를 SQL에 또 박으면 같은 비밀이 레포와 DB 안에서 늘어나기만 한다.

## 5. 문자 5종과 발송 시점

### 5-1. 종류

`SmsKind`의 배열 순서가 곧 손님이 받는 순서다.

| kind | 어드민 표시 이름 | 조건 | 문구 요지 |
| --- | --- | --- | --- |
| `deposit` | 청소 보증금 안내 | `deposit_required = true`인 예약만 | 보증금 5만원 입금 요청 + 계좌 + "정상 퇴실 확인 후 24시간 내 반환" |
| `confirm` | 예약 확정 안내 | 항상 | 확정 통보 + 예약 일시 + 주소. 보증금 예약이면 첫 줄이 "보증금 입금 확인되어 예약 확정되었습니다!", 아니면 "예약 확정되었습니다!" |
| `checkin` | 입실 안내 | 항상 | "10분 후 입실 가능" + 주소 + 가이드 페이지 + 연락처 |
| `checkout_soon` | 퇴실 15분 전 안내 | 항상 | "퇴실 시간이 15분 남았어요" + 정리 체크리스트 5항목 + 퇴실 시각 준수 요청 |
| `checkout` | 퇴실 시간 안내 | 항상 | "이용 시간이 종료되었어요". 보증금 예약이면 환불 안내 한 문단이 붙는다 |

문구의 정본은 `sms/templates.ts` **하나뿐이다.** 어드민에도 같은 문구를 두지 않는다 — 사람이 눌러 보내는 문자와 cron이 자동으로 보내는 문자가 갈라지면 손님에게 한 약속이 두 개가 된다. 어드민은 복사할 문구조차 `sms_preview`로 서버에서 받아 쓴다.

문구에 박혀 있는 공간 사실은 한 곳에서만 적는다: 주소(서울 마포구 월드컵로3길 31-32, 3층), 연락처(010-4810-9142), 가이드 URL(`https://typelounge.vercel.app`), 보증금 계좌·금액. **보증금 계좌는 시크릿이 아니다** — 손님 전원에게 보내는 값이라 숨길 대상이 아니고, 숨기면 오히려 문구가 두 곳으로 갈라진다.

### 5-2. 발송 시점

| kind | 언제 | 누가 | 유예 |
| --- | --- | --- | --- |
| `deposit` 또는 `confirm` | 자동발송 토글을 **켜는 그 클릭 안에서** 첫 통. `deposit_required`가 true면 `deposit`, 아니면 `confirm` | 어드민 클릭 (`sms_auto` action) | 없음 — 입실 시각이 이미 지났으면 안 보내고 `expired` |
| `confirm` (보증금 예약) | 보증금 입금을 확인한 뒤 | 어드민이 그 줄의 `보내기` | 없음 (수동) |
| `checkin` | 입실 **10분 전** | pg_cron 1분 틱 | **30분** |
| `checkout_soon` | 퇴실 **15분 전** | pg_cron 1분 틱 | **15분** |
| `checkout` | 퇴실 시각 **정각** | pg_cron 1분 틱 | **60분** |

**첫 두 통이 cron이 아닌 이유:** 자동 스윕은 예약 전후 1일치만 훑는다(`automation/store.ts`의 `fetchRecent`). 다음 주 예약에 오늘 자동발송을 켜면 그 문자가 예약 당일에야 나간다. 그래서 플래그 변경과 발송이 같은 클릭 안에서 끝난다. 같은 이유로 자동발송을 켜는 SQL RPC를 만들지 않는다 — SQL 함수는 문자를 못 보내므로, 만들면 플래그만 켜지고 문자는 안 나가는 경로가 하나 더 생긴다.

**유예가 종류마다 다른 것이 핵심이다.** 입실 안내는 20분 늦어도 쓸모가 있지만, "퇴실 15분 남았어요"가 퇴실 시각 뒤에 도착하면 손님을 혼란스럽게 할 뿐이다.

**문구가 약속하는 시각과 `TIMINGS`의 숫자는 같아야 한다.** `checkin` 문구는 "10분 후 입실 가능하십니다", `checkout_soon`은 "15분 남았어요"라고 적혀 있다. 한쪽만 고치면 손님이 받는 문자와 실제가 어긋난다.

### 5-3. 시각 판정

```typescript
type Anchor = "start" | "end";

interface Timing {
  kind: SmsKind;
  anchor: Anchor;           // 입실 기준인가 퇴실 기준인가
  offsetMinutes: number;    // 기준 시각으로부터 몇 분(음수 = 전)
  graceMinutes: number;     // 이 시간까지는 늦게라도 보낸다. 넘기면 안 보낸다
}

const TIMINGS: readonly Timing[] = [
  { kind: "checkin",       anchor: "start", offsetMinutes: -10, graceMinutes: 30 },
  { kind: "checkout_soon", anchor: "end",   offsetMinutes: -15, graceMinutes: 15 },
  { kind: "checkout",      anchor: "end",   offsetMinutes:   0, graceMinutes: 60 },
];

type SmsDueState = "wait" | "fire" | "expired";

interface SchedulePlan {
  fire: SmsKind[];      // 지금 보낼 것
  expired: SmsKind[];   // 창을 놓친 것. 조용히 버리지 않고 장부와 채널에 남긴다
}
```

판정: `elapsed = now - dueAt`. `elapsed < 0`이면 `wait`, `elapsed <= graceMinutes`면 `fire`, 넘으면 `expired`.

**퇴실 기준 시각은 반드시 `windows.endTime()`을 통한다.** 직접 `targetTime(date, end_time)`을 쓰면 자정을 넘기는 예약(18:00~00:00)에서 종료가 시작보다 이르게 나와 퇴실 안내가 **하루 전날** 나간다. 이 공간은 자정 넘김 예약을 정식으로 받는다.

`plan()`은 **이미 보냈는지 묻지 않는다** — 그건 장부의 유니크 인덱스가 원자적으로 판정한다. 여기서 미리 확인하면 겹친 두 호출이 나란히 통과해 같은 문자를 두 번 보낸다.

## 6. 발송 흐름

**순서가 곧 안전장치다: 선점 → 발송 → 기록 → 알림.**

```
dispatch(sb, reservation, kind, origin)
  │
  ├─ loadConfig() 없음 ─────────────────────→ not_configured (장부에 안 적는다)
  ├─ normalizePhone(phone) 없음 ────────────→ no_phone (장부에 안 적는다, 호출부가 판단)
  │
  ├─ render(kind, r) → body
  │
  ├─ INSERT reservation_sms (status='sending', to_phone, body)   ← 선점
  │    └─ 23505 unique_violation ───────────→ already (아무것도 하지 않았다)
  │    └─ 그 밖의 에러 ─────────────────────→ throw (장부를 못 쓰면 계속 보내면 안 된다)
  │
  ├─ send(cfg, phone, body)  → SOLAPI
  │
  ├─ ok            → UPDATE status='sent', sent_at, group_id → notifySent   → sent
  ├─ unknown       → UPDATE status='unknown', error          → notifyUnknown → unknown
  └─ rejected      → UPDATE status='failed',  error          → notifyFailed  → failed
```

- **선점을 발송 뒤로 옮기면 안 된다.** `automate`는 anon key로 누구나 부를 수 있어 겹친 두 호출이 같은 문자를 두 번 보낸다.
- **발송 성공 직후 UPDATE 전에 함수가 죽으면 행이 `sending`에 남아 다음 시도를 막는다 — 안전한 쪽으로 죽는 것이다.** 문자는 이미 나갔으므로 막히는 것이 두 번 가는 것보다 낫다. 어드민이 재발송으로 푼다.
- **`dispatch`는 발송 실패로 예외를 던지지 않는다.** 자동 스윕이 한 예약에서 넘어지면 그 뒤 예약이 통째로 안 나간다. 다만 **장부 기록 실패는 던진다** — 그건 '문자가 실패했다'가 아니라 '무엇이 나갔는지 더 이상 모른다'는 뜻이다.
- 알림(`notify.ts`)은 **어떤 예외도 밖으로 던지지 않는다.** 알림이 실패했다고 이미 나간 문자가 장부에 안 적히면 안 된다.

### 6-1. 자동 스윕 (pg_cron 1분 틱)

```
pg_cron (1분) → POST control { action: "automate" } → handlers/automation.ts
                                                         ├─ 기기 자동화
                                                         ├─ sweepSms(sb, reservations, now)   ← 이 스펙
                                                         └─ sweepCleaning(...)
```

`sweepSms`는 `handlers/automation.ts`가 이미 읽어 둔 같은 예약 배열을 받는다. 따로 조회하면 기기·손님문자·청소안내가 서로 다른 예약 목록을 보는 순간이 생긴다.

동작:

1. `sms_auto`가 켜진 예약만 남긴다. 0건이면 즉시 반환.
2. `loadConfig()`가 없으면 **아무것도 적지 않고** 콘솔에만 남기고 반환. 장부에 실패로 쌓으면 시크릿을 다시 넣었을 때 이미 자리가 막혀 있고, 재시도 가능한 상태로 적으면 매 틱 같은 실패가 쌓인다. 설정 누락은 예약의 문제가 아니라 서버의 문제다.
3. 예약마다 `plan(r, now)` → `fire`는 발송, `expired`는 `markExpired`.
4. `fire` 중 번호가 없으면 `markNoPhone`으로 갈라 보낸다.
5. **한 예약에서 예외가 나도 다음 예약으로 넘어간다.** 여기서 예외가 밖으로 나가면 그 뒤 예약의 문자가 통째로 안 나가고, 무인 운영에서 그 사실을 아무도 모른다.

문자 스윕은 기기 자동화와 **완전히 분리**돼 있다(`handlers/automation.ts`가 try/catch로 감싼다). 기기 자동화가 실패한 틱에도 문자는 나가야 한다 — 입실 준비가 실패했다고 손님에게 길 안내를 안 보낼 이유가 없다.

### 6-2. 자동발송 토글 (`sms_auto` action)

```
setAuto(reservation_id, value)
  ├─ value=true 인데 cancelled ────────────→ 400 "취소된 예약에는 자동발송을 켤 수 없습니다"
  ├─ UPDATE reservations SET sms_auto = value
  ├─ value=false ──────────────────────────→ { sms_auto: false, immediate: null }
  │
  ├─ kind = deposit_required ? "deposit" : "confirm"
  ├─ now >= 입실 시각 ──────────────────────→ markExpired → { sms_auto: true, immediate: { kind, status: "expired" | "already" } }
  └─ 그 외 ────────────────────────────────→ dispatch(admin) → { sms_auto: true, immediate: { kind, ...result } }
```

**이미 입실 시각이 지났으면 첫 통을 보내지 않는다.** 보증금 안내와 예약 확정 안내는 예약이 시작되기 **전에**만 의미가 있다 — 다섯 시간 전에 들어온 손님에게 "예약 확정되었습니다! 입실 10분 전에 이용 안내 문자 다시 보내드릴게요"가 가면 안 된다. 조용히 건너뛰지 않고 `expired`로 남긴다(창을 놓친 게 사실이다). 그래야 이후 퇴실 안내는 정상적으로 나가면서, 화면과 채널에는 이 한 통이 안 나갔다는 게 남는다.

이용 중인 예약에 뒤늦게 연락처를 넣고 자동발송을 켜는 것이 실제 사용 흐름이라, 이 분기는 예외 상황이 아니라 정상 경로다.

**첫 통이 실패해도 플래그는 켜진 채로 둔다** — 시각 기반 문자(입실·퇴실)는 계속 나가야 하고, 실패한 한 통은 어드민에서 다시 보내면 된다. 결과를 그대로 돌려주므로 화면이 조용하지 않다.

## 7. 실패 유형 분류

### 7-1. 벤더 응답 → 실패 갈래

```typescript
type SendFailure = "rejected" | "unknown";

type SendResult =
  | { ok: true; groupId: string | null }
  | { ok: false; failure: SendFailure; error: string };
```

| 벤더 반응 | 갈래 | 근거 |
| --- | --- | --- |
| HTTP 4xx | `rejected` | 확정 거절(미등록 발신번호·잔액 부족 등). 다시 보내도 같다 |
| HTTP 200 + `failedMessageList` 비어있지 않음 | `rejected` | 벤더가 받았지만 이 건을 확정 거절. HTTP 200만 보고 성공으로 적으면 장부에는 '보냄'인데 손님은 못 받은 상태가 된다 |
| HTTP 5xx | `unknown` | 벤더 서버 오류 — 요청을 **처리했는지 알 수 없다** |
| 타임아웃(15초)·네트워크 예외 | `unknown` | 벤더에 닿았는지, 닿았다면 처리됐는지 알 수 없다 |

실패 사유는 벤더 원문(`errorCode`/`errorMessage` 또는 `statusCode`/`statusMessage`)을 그대로 실어 나른다 — '잔액 부족'이나 '미등록 발신번호' 같은 진짜 원인이 거기에만 적혀 있다.

### 7-2. 장부에 적히는 실패 상태

| status | 유니크 인덱스 | 자동 재시도 | 왜 따로 있는가 |
| --- | --- | --- | --- |
| `failed` | **밖** (자리를 비운다) | **한다** — 다음 틱이 곧바로 다시 보낸다 | 확정 거절은 상황이 바뀌면(잔액 충전 등) 성공할 수 있다 |
| `unknown` | 안 (자리를 막는다) | 안 한다 | 벤더가 이미 처리했을 수 있어, 재시도하면 **유료 LMS가 손님에게 두 번 도달**한다. 사람이 SOLAPI 콘솔에서 확인 후 어드민 재발송으로 푼다 |
| `no_phone` | 안 (자리를 막는다) | 안 한다 | `failed`로 적으면 다음 틱이 곧바로 다시 시도하는데, 연락처가 없는 상태는 사람이 번호를 넣기 전까지 절대 안 풀린다 — 유예 창(입실 안내는 30분) 내내 **매 분 같은 실패를 쌓고 채널을 도배**한다. `no_phone`은 자리를 막아 한 번만 알린다 |
| `expired` | 안 (자리를 막는다) | 안 한다 | 놓친 문자를 매 틱 영원히 다시 시도하지 않기 위해서다. **의도한 동작이다** |
| `superseded` | **밖** (자리를 비운다) | 재발송 경로를 연다 | 재발송할 때 기존 행을 지우거나 `failed`로 고치지 않는다. 지우면 '무엇을 언제 보냈나'가 사라지고, `failed`로 고치면 실제로 나간 문자가 실패로 적힌 거짓말이 된다 |

장부에 **적히지 않는** 결과 둘:

- `not_configured` — SOLAPI 시크릿이 없다. 시도조차 못 한 것이라 '실패'와 다르다. 자동 경로는 콘솔에만 남기고, 어드민 요청은 503으로 즉시 알려준다.
- `already` — 이미 보냈거나 다른 호출이 보내는 중. 아무것도 하지 않았다.

### 7-3. 전화번호 정규화

```
/^(010\d{8}|01[16789]\d{7,8})$/
```

- 휴대폰(01x)만 받는다. 유선번호는 문자를 못 받고, 스페이스클라우드가 주는 **050 안심번호**도 마찬가지다.
- **010은 11자리로 못 박는다** — 01x를 한 덩어리로 묶어 10~11자리를 허용하면 한 자리 빠뜨린 010 번호가 통과한다(테스트가 실제로 잡았다). 10자리는 구형 국번(011·016~019)에만 있다.
- `+82 10-…` 형태는 국가번호를 떼고 `0`을 붙인다.
- **애매하면 `null`이다.** 잘못된 번호로 보내면 남의 전화기에 남의 예약 정보가 간다. `null`이 이 시스템의 분기점 — 번호가 없으면 자동 발송이 아니라 '문구 복사 + 사람이 직접 보내기' 경로로 간다.
- 어드민(`admin.html`)에도 같은 정규식이 있지만 그건 편의일 뿐이다. **진짜 방어는 서버에 있다** — 어드민 화면은 소스가 그대로 공개된다.

### 7-4. Mattermost 알림

웹훅 주소는 `MATTERMOST_SMS_WEBHOOK_URL`이 있으면 그쪽, 없으면 `MATTERMOST_WEBHOOK_URL`. 기기 알림이 문자를 덮으면 코드를 안 고치고 전용 웹훅만 넣어 분리한다.

| 함수 | 언제 | 실리는 것 |
| --- | --- | --- |
| `notifySent` | 발송 성공 | 종류 라벨 · 이름 · 예약 슬롯 · 자동/어드민. **번호는 싣지 않는다** — 안 올리면 안 새는 값이다 |
| `notifyFailed` | `failed`, `no_phone` | 위 + **수신 번호** + 벤더 사유 원문 + "손으로 보내야 합니다". 실패했을 때는 그 번호로 직접 보내야 하므로 채널에 있어야 유용하다 |
| `notifyUnknown` | `unknown` | 위 + "보냈는지 불분명해 자동 재발송을 멈췄습니다. SOLAPI 콘솔에서 확인 후, 안 갔으면 어드민에서 재발송하세요" |
| `notifyExpired` | `expired` | 종류 · 이름 · 슬롯 + "보낼 시각을 놓쳐 건너뛰었습니다". **조용히 넘기지 않는다** — 무인 공간에서 안 나간 문자는 아무도 모르면 없었던 일이 되고, 손님은 안내를 못 받은 채 도착한다 |

기기 알림(`automation/notify.ts`)의 선점·묶음 장치를 쓰지 않는다. 그쪽은 입실 준비 한 번이 명령 8개를 낳아 묶지 않으면 채널을 못 쓰게 되지만, 문자는 예약당 4~5통이 몇 시간에 걸쳐 나가므로 묶을 것이 없다. `device_events` 테이블에 얹지 않는 이유는 더 분명하다 — 그 테이블은 `device_id`·`command`가 본질이라 문자를 넣으면 타입이 거짓말을 하게 된다.

## 8. 데이터 모델

### 8-1. 장부 행 (`public.reservation_sms`)

```typescript
/** DB의 check constraint와 1:1. 8종 전부. */
type SmsStatus =
  | "sending"     // 선점만 하고 발송 중. 오래 남아 있으면 함수가 발송 도중에 죽은 것이다
  | "sent"        // 발송됨
  | "failed"      // 벤더가 확정 거절(4xx·건별 거절). 유니크 인덱스 밖 — 다음 틱이 재시도
  | "unknown"     // 결과 불명(타임아웃·네트워크 예외·5xx). 자리를 막아 자동 재시도를 멈춘다
  | "no_phone"    // 자동발송은 켜져 있는데 연락처가 없어 못 보냄
  | "manual"      // 번호가 없어 사람이 문자 앱으로 직접 보냄
  | "expired"     // 발송 창을 놓쳐 안 보냄
  | "superseded"; // 뒤에 재발송으로 대체됨. 유니크 인덱스 밖 — 자리를 비우면서 이력은 남는다

type SmsKind = "deposit" | "confirm" | "checkin" | "checkout_soon" | "checkout";

interface ReservationSms {
  id: number;                 // bigint generated always as identity, PK
  reservation_id: string;     // uuid, references reservations(id) on delete cascade
  kind: SmsKind;              // check 제약으로 5종 고정
  status: SmsStatus;          // check 제약으로 8종 고정
  to_phone: string | null;    // 정규화된 수신번호. no_phone 행에는 없다
  body: string | null;        // 실제로 보낸 본문. 템플릿은 시간이 지나면 바뀌므로
                              // "그때 무엇을 보냈나"는 여기에만 남는다. expired 행에는 없다
  group_id: string | null;    // SOLAPI groupId. 벤더 콘솔에서 같은 건을 찾을 때 쓴다
  error: string | null;       // 벤더 사유 원문 (failed·unknown·no_phone)
  created_at: string;         // timestamptz not null default now()
  sent_at: string | null;     // timestamptz. sent·manual에만 채워진다
}
```

상태별로 어떤 컬럼이 채워지는가:

| status | to_phone | body | group_id | error | sent_at |
| --- | --- | --- | --- | --- | --- |
| `sending` | O | O | - | - | - |
| `sent` | O | O | O (벤더가 주면) | - | O |
| `failed` | O | O | - | O | - |
| `unknown` | O | O | - | O | - |
| `no_phone` | - | O | - | O ("연락처가 없어 자동 발송하지 못했습니다") | - |
| `manual` | O (있으면) | O | - | - | O |
| `expired` | O (있으면) | - | - | - | - |
| `superseded` | 직전 상태 그대로 | 그대로 | 그대로 | 그대로 | 그대로 |

**발송 이력을 `reservations` 컬럼으로 펴지 않는다.** 문자가 5종이라 `sms_checkin_at`류로 펴면 종류가 늘 때마다 마이그레이션이 붙고, 무엇보다 **실패 사유를 적을 자리가 없다.** 조용히 안 나간 문자는 없는 기능보다 나쁘다 — 아무도 모르기 때문이다.

### 8-2. 예약 쪽 추가 컬럼 (`public.reservations`)

```typescript
interface ReservationSmsFields {
  sms_auto: boolean;          // not null default false. 옵트인이다
  deposit_required: boolean;  // not null default false. 문구가 갈린다
}
```

| 컬럼 | 기본값 | 이유 |
| --- | --- | --- |
| `sms_auto` | `false` | 기본을 `true`로 두면 이미 등록된 과거·미래 예약 전부에 문자가 나간다 |
| `deposit_required` | `false` | `true`면 보증금 안내·환불 안내가 붙고, `false`면 예약 확정 안내 한 통으로 시작한다 |

### 8-3. 코드 안에서만 쓰는 타입

```typescript
/** 문구를 채우는 데 필요한 최소 필드. 예약 행 전체를 알 필요가 없다. */
interface ReservationForSms {
  date: string;              // 'YYYY-MM-DD' (KST)
  start_time: string;        // 'HH:MM:SS' (KST)
  end_time: string;
  deposit_required: boolean;
}

/** 문자를 보내는 데 필요한 예약 필드. */
interface SmsReservation extends ReservationForSms {
  id: string;
  name: string;
  phone: string | null;
}

/** 스윕 대상 판정에 sms_auto가 하나 더 필요하다. */
interface SweepReservation extends SmsReservation {
  sms_auto: boolean;
}

/** dispatch()가 호출부에 돌려주는 것. 장부 status와 같지 않다 —
 *  already·not_configured는 장부에 적히지 않고, superseded는 여기 없다. */
type DispatchStatus =
  | "sent" | "failed" | "unknown" | "already" | "no_phone" | "not_configured";

interface DispatchResult {
  status: DispatchStatus;
  error?: string;
}

/** 알림에 실을 맥락. 어드민이 눌렀는지 cron이 보냈는지는 읽는 사람에게 전혀 다른 정보다. */
type Origin = "auto" | "admin";

interface SweepResult {
  sent: number;
  failed: number;
  no_phone: number;
  expired: number;
  unknown: number;   // 결과 불명 — 사람이 콘솔에서 확인해야 하는 건수
}

interface SolapiConfig {
  apiKey: string;
  apiSecret: string;
  sender: string;   // 사전 등록된 발신번호만 쓸 수 있다
}
```

`SweepResult`는 `already`를 세지 않는다 — 할 일이 없었다는 뜻이라 0이 맞다. **다만 수동으로 틱을 찔러 디버깅할 때 이게 헷갈린다**: pg_cron이 1분마다 먼저 선점하므로 손으로 부른 틱은 방금 나간 문자에 대해서도 0을 돌려준다. 안 나간 것 같으면 카운터가 아니라 `reservation_sms` 장부를 본다.

## 9. 데이터 저장 구조

```
public.reservations
  ├── sms_auto           boolean not null default false   ← 자동 발송 옵트인
  └── deposit_required   boolean not null default false   ← 문구 분기

public.reservation_sms                                     ← 발송 장부 (RLS on, 정책 0개)
  id · reservation_id · kind · status · to_phone · body · group_id · error · created_at · sent_at
```

제약과 인덱스:

| 이름 | 정의 | 역할 |
| --- | --- | --- |
| `reservation_sms_kind_check` | `kind in ('deposit','confirm','checkin','checkout_soon','checkout')` | 종류 5종 고정 |
| `reservation_sms_status_check` | `status in ('sending','sent','failed','unknown','no_phone','manual','expired','superseded')` | 상태 8종 고정. `unknown`은 2026-08-13에 추가됐다 |
| `reservation_sms_once` | `unique (reservation_id, kind) where status not in ('failed', 'superseded')` | **중복 발송을 막는 유일한 장치.** 조건자는 자리를 **비우는** 상태의 제외 목록이다 — 여기 없는 상태는 전부 자리를 막는다 |
| `reservation_sms_by_reservation` | `(reservation_id)` | 어드민 목록 조회 |
| FK | `reservation_id references reservations(id) on delete cascade` | 예약을 지우면 문자 이력도 같이 사라진다. 그래서 이용 시간 수정을 '삭제 후 재생성'으로 하면 안 된다 |

`unknown`을 추가할 때 **유니크 인덱스는 건드리지 않았다.** 조건자가 제외 목록이라 `unknown`은 별도 처리 없이 자동으로 자리를 막는다. 인덱스를 다시 만드는 것은 의미 변화 0에 라이브 테이블 락만 만드는 위험이다.

`admin_list_reservations`도 손대지 않았다. 라이브 정의가 `returns setof reservations`라 새 컬럼(`sms_auto`·`deposit_required`)이 자동으로 실려 나간다. 문자 이력만 `admin_list_sms`로 따로 내린다 — 지금 돌아가는 목록 RPC의 반환 형태를 바꾸면 어드민 전체가 같이 위험해진다.

## 10. 어드민 문자 박스

### 10-1. 배치

예약 카드 하단에 붙는다. **취소된 예약에는 아예 렌더하지 않는다.**

```
┌─ 예약 카드 ─────────────────────────────────────────────┐
│  홍길동 · 2026.08.16(토) 14:00-18:00 · 4명              │
│  ─────────────────────────────────────────────────────  │
│  문자 안내              [보증금 받음] [자동발송 켬]      │
│                                                          │
│  연락처 01012345678                          [수정]      │
│                                                          │
│  청소 보증금 안내   보냄 08.14 11:20   [다시]  [문구]    │
│  예약 확정 안내     보냄 08.14 11:21   [다시]  [문구]    │
│  입실 안내          대기              [보내기] [문구]    │
│  퇴실 15분 전       대기              [보내기] [문구]    │
│  퇴실 시간 안내     대기              [보내기] [문구]    │
│                                                          │
│  청소 보증금 안내 보냈어요.                              │
└──────────────────────────────────────────────────────────┘
```

연락처가 없을 때의 머리줄:

```
│  연락처 없음  [입력]  — 넣고 자동발송을 켜면 예정된 안내가 나가요  │
```

"넣으면 자동으로 나가요"라고 쓰지 않는다. 자동발송이 꺼져 있으면 아무것도 안 나가고, 이미 `no_phone`으로 적힌 건은 번호를 넣어도 저절로 되살아나지 않는다(장부가 자리를 잡고 있어 재발송을 눌러야 한다). **못 지킬 약속을 화면에 적지 않는다.**

### 10-2. 섹션별 상세

#### 머리줄 — 토글 둘

- **기능**: `보증금 받음/없음`은 `admin_set_deposit` RPC를 직접 부른다. `자동발송 켬/끔`은 Edge Function의 `sms_auto` action을 부른다(켜는 즉시 첫 통이 나가야 하므로 SQL로 못 한다).
- **UI**: 켜진 쪽은 잉크 배경. 작업 중이면 둘 다 `disabled`.
- **데이터**: `reservations.deposit_required`, `reservations.sms_auto`.
- 보증금 토글을 바꾸면 `deposit` 줄이 목록에서 나타나거나 사라진다 — 표시 목록은 서버의 `kindsFor()`와 같은 규칙이다.

#### 연락처 줄

- **기능**: `admin_set_phone` RPC. **빈 칸만 채우는 게 아니라 덮어쓴다** — 오타 수정도 되고, 수동 등록 예약(`booking_no`가 null)도 손댈 수 있다. `admin_fill_contact`와 일부러 다르다.
- **UI**: 있으면 번호 + `수정`, 없으면 주황색 `연락처 없음` + `입력`.
- **저장 직후**: 자동발송이 이미 켜져 있었다면 `sms_auto { value: true }`를 한 번 더 불러 **번호가 없어서 못 나갔던 첫 통을 지금 보낸다.** 그게 없으면 "자동발송 켬 + 연락처 있음"인데 아무것도 안 나간 상태로 남는다 — 시각 기반 안내는 cron이 챙기지만 그 둘은 챙길 주인이 없다.

#### 종류별 줄 (5행, 보증금 없으면 4행)

- **기능**: 상태 표시 + `보내기`/`다시` + `문구`.
- **UI 상태 문구**: '대기'와 '못 보냄'을 **절대 같은 색으로 두지 않는다** — 안 나간 문자가 조용히 섞이면 아무도 안 본다.

| status | 표시 | 색 |
| --- | --- | --- |
| 기록 없음 · `superseded` | 대기 | 기본 |
| `sent` | 보냄 MM.DD HH:MM | 초록 |
| `manual` | 직접 보냄 MM.DD HH:MM | 초록 |
| `sending` | 보내는 중… | 기본 |
| `failed` | 실패 MM.DD HH:MM | 빨강 |
| `no_phone` | 연락처 없어 못 보냄 | 빨강 |
| `expired` | 시각 놓침 | 빨강 |

- **재발송은 2클릭이다.** 이미 `sent`/`manual`인 줄의 버튼은 `다시`로 바뀌고, 누르면 먼저 `한 번 더 눌러 재발송`(주황 테두리)으로 변한다. 같은 안내를 손님이 두 번 받는 일이라 한 번 더 묻는다. `confirm()`을 쓰지 않는 이유는 그 모달이 화면을 통째로 멈춰 세우기 때문 — 확인은 버튼 자리에서 끝난다.
- 연락처가 없으면 `보내기` 버튼 자체가 없다. **`문구`는 언제나 열어둔다** — 발송이 실패해도, 번호가 없어도, 사람이 손으로 보낼 수 있어야 한다.
- 행에 `error`가 있으면 그 아래 빨간 작은 글씨로 벤더 사유 원문을 그대로 보여준다.
- **데이터**: `admin_list_sms`가 내린 장부 전체를 `(reservation_id, kind)`별 `created_at` 최대값으로 접어서 쓴다.

#### 문구 복사 모달 (`문구` 버튼)

- `sms_preview` action으로 **서버가 만든 실제 발송 문구**를 받아 textarea에 넣는다. 미리보기와 실제 발송이 다를 여지를 남기지 않는다.
- `문구 복사하기` — `navigator.clipboard` 실패 시 textarea select 방식으로 폴백.
- `보냈어요` — `sms_mark_manual` action으로 장부에 `manual` 행을 남긴다. 이 상태가 없으면 '아직 안 보냄'과 '문자 앱으로 보냈음'을 구분할 수 없어, 어드민 화면이 영원히 빨간 채로 남고 결국 아무도 안 보게 된다.

#### 잠금과 결과 알림

모든 문자 작업은 `smsRun()`을 지난다: 카드 전체를 `busy`로 잠그고 → 작업 → **`refresh()`가 실패해도 잠금을 반드시 푼다.**

목록 갱신이 실패했을 때 카드가 버튼이 전부 잠긴 채 굳으면, 문자는 실제로 나갔는데 화면은 아무 반응이 없는 상태가 된다. 그러면 사람이 다시 누르게 되고, **그게 곧 중복 발송이다.**

결과는 상태 코드가 아니라 사람 말로 적는다:

| 결과 | 화면 문구 |
| --- | --- |
| `sent` | "(종류) 보냈어요." |
| `already` | "(종류)는 이미 보낸 기록이 있어요. 다시 보내려면 '다시'를 누르세요." |
| `no_phone` | "(종류) — 연락처가 없어요. 번호를 넣거나 문구를 복사해 보내세요." |
| `expired` | "(종류)는 보낼 시각이 지나 건너뛰었어요. 남은 안내는 예정대로 나가요." |
| `not_configured` | "문자 서비스가 아직 설정되지 않았어요." |
| 그 밖 | "(종류) 실패: (사유) — 문구를 복사해 직접 보내세요." |

장부를 못 받았으면(`admin_list_sms` 실패) 박스 하단에 "문자 이력을 못 받았어요 — 위 상태가 실제와 다를 수 있어요"를 띄운다. 화면이 '대기'라고 거짓말하게 두지 않는다.

## 11. 기술 구현

### 모듈 구조

```
supabase/functions/control/
  index.ts                     ← action 라우팅 (sms_preview·sms_send·sms_mark_manual·sms_auto)
  auth.ts                      ← GUEST_ACTIONS에 문자 action이 없다 = 손님 403
  handlers/
    sms.ts                     ← 어드민 표면. 입력 검증 · 예약 조회 · HTTP 번역만
    automation.ts              ← 1분 틱. sweepSms를 기기 자동화와 격리해 부른다
  sms/
    templates.ts               ← 문구 정본. 네트워크도 DB도 없는 순수 함수만
    schedule.ts                ← 시각 판정. DB도 벤더도 안 건드린다
    dispatch.ts                ← 한 통을 실제로 내보내는 유일한 경로
    sweep.ts                   ← 자동 스윕. 판정과 발송을 이어 붙이기만 한다
    solapi.ts                  ← 벤더 클라이언트. 서명·요청·에러 매핑. 무엇을 보낼지는 모른다
    notify.ts                  ← Mattermost 한 건 한 줄
```

### 함수

```
sms/templates.ts
  ├── SMS_KINDS · KIND_LABEL          ← 종류와 사람이 읽는 이름
  ├── formatSlot(r)                   ← '2026.08.10(월) 14:00–18:00'
  ├── kindsFor(r)                     ← 이 예약에 실제로 나가는 종류. 화면도 스윕도 이것만 본다
  └── render(kind, r)                 ← 실제 본문

sms/schedule.ts
  ├── dueAt(r, timing)                ← 기준 시각. 퇴실은 반드시 windows.endTime 경유
  ├── stateOf(r, timing, now)         ← wait | fire | expired
  └── plan(r, now)                    ← { fire, expired }

sms/dispatch.ts
  ├── dispatch(sb, r, kind, origin)   ← 선점 → 발송 → 기록 → 알림
  ├── markExpired(sb, r, kind)        ← 창 놓침을 장부와 채널에
  ├── markNoPhone(sb, r, kind)        ← 번호 없음. failed로 적지 않는다
  ├── markManual(sb, r, kind)         ← 사람이 직접 보냄
  └── supersede(sb, id, kind)         ← 재발송 전 기존 기록을 물러나게 한다

sms/solapi.ts
  ├── loadConfig()                    ← 셋이 다 있어야 '설정됨'
  ├── normalizePhone(raw)             ← 보낼 수 있는 번호인가. 애매하면 null
  ├── sign(secret, date, salt)        ← HMAC-SHA256 → 소문자 hex (순수 함수, 테스트가 붙는다)
  ├── isoDate(now)                    ← 밀리초를 뗀 ISO8601
  ├── classifyHttpFailure(status)     ← >=500이면 unknown, 아니면 rejected (순수 함수)
  └── send(cfg, to, text)             ← 어떤 예외도 밖으로 던지지 않는다

sms/sweep.ts
  └── sweepSms(sb, reservations, now) ← 예약별 try/catch. 한 건 실패가 나머지를 막지 않는다

handlers/sms.ts
  ├── preview(sb, body)               ← 복사용 문구. 번호가 없어도 부를 수 있어야 한다
  ├── sendOne(sb, body)               ← 한 통. resend:true면 supersede 후 발송
  ├── markManualSent(sb, body)        ← 직접 보냄 표시
  └── setAuto(sb, body)               ← 자동발송 토글 + 첫 통
```

### 공통 가드

`assertSendable(r, kind)`가 `preview`·`sendOne`·`markManualSent` 셋 모두에 걸린다:

1. `cancelled`면 400. **어드민이 눌러도 막는다** — 손이 미끄러졌을 때 "곧 입실 시간이네요"가 취소한 손님에게 가는 것은 되돌릴 수 없다. 클라이언트에서 버튼을 감추는 것만으로는 부족하다.
2. `kindsFor(r)`에 없는 종류면 400 (보증금 없는 예약에 `deposit`).

### 발송 요청 형태

```json
{ "messages": [ { "to": "01012345678", "from": "(등록된 발신번호)", "text": "(본문)", "type": "LMS" } ] }
```

`type`을 명시하는 이유: 자동 판별에 맡기면 문구를 조금 줄였을 때 조용히 SMS로 떨어져 45자에서 잘린다. 이 시스템의 문구는 전부 LMS 길이이므로 못 박는다.

## 12. API

### Edge Function action (`POST /functions/v1/control`)

모두 admin 세션 필요. 손님 요청은 라우팅 전 403.

| action | 입력 | 출력 | 비고 |
| --- | --- | --- | --- |
| `sms_preview` | `reservation_id`, `kind` | `{ kind, label, text }` | 번호가 없어도 부를 수 있다. 이게 이 action의 존재 이유 |
| `sms_send` | `reservation_id`, `kind`, `resend?` | `{ kind, status, error? }` | `resend:true`면 `supersede` 후 발송 |
| `sms_mark_manual` | `reservation_id`, `kind`, `resend?` | `{ kind, status: "manual" \| "already" }` | 장부에만 남긴다. 실제 발송 없음 |
| `sms_auto` | `reservation_id`, `value` | `{ sms_auto, immediate }` | `immediate`는 켤 때만 채워진다 |
| `automate` | 없음 | `{ ..., sms: SweepResult }` | pg_cron이 부른다. 손님도 부를 수 있다(anon) |

**발송 실패를 200으로 돌려준다.** 어드민이 그 자리에서 '복사해서 직접 보내기'로 갈아탈 수 있어야 하는데, HTTP 오류로 던지면 화면이 그냥 "실패했어요"에서 멈춘다.

HTTP 오류로 나가는 것은 넷뿐이다:

| 코드 | 언제 |
| --- | --- |
| 400 | `reservation_id` 누락 · 알 수 없는 `kind` · 취소된 예약 · 이 예약에 없는 종류 |
| 404 | 예약을 찾을 수 없음 |
| 500 | 예약 조회 실패 · `sms_auto` 갱신 실패 |
| 503 | SOLAPI 시크릿 미설정 (`sms_send`만). 이 예약의 문제가 아니라 서버가 아직 못 보내는 상태다 |

### RPC (Supabase JS에서 직접 호출)

| RPC | 인자 | 반환 | 비고 |
| --- | --- | --- | --- |
| `admin_set_phone` | `p_password`, `p_id`, `p_phone` | `reservations` | **덮어쓴다.** 빈 문자열은 null로 |
| `admin_set_deposit` | `p_password`, `p_id`, `p_value` | `reservations` | 문구 분기 전환 |
| `admin_list_sms` | `p_password` | `setof reservation_sms` | `created_at` 오름차순, **전 기간**. 범위를 좁히면 '예약은 있는데 문자 이력은 없는' 구간이 생겨 더 헷갈린다 |

셋 다 `SECURITY DEFINER` · `set search_path to 'public'` · 비밀번호 검증은 `perform public.admin_list_reservations(p_password)`에 위임.

## 13. 환경 변수

값은 Supabase 시크릿에만 둔다. 레포에 넣지 않는다.

| 이름 | 필수 | 없으면 |
| --- | --- | --- |
| `SOLAPI_API_KEY` | O | 자동 경로는 콘솔 로그만 남기고 건너뛴다. `sms_send`는 503 |
| `SOLAPI_API_SECRET` | O | 위와 같음 |
| `SOLAPI_SENDER` | O | 위와 같음. 값은 `normalizePhone`을 통과해야 한다 |
| `MATTERMOST_SMS_WEBHOOK_URL` | - | `MATTERMOST_WEBHOOK_URL`로 폴백 |
| `MATTERMOST_WEBHOOK_URL` | - | 알림을 건너뛰고 콘솔 경고만. 발송 자체는 정상 |

셋 중 하나라도 없으면 '미설정'이다 — 반쪽 설정으로 보내면 벤더까지 왕복해서 401을 받고, 그 실패가 '문자 서비스 장애'처럼 보인다.

## 14. 의존성

| 대상 | 관계 |
| --- | --- |
| `automation/windows.ts` (`targetTime`·`endTime`) | KST 변환과 자정 넘김 해석. **기기 자동화와 같은 함수를 봐야 둘이 어긋나지 않는다** |
| `automation/store.ts` (`fetchRecent`) | 스윕 대상 예약. 범위가 예약 전후 1일이라 첫 두 통이 cron일 수 없는 원인 |
| `handlers/automation.ts` | 1분 틱의 호출자. 문자 스윕을 기기·청소와 각각 try/catch로 격리 |
| `spec_admin_auth` | 어드민 세션·비밀번호 검증. RPC 셋이 `admin_list_reservations`에 위임 |
| `spec_reservation_sync` | `reservations` 행 자체. `phone`이 비어 들어오는 경로(스페이스클라우드 050 안심번호)가 `no_phone`의 주 원인 |
| `spec_reservation_automation` | 같은 예약 행이 기기 자동화의 입력이다. **문자 검증한다고 라이브에 테스트 예약을 만들면 냉난방·조명이 실제로 움직인다** |
| `spec_cleaning_sms` | 별도 계통(청소 담당자 대상). 같은 틱에서 돌지만 장부도 템플릿도 다르다. 참조만 |
| `spec_support_apply` | 별도 계통(신청 결과 문자). 참조만 |

## 15. 관련 스펙 변경

| 스펙 | 변경 내용 |
| --- | --- |
| `spec_reservation_automation` | `admin_set_time` RPC가 퇴실 시각이 바뀌면 `checkout_soon`·`checkout` 장부 행을 `superseded`로 내린다 (`status not in ('failed','superseded')`인 것만). 안 내리면 옛 시각으로 잡힌 문자가 그대로 나가 손님이 틀린 시각을 안내받는다 |
| `spec_reservation_automation` | 이용 시간 수정을 '삭제 후 재생성'으로 하면 안 되는 이유가 여기 있다 — `reservation_sms`가 cascade로 지워져 문자 이력이 통째로 날아간다 |
| `spec_admin_auth` | 문자 RPC 셋이 `admin_list_reservations`의 비밀번호 검증에 얹혀 있다. 그 함수의 시그니처가 바뀌면 셋 다 같이 바뀐다 |

## 16. 파일 구성

| 파일 | 경로 | 설명 |
| --- | --- | --- |
| `templates.ts` | `supabase/functions/control/sms/templates.ts` | 문구 정본. 종류·라벨·`kindsFor`·`render`·`formatSlot` |
| `schedule.ts` | `supabase/functions/control/sms/schedule.ts` | 시각 판정. `TIMINGS`·`dueAt`·`stateOf`·`plan` |
| `dispatch.ts` | `supabase/functions/control/sms/dispatch.ts` | 한 통 발송 + 장부 기록 5종(`dispatch`·`markExpired`·`markNoPhone`·`markManual`·`supersede`) |
| `sweep.ts` | `supabase/functions/control/sms/sweep.ts` | 자동 스윕 `sweepSms` |
| `solapi.ts` | `supabase/functions/control/sms/solapi.ts` | SOLAPI 클라이언트. 서명·번호 정규화·실패 분류 |
| `notify.ts` | `supabase/functions/control/sms/notify.ts` | Mattermost 알림 4종 |
| `templates.test.ts` | `supabase/functions/control/sms/templates.test.ts` | 문구 검증. 발송 없이 전부 돈다 |
| `schedule.test.ts` | `supabase/functions/control/sms/schedule.test.ts` | 시각 판정 검증(자정 넘김 포함) |
| `solapi.test.ts` | `supabase/functions/control/sms/solapi.test.ts` | 서명 고정값·번호 정규화·HTTP 실패 분류 |
| `sms.ts` | `supabase/functions/control/handlers/sms.ts` | 어드민 action 4종 |
| `index.ts` | `supabase/functions/control/index.ts` | action 라우팅 |
| `auth.ts` | `supabase/functions/control/auth.ts` | `GUEST_ACTIONS` — 문자 action이 없어 손님 403 |
| `automation.ts` | `supabase/functions/control/handlers/automation.ts` | 1분 틱에서 `sweepSms` 호출·격리 |
| `store.ts` | `supabase/functions/control/automation/store.ts` | `fetchRecent` — 스윕 대상 예약 조회 |
| `20260808100000_sms_notify.sql` | `supabase/migrations/` | `reservation_sms` 테이블 · 유니크 인덱스 · `sms_auto`/`deposit_required` · RPC 3종 |
| `20260813120000_sms_unknown_status.sql` | `supabase/migrations/` | `unknown` 상태 추가 (status check 8종으로) |
| `20260808200000_reservation_time.sql` | `supabase/migrations/` | `admin_set_time` — 퇴실 시각 변경 시 퇴실 문자 `superseded` |
| `20260813113000_reservation_time_overnight.sql` | `supabase/migrations/` | 위 RPC의 자정 넘김 대응 개정 |
| `admin.html` | `06-applications/admin.html` | 예약 카드 문자 박스 · 문구 복사 모달 · 연락처/보증금 모달 |
| `_sms-templates.html` | `06-applications/_sms-templates.html` | 사람이 읽고 고치는 문구 시안(보증금 유무 2벌). 정본이 아니다 |
| `control-setup.md` | `06-applications/control-setup.md` | J절 — SOLAPI 준비·시크릿·배포·현장 확인 체크리스트 |

## 17. 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-14 | 최초 작성 (역기획 — 이미 라이브인 구현을 스펙으로 되돌려 적음) |
