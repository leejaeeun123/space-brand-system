# spec_admin_auth

> 타입라운지 무인 운영 시스템의 인증 계층. 어드민·손님·청소 담당자 세 역할을 **서버에서** 가르고,
> 어드민 비밀번호를 던져볼 수 있는 횟수 자체를 IP 기준으로 자른다.
> 운영자(형운)와 손님, 현장 청소 담당자가 같은 백엔드를 서로 다른 권한으로 쓴다.

## 1. 개요

어드민 비밀번호 하나가 이 시스템의 거의 전부를 연다 — 예약자 이름·연락처(`admin_*` RPC),
주민번호·계좌 복호화(`claim`의 `reveal`), CCTV 자격증명, 기기 전원. 그래서 이 스펙이 다루는 것은
"로그인 화면"이 아니라 **그 열쇠 하나를 어디서 어떻게 검증하고 몇 번까지 던지게 둘 것인가**다.

핵심 동작 네 가지:

1. **역할 판정** — 자격증명을 아예 안 보낸 요청이 `guest`, 어드민 비밀번호가 맞으면 `admin`,
   청소 토큰이 맞으면 `cleaner`. **뭔가 보냈는데 안 맞으면 `guest`로 낮추지 않고 401**이다.
2. **허용 범위 절단** — 역할별로 부를 수 있는 action·command를 서버가 자른다. 손님 페이지
   (`guest-control.html`)도 소스가 그대로 공개되므로, 클라이언트에서 버튼을 감추는 것은 방어가 아니다.
3. **인증 뿌리 이원화** — 같은 비밀번호를 Edge Function(`ADMIN_PASSWORD` 상수 시간 비교)과
   SQL(`admin_check` bcrypt 해시)이 **각각** 검증한다. 두 곳이 어긋나면 어드민 화면은 열리는데
   기기 제어만 안 되는 식으로 조용히 갈라진다.
4. **시도 제한** — 10분 롤링 창에 실패 10회를 넘긴 IP는 429. **실패한 인증만** 세고, 장부를 못 읽으면
   잠그지 않고 통과시킨다(fail-open).

개인정보의 수집·암호화·파기 주기는 이 스펙의 범위가 아니다 — `spec_payback_claim`·`spec_support_apply`가 다룬다.
여기서는 그 데이터를 여는 **열쇠**만 다룬다.

## 기술 스택

프로젝트 공통(`CLAUDE.md`) + 이 스펙 고유:

- **Deno / Supabase Edge Functions** — `control`·`claim`·`apply` 세 함수가 같은 인증 모듈을 공유
- **supabase-js v2 (JSR `jsr:@supabase/supabase-js@2`)** — service_role 키로 DB 접근
- **PostgreSQL + pgcrypto** — bcrypt(`crypt`/`gen_salt('bf', 12)`)로 비밀번호 해시
- **PostgREST RPC (SECURITY DEFINER 함수)** — 어드민 화면이 예약·문자·신청 목록을 읽는 경로
- **pg_cron** — 실패 기록 일일 정리(`auth-attempts-cleanup`)
- **브라우저 sessionStorage** — 어드민 세션(탭 수명)
- **Vercel 응답 헤더 + SRI** — CSP·HSTS·`X-Frame-Options` 등(`vercel.json`), CDN 스크립트 무결성

## 실행 환경

| 구성 요소 | 환경 |
| --- | --- |
| Edge Function | Deno / Supabase Edge Runtime. 시크릿은 `Deno.env`(`ADMIN_PASSWORD`·`CLEANING_TOKEN`) |
| DB | Supabase PostgreSQL. 이 스펙의 두 테이블 모두 RLS on + 정책 0 |
| 어드민·손님 페이지 | 브라우저(현장 맥·휴대폰 병용). Vercel 정적 호스팅, `public/`은 `06-applications/` 심링크 |
| 정본 오리진 | `https://typelounge.vercel.app` (CORS 화이트리스트의 단일 출처) |
| **앞단 프록시** | **Cloudflare** — 시도 제한 키(`cf-connecting-ip`)의 전제가 여기 매달린다. 앞단이 Cloudflare가 아니게 되면 키를 다시 정해야 한다 |

## 2. 접근 제어

### 2-1. 역할 판정 흐름

판정은 `supabase/functions/control/auth.ts`의 `resolveRole(password, token)` 한 곳에서 끝난다.

```
요청 본문 { password?, token? }
  │
  ├─ ADMIN_PASSWORD 미설정?  ──▶ 503 "서버 설정이 완료되지 않았습니다" (전면 거부)
  │
  ├─ password === ADMIN_PASSWORD (상수 시간 비교) ──▶ admin
  │
  ├─ password !== ""  (보냈는데 안 맞음)          ──▶ null ⇒ 401 "invalid password"
  │                                                    (guest 로 강등하지 않는다)
  ├─ token !== ""
  │     ├─ CLEANING_TOKEN 미설정                  ──▶ null ⇒ 401
  │     ├─ token === CLEANING_TOKEN (상수 시간)    ──▶ cleaner
  │     └─ 그 외                                  ──▶ null ⇒ 401
  │
  └─ 아무것도 안 보냄                             ──▶ guest
```

### 2-2. 판정 순서가 곧 계약이다

`password`를 **먼저 끝까지** 처리한다. 토큰은 비밀번호를 아예 안 보낸 요청에서만 본다.
둘을 섞으면 "뭔가 보냈는데 admin과 안 맞으면 401"이라는 규칙이 흐려지고, `admin.html`의 오타가
"비밀번호가 맞지 않아요"가 아니라 알 수 없는 403으로 보이기 시작한다.

청소 담당자에게 **비밀번호가 아니라 별도 시크릿**(`CLEANING_TOKEN`)을 쓰는 이유도 같은 계열이다 —
admin 비밀번호를 QR에 넣으면 인쇄물 한 장이 예약자 이름·연락처를 여는 열쇠가 되고, 그 인쇄물은
사진으로 찍히고 스캐너 앱 기록에 남는다.

### 2-3. 허용 범위 — action × 역할

`assertAllowed(role, action, body)`가 자른다. `admin`은 전부 통과, 나머지는 목록에 있는 것만.

| action | admin | guest | cleaner | 비고 |
| --- | :---: | :---: | :---: | --- |
| `list` | ✅ | ✅ | ❌ | guest 응답에서는 기기 `address`를 지운다(2-5) |
| `command` | ✅ | ✅(5종) | ❌ | 허용 command 목록은 아래 표 |
| `automate` | ✅ | ✅ | ❌ | pg_cron이 anon 키로 1분마다 부르는 예약 자동화 트리거 |
| `thinq_devices` | ✅ | ❌ | ❌ | ThinQ 계정의 기기 목록 |
| `register` · `register_light` · `delete` | ✅ | ❌ | ❌ | 기기 등록·해제 = 구성 변경 |
| `sms_preview` · `sms_send` · `sms_mark_manual` · `sms_auto` | ✅ | ❌ | ❌ | 미리보기까지 막는다 — 문구에 예약 일시가 들어가고, 그건 곧 "언제 이 공간이 비는가"다 |
| `cleaning_pending` | ✅ | ❌ | ✅ | 읽기 |
| `cleaning_complete` | ✅ | ❌ | ✅ | 쓰기. 호출 역할이 그대로 출처(`admin`/`qr`)로 기록된다 |
| `cameras` · `camera_credentials` · `camera_register` · `camera_delete` | ✅ | ❌ | ❌ | CCTV 목록·자격증명. 영상 자체는 이 함수를 지나지 않는다 |

거부 문구는 역할별로 다르다 — guest는 `403 "이 페이지에서는 조명·냉난방 조작만 할 수 있어요"`,
cleaner는 `403 "이 QR로는 청소 완료 표시만 할 수 있어요"`.

**손님 허용 command (`GUEST_COMMANDS`) 5종**

| command | 설명 |
| --- | --- |
| `power_on` · `power_off` | 냉난방 전원 |
| `set_temp` | 설정 온도 |
| `set_mode` | 운전 모드 |
| `set_wind` | 풍량 |

값 자체의 유효성은 여기서 안 본다 — `thinq/commands.ts`가 **기기 프로파일**(min/max/step, 모드·풍량 enum)에
대고 검증한다. 그럼에도 목록을 목록으로 남겨두는 이유는, `command` action 전체를 열어버리면 다음에
명령이 하나 추가될 때(기기 초기화 같은 것) 아무도 안 본 채 손님에게까지 열리기 때문이다.

### 2-4. `automate`를 손님에게 열어둔 근거

대상 예약을 호출자가 고르지 못하고 **서버가 지금 시각으로 직접 계산**하므로, 아무나 불러도 엉뚱한
예약이 실행되지 않는다. 그래서 pg_cron이 anon 키만으로 부를 수 있다.
다만 이 action은 guest가 `command`로는 못 하는 일도 한다(외부 웹훅 발송, `device_events`·`device_watch` 쓰기).
실제 피해를 막는 것은 두 가지다 — ThinQ 상태 TTL(호출을 늘려도 벤더 왕복이 비례해 늘지 않음),
알림 선점(`events.claimPending` — 동시 호출해도 한 번만 나감). (형운 결정, 2026-08-07)

### 2-5. 손님 응답 스크러빙

`scrubDevices(role, payload)`가 `role === "guest"`일 때 각 기기의 `address`(ThinQ deviceId · Tasmota 토픽)를 지운다.
PAT 없이는 쓸 수 없고 LAN 밖에서는 닿지 않아 그 자체로 위험하진 않지만, 손님 화면이 쓰지 않는 값이고
안 내리면 안 새는 값이다.

### 2-6. 손님 시간창 (요약)

`guest`는 예약이 진행 중일 때만 기기를 만질 수 있다(`withinReservationWindow`). `automate`는 이 게이트를
**거치지 않는다** — 일해야 하는 순간이 전부 예약 구간 밖(입실 15분 전 준비, 퇴실 전원 종료, 퇴실 후 스윕)이라
게이트를 통과하는 시간대에는 할 일이 없다. 상세는 `spec_space_control`·`spec_reservation_automation`.

## 3. 인증 뿌리 이원화

같은 비밀번호를 **두 곳이 각각** 검증한다. 어드민 화면은 두 경로를 동시에 쓴다 —
예약 목록은 PostgREST RPC로, 기기·CCTV·문자는 Edge Function으로 간다.

| | Edge Function | SQL |
| --- | --- | --- |
| 뿌리 | `Deno.env.get("ADMIN_PASSWORD")` | `public.admin_check(p_password)` |
| 저장 형태 | 평문 시크릿(Supabase Function 시크릿) | bcrypt 해시(`admin_secret.pw_hash`, cost 12) |
| 비교 방식 | `constantTimeEqual` — 길이가 달라도 조기 반환하지 않는다 | `crypt(입력, 저장해시) = 저장해시` — bcrypt라 비교 자체가 상수 시간 |
| 미설정 시 | 503 전면 거부 | 예외(전용 문구) — 통과 아님 |
| 실패 표현 | HTTP 401 `{ error: "invalid password" }` | `raise exception 'invalid password'` |

실패 문구를 `invalid password`로 **맞춘 것이 의도**다. `admin.html`의 `isAuthError()`가 그 문자열로
"비밀번호가 틀림"과 "연결 실패"를 가른다(5-3).

### 3-1. 왜 SQL 쪽을 해시로 옮겼나

원래 인가 판정은 SQL 함수 본문 안의 **평문 비교**였다. 평문은 `pg_proc.prosrc`에 남아 DB 덤프·백업·
대시보드 열람자 전원에게 보인다. 게다가 그 값 하나가 예약자 이름·연락처·주민번호 복호화·CCTV 자격증명을
전부 연다. `admin_check`가 그 판정의 단일 뿌리가 되면서, Edge Function 쪽에 상수 시간 비교를 넣을
이유도 같이 생겼다 — 이전에는 "어차피 SQL이 평문으로 비교하니 한 곳만 조여봐야 소용없다"가 근거였다.

### 3-2. 열 함수가 뿌리 둘로 덮이는 구조

`admin_*` 함수는 라이브에 17개 있고, 그중 아홉은 `perform public.admin_list_reservations(p_password)`로
검증을 위임한다. 그래서 **뿌리 둘만 고치면 열 개가 덮인다**:

```
admin_check(p_password)            ← 유일한 검증 로직 (bcrypt)
  ├── admin_list_reservations      ← 아홉 함수가 여기로 위임
  │     ├── admin_fill_contact · admin_set_time · admin_set_phone · admin_set_deposit
  │     └── admin_list_sms · admin_list_applications · admin_list_paybacks · admin_list_application_sms
  ├── admin_set_cancelled          ← 유일하게 자체 평문 검사를 갖고 있던 함수
  └── (20260813111100 으로 회수한 다섯)
        admin_add_reservation · admin_delete_reservation
        admin_set_checkin · admin_set_checkout · admin_set_cleaning
```

[확인 필요: 위임 함수가 '아홉'이라고 적혀 있지만 마이그레이션 `20260813111000` 주석에 이름이 나오는 것은 여덟이다.
아홉 번째의 이름은 레포만으로는 알 수 없다 — 라이브 스키마 덤프(`select proname from pg_proc where proname like 'admin\_%'`)로
확인해 이 트리를 채운다. 같은 이유로 17 = 1(뿌리) + 1(set_cancelled) + 5(회수) + 9(위임) 가 맞아떨어지지 않는다.]

회수한 다섯은 **버전 관리 밖에 있었다** — 마이그레이션이 아니라 DB 편집기에서 직접 만들어져 라이브에만
존재했고, 본문에 옛 PIN을 평문으로 들고 있었다(값은 여기 적지 않는다). 회전만 하고 이 회수를 안 밀면
두 방향으로 깨진다: 새 비밀번호로는 예약 추가·삭제·입퇴실·청소 표시가 거부되고, 옛 PIN은 그 다섯을
계속 연다. 그래서 회수 파일과 전환 파일은 같은 순간에 올라가야 한다.

### 3-3. 비밀번호 심기 (`admin_set_password`)

```sql
select public.admin_set_password('...');   -- 평문은 인자로만 지나가고 저장되지 않는다
```

- **16자 미만은 거부**한다(옛 값이 10자리 숫자 PIN이었다 — 시도 제한이 있어도 좁은 키스페이스는 얇은 방어다).
- 해싱 파라미터(bcrypt cost 12)를 함수 한 곳에 고정한다 — 심는 사람마다 다른 강도를 쓰지 않게.
- pgcrypto가 `extensions`에 있는지 `public`에 있는지는 프로젝트마다 달라, 함수의 `search_path`가 대신 찾는다.
- ⚠️ `set search_path to 'public, extensions'`처럼 **따옴표로 묶으면 안 된다** — 스키마 둘이 아니라
  `"public, extensions"`라는 이름의 단일 스키마로 해석돼 `crypt`를 못 찾고 모든 인증이 실패한다(실측).

### 3-4. 전환 순서를 시스템이 강제한다

`supabase db push`에는 "여기까지만" 옵션이 없어 미적용분을 전부 민다. 그러면 비밀번호를 심기 전에
전환 마이그레이션까지 올라가 **어드민이 통째로 잠긴다** — 무인 공간에서 그건 현장 대응 불가다.

그래서 전환 파일(`20260813111000`)과 회수 파일(`20260813111100`) 앞머리에 같은 게이트를 둔다:

```sql
if not exists (select 1 from public.admin_secret where id = 1) then
  raise exception using message = '비밀번호를 먼저 심어야 합니다 — ...';
end if;
```

예외를 던지면 **마이그레이션 전체가 롤백**된다. 잠긴 채 남는 것보다 아예 안 바뀌는 쪽이 낫다.
절차 정본은 `06-applications/control-setup.md` M절이다(이 문서에 복사하지 않는다).

### 3-5. 현재 배포 상태 (2026-08-13 `control-setup.md` M절 기준)

| 구성 | 상태 |
| --- | --- |
| 시도 제한(`auth_attempts` + 세 함수 배선) | ✅ 적용 |
| CSP·SRI·응답 헤더 | ✅ 적용 |
| `admin_secret` 테이블 · `admin_check` · `admin_set_password` | ✅ 존재하나 **아무도 안 쓴다** |
| 전환(`20260813111000`) · 회수(`20260813111100`) | ⬜ 원격 미적용 |
| 비밀번호 회전 | ⬜ 미실행 — 라이브 SQL은 여전히 평문 비교이고, git 이력의 옛 값이 아직 유효하다 |

즉 **이 스펙의 3장은 설계이자 절반은 예정**이다. 회전·전환을 실행하는 시점에 이 표를 갱신한다.

## 4. 시도 제한 (`_shared/throttle.ts`)

### 4-1. 계약

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 창 | 10분 롤링(`WINDOW_MS`) | 창 안의 실패만 센다 |
| 상한 | 실패 10회(`MAX_FAILS`) | 사람이 10분에 열 번 틀리지 않는다. 대입에는 의미 있는 상한이다 |
| 키 | `cf-connecting-ip` (없으면 `x-forwarded-for`의 **마지막** 항목) | 아래 4-3 |
| 세는 대상 | **실패한 인증만** | 성공을 세면 정상 사용자가 자기 문을 잠근다 |
| 초과 시 | HTTP 429 + `THROTTLED_MESSAGE` | 남은 시간을 알려줘야 다시 안 두드린다 |
| 장부 조회 실패 | **통과시킨다(fail-open)** + `console.error` | 4-4 |
| 기록 실패 | 요청 처리 계속 | 부가 장치이지 인증 자체가 아니다 |

**판정은 비밀번호 검증보다 먼저다.** 검증 후에 물으면 이미 한 번 더 던져본 뒤다. 그 결과,
창 안에서 10회를 넘긴 IP는 **맞는 비밀번호를 보내도 429**를 받는다 — 의도된 동작이다.

### 4-2. 표면별 배선 — 세 곳이 카운터 하나를 공유한다

세 함수가 같은 `ADMIN_PASSWORD`를 검증하므로 카운터도 하나여야 한다(`auth_attempts` 한 테이블).
한 곳만 조이면 공격자는 안 조인 표면으로 옮겨가 같은 값을 계속 던진다.

| 표면 | 제한 진입 조건 | 자격증명 미제출 요청은? |
| --- | --- | --- |
| `control` | `password` 또는 `token`을 **뭐라도 보낸** 요청만(`guessing` 가드) | 조회 자체를 건너뛴다 — pg_cron의 `automate`와 손님 페이지가 여기 해당 |
| `claim` | 공개 `submit`이 먼저 반환된 뒤, 어드민 전용 action 전부 | 빈 비밀번호도 `isAdmin` 실패로 **1회 카운트**된다 |
| `apply` | 공개 `submit`이 먼저 반환된 뒤, 어드민 전용 action 전부 | 빈 비밀번호도 `isAdmin` 실패로 **1회 카운트**된다 |

`control`에만 `guessing` 가드가 있는 이유는 그 함수만 **자격증명 없는 정상 트래픽**을 받기 때문이다 —
pg_cron이 1분마다 부르는 `automate`를 세면 자동화가 스스로 문을 잠그고 무인 공간이 조용히 죽는다
(#44·#70에서 자동화 침묵이 실제로 두 번 일어났다). `claim`·`apply`의 공개 접수 경로는 이 검사 **위**에서
이미 반환되므로 신청자는 영향받지 않는다.

### 4-3. 왜 `cf-connecting-ip`인가

`x-forwarded-for`는 못 쓴다. 2026-08-13 라이브 실측 — 이 플랫폼은 **클라이언트가 보낸 XFF를 그대로 통과시킨다.**
값을 매 요청 바꾸면 바구니가 매번 새로 생겨 제한이 통째로 뚫렸다(위조 헤더로 13회를 던져도 안 막혔고,
헤더 없이 같은 횟수면 막혔다). 첫 항목이든 마지막 항목이든 목록 전체가 호출자 손에 있다.

`cf-connecting-ip`는 앞단 Cloudflare가 붙인다. **클라이언트가 이 헤더를 보내면 Cloudflare가 요청 자체를
403으로 거부**하므로(실측: `error code: 1000`) 위조값이 함수까지 도달할 수 없다.
XFF 폴백은 Cloudflare를 안 거치는 환경(로컬 실행)을 위한 것이고, 그 경우 신뢰 경계가 달라지므로
우리와 가장 가까운 홉인 **마지막 항목**을 쓴다.

⚠️ **전제**: 앞단이 Cloudflare여야 한다. 앞단 구성이 바뀌면 이 키는 즉시 무의미해진다.

### 4-4. 왜 fail-open인가

판정 테이블을 못 읽는 상황에서 잠그면, DB 장애가 곧 "어드민이 현장에 못 들어가고 자동화도 멈춤"이 된다.
무인 공간에서 그 대가는 대입 공격의 기대 피해보다 크고, 공격자가 이 조회를 실패시킬 수단도 없다.
대신 반드시 로그를 남긴다 — 이게 조용하면 방어가 사라진 것도 조용해진다.

### 4-5. 기록 정리

`pg_cron` 잡 `auth-attempts-cleanup`이 매일 04:23에 하루 지난 기록을 지운다. 판정 창(10분)보다 넉넉하게
두되, 반복 공격의 흔적은 하루 정도 남겨 사람이 볼 수 있게 한다.

## 5. 어드민 게이트 — 로그인과 세션 (`admin.html`)

### 5-1. 화면

```
┌──────────────────────────────────┐
│         TYP [E] LOUNGE           │  ← 워드마크
│  ┌────────────────────────────┐  │
│  │ 비밀번호                    │  │  ← input[type=password] maxlength=64 (회전 대비, 2026-08-14)
│  └────────────────────────────┘  │
│           [   입장   ]           │
│  pwError: 확인 중... /            │
│          비밀번호가 맞지 않아요. /  │
│          연결에 실패했어요. ...    │
└──────────────────────────────────┘
```

### 5-2. 입장 흐름 (`tryUnlock`)

**목록 RPC 호출 성공이 곧 인증이다** — 별도의 로그인 API가 없다.

```
입력값 → sb.rpc('admin_list_reservations', { p_password })
  ├─ 성공 → currentPassword = 값
  │         sessionStorage[typelounge_admin_password] = 값  (평문)
  │         showApp() → refresh()  (문자 이력·신청 목록은 그 다음에 채운다)
  └─ 실패 → isThrottleError(err) ? '비밀번호 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.'
            : isAuthError(err)   ? '비밀번호가 맞지 않아요.'
                                 : '연결에 실패했어요. 잠시 후 다시 시도해 주세요.'
```

문자 이력·신청 목록을 **잠금 해제 경로에 올리지 않는 것**이 의도다. 같이 묶었다가 그쪽이 실패하면
비밀번호가 맞는데도 "맞지 않아요"가 뜬다.

### 5-3. 오류 분기

| 상황 | 서버 응답 | 화면 문구 |
| --- | --- | --- |
| 비밀번호 불일치 | `invalid password` | 비밀번호가 맞지 않아요. |
| 네트워크·DB 오류 | 그 외 메시지 | 연결에 실패했어요. 잠시 후 다시 시도해 주세요. |
| 시도 제한 초과 | `too many attempts` (admin_check) 또는 429 (Edge) | 비밀번호 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요. — `isThrottleError` 분기(2026-08-14, 종전에는 "연결에 실패했어요"로 뭉개지던 결함) |

### 5-4. 세션

- 저장소: `sessionStorage`, 키 `typelounge_admin_password`, **평문**. 탭이 닫히면 사라진다.
- 비밀번호는 자격증명이자 곧 API 인자다 — 모든 RPC·Edge 호출에 `p_password`/`password`로 실린다.
  그래서 메모리(`currentPassword`)와 sessionStorage 양쪽에 평문으로 상주한다. 이 노출을 감수하는 대신
  **스크립트 유입 경로를 막는 것**이 10장(CSP·SRI)의 목적이다.
- 재검증: 페이지 로드 시 저장값으로 `admin_list_reservations`를 다시 부른다.
  **인증 오류일 때만 세션을 버린다** — 예전엔 어떤 오류든 지웠고, 그러면 현장 와이파이가 잠깐 끊긴 채
  새로고침한 것만으로 로그아웃됐다.
- 로그아웃(`lock()`): 세션 삭제 + `currentPassword` 비움 + **CCTV 스트림 종료(`leaveCctv`)** +
  **카메라 자격증명 폐기(`CAM.creds = null`)**. 화면만 가리고 스트림이 계속 흐르면 "로그아웃했다"는 말이 거짓이 된다.

## 6. 데이터 구조(모델)

실제 SQL(`20260813100000_auth_throttle.sql`·`20260813110000_admin_secret.sql`) 기준.

```typescript
/** 요청자의 역할. 이 셋이 전부다. */
type Role = "admin" | "guest" | "cleaner";

/** 어느 함수에서 실패했는지. 한 IP가 여러 표면을 훑는 것을 구분하려고 남긴다. */
type AuthSurface = "control" | "claim" | "apply";

/** public.auth_attempts — 인증 '실패' 기록. 성공한 인증은 남기지 않는다. */
interface AuthAttempt {
  id: number;        // bigint generated always as identity, PK
  ip: string;        // text not null — cf-connecting-ip (폴백: XFF 마지막 항목, 둘 다 없으면 빈 문자열)
  fn: AuthSurface;   // text not null — 실패한 표면
  at: string;        // timestamptz not null default now() — 실패 시각
}

/** public.admin_secret — 어드민 비밀번호의 bcrypt 해시. 행은 하나뿐이다. */
interface AdminSecret {
  id: 1;             // int PK default 1, check (id = 1) — 단일 행 강제
  pw_hash: string;   // text not null — crypt(평문, gen_salt('bf', 12)). 평문은 어디에도 없다
  rotated_at: string; // timestamptz not null default now() — 마지막 회전 시각(사람이 주기를 눈으로 본다)
}

/** 시도 제한 상수 (_shared/throttle.ts) */
const WINDOW_MS = 10 * 60_000;  // 판정 창 10분
const MAX_FAILS = 10;           // 창 안 허용 실패 횟수
```

### 미설정·실패 시 기본 동작

| 상황 | 동작 | 이유 |
| --- | --- | --- |
| `ADMIN_PASSWORD` 미설정 | 503 전면 거부 | 무인증 제어로 열리는 것보다 닫혀 있는 게 낫다 |
| `CLEANING_TOKEN` 미설정 | 어떤 토큰도 401 | 빈 문자열끼리 우연히 맞아떨어지는 것을 막는다 |
| `admin_secret` 비어 있음 | `admin_check` 예외(전용 문구) | 미설정이 '누구나 통과'로 해석되면 안 된다. 다만 `invalid password`로 뭉개면 원인을 못 찾는다 |
| `auth_attempts` 조회 실패 | 제한 건너뛰고 통과 | fail-open(4-4) |
| `auth_attempts` 기록 실패 | 요청 처리 계속 | 부가 장치이지 인증 자체가 아니다 |
| 전환 마이그레이션 + 빈 `admin_secret` | 마이그레이션 전체 롤백 | 잠긴 채 남는 것보다 안 바뀌는 쪽이 낫다(3-4) |

## 7. 데이터 저장 구조

```
public.auth_attempts          ← 인증 실패 기록 (RLS on · 정책 0)
  id · ip · fn · at
  index: auth_attempts_ip_at (ip, at desc)   ← 조회는 항상 "이 IP가 최근 N분간 몇 번"
  cron:  auth-attempts-cleanup '23 4 * * *'  ← 하루 지난 기록 삭제

public.admin_secret           ← 비밀번호 해시 단일 행 (RLS on · 정책 0)
  id(=1) · pw_hash · rotated_at
```

### RLS on + 정책 0

두 테이블 모두 `enable row level security`만 하고 **정책을 하나도 만들지 않는다.** 이 레포의 다른
데이터 테이블과 같은 태도다 — 정책을 안 만드는 것이 곧 잠그는 것이다. 결과:

- anon 키로는 읽기도 쓰기도 안 된다(해시조차 못 읽는다).
- 접근 경로는 둘뿐 — service_role을 쓰는 Edge Function, 그리고 `SECURITY DEFINER` RPC.
- 정책을 추가하는 순간 이 구조가 무너지므로, 추가하려면 왜 RPC로 안 되는지부터 답해야 한다.

## 8. 기술 구현

### 모듈 구조

```
supabase/functions/
  _shared/
    secret.ts      ← constantTimeEqual() — 세 함수가 같은 방식으로 비교하게 하는 단일 구현
    throttle.ts    ← clientIp() · isThrottled() · recordFailure() · THROTTLED_MESSAGE
    cors.ts        ← corsHeaders() — 허용 오리진 화이트리스트
  control/
    auth.ts        ← resolveRole() · assertAllowed() · scrubDevices()  (이 함수의 유일한 인증 정책)
    auth.test.ts   ← 역할 판정·허용 범위·스크러빙 단위 테스트
    index.ts       ← 요청 진입점. 시도 제한 → 역할 판정 → 허용 범위 → action 분기
  claim/index.ts   ← isAdmin() 로컬 구현 + 같은 시도 제한
  apply/index.ts   ← isAdmin() 로컬 구현 + 같은 시도 제한

supabase/migrations/
  20260813100000_auth_throttle.sql     ← auth_attempts 테이블·인덱스·RLS·정리 크론
  20260813110000_admin_secret.sql      ← admin_secret 테이블 + admin_check + admin_set_password (도구만)
  20260813111000_admin_use_secret.sql  ← 전환: admin_set_cancelled · admin_list_reservations 를 admin_check 로
  20260813111100_admin_rpc_recover.sql ← 라이브 전용이던 admin_* 다섯 회수 + 같은 전환
```

### 요청 처리 순서 (`control/index.ts`)

```
OPTIONS      → CORS 헤더만 반환
POST 아님    → 405
JSON 파싱 실패 → 400
  ↓
guessing = password 또는 token 이 비어 있지 않음
  ↓
guessing && isThrottled(ip) → 429
  ↓
resolveRole(password, token)  ── null → recordFailure(ip, "control") → 401
  ↓
assertAllowed(role, action, body) ── 위반 → 403
  ↓
role === guest && action !== automate && 예약 시간 밖 → 403 (code: outside_reservation_window)
  ↓
action 분기 (17종)
```

`corsHeaders(req)`를 **핸들러 안에서** 만드는 것이 중요하다 — 모듈 수준 상수로 두면 동시 요청이
서로의 오리진을 물려받는다.

### 테스트

| 파일 | 덮는 것 |
| --- | --- |
| `control/auth.test.ts` | `ADMIN_PASSWORD` 미설정 503 · 역할 판정 4갈래 · `CLEANING_TOKEN` 미설정 · 청소/손님/어드민 허용 범위 · 모르는 command 거부 · 손님 응답 스크러빙 |
| `_shared/throttle.test.ts` | 상한 경계(9/10/99) · fail-open · 실패 기록 형태 · `clientIp` 우선순위(cf > XFF 마지막 > 빈 문자열) |

## 9. API 엔드포인트

| 경로 | 메서드 | 자격증명 | 시도 제한 |
| --- | --- | --- | --- |
| `/functions/v1/control` | POST | `password`(admin) 또는 `token`(cleaner), 또는 없음(guest) | ✅ (자격증명을 보낸 요청만) |
| `/functions/v1/claim` | POST | `password` — 어드민 전용 action에만 | ✅ |
| `/functions/v1/apply` | POST | `password` — 어드민 전용 action에만 | ✅ |
| `/rest/v1/rpc/admin_*` (PostgREST) | POST | `p_password` | ✅ (2026-08-14) — `admin_check` 안의 SQL 제한, 장부 `fn='rpc'` |

마지막 행이 이 스펙의 가장 큰 구멍**이었다** — 어드민 입장 자체가 `admin_list_reservations` RPC
직접 호출이라 대입을 그 경로로 하면 Edge Function 카운터를 타지 않았고, `20260813100000`
머리말의 "공개 엔드포인트 **네 곳**" 중 네 번째가 비어 있었다. 2026-08-14
`20260814150000_admin_check_throttle.sql`이 검증 뿌리(`admin_check`)에 같은 규칙
(10분/10회 · `cf-connecting-ip` · 실패만 카운트 · fail-open)을 얹어 `admin_*` RPC 전체를
한꺼번에 덮는다. `request.headers`가 없는 경로(SQL 편집기·서버측 호출)는 세지도 막지도
않고, Edge Function을 거쳐 온 호출은 그쪽 throttle이 이미 세므로 이중 카운트가 없다.
⚠️ 실효는 해시 전환(M절 2~4단계)이 라이브에 적용되어 `admin_check`가 실제 뿌리가 된 뒤부터다.

## 10. 전송·클라이언트 보안

### 10-1. CORS (`_shared/cors.ts`)

- 허용 오리진은 정본 하나(`https://typelounge.vercel.app`). Vercel 프리뷰 와일드카드는 **일부러 안 넣었다** —
  넣으면 누구나 자기 Vercel 프로젝트를 그 패턴에 맞춰 올려 화이트리스트를 통과한다.
- 목록에 없는 오리진에는 정본 오리진을 돌려준다(헤더를 빼면 브라우저마다 처리가 갈린다).
- **`Vary: Origin`이 필수**다 — 없으면 CDN·브라우저 캐시가 한 오리진에 준 응답을 다른 오리진에도
  내주어 화이트리스트가 조용히 무의미해진다.
- CORS는 **브라우저만** 지킨다. curl이나 서버에서 부르는 요청에는 아무 영향이 없다. 여기서 막는 것은
  "남의 브라우저를 빌리는 것"이고, 그게 정확히 대입 분산과 CSRF성 조작의 전제다. 실제 권한은 `auth.ts`가 자른다.

### 10-2. 응답 헤더 (`vercel.json`)

| 헤더 | 값 | 목적 |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'` 기반. script/style/font는 `self` + `cdn.jsdelivr.net`, media는 `self` blob: `*.nmwc.ai.kr`, connect는 `self` + Supabase + `*.nmwc.ai.kr`, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'` | 비밀번호가 평문으로 상주하는 페이지라 **스크립트 유입 경로 자체**를 좁힌다 |
| `X-Frame-Options` | `DENY` | 클릭재킹 |
| `X-Content-Type-Options` | `nosniff` | MIME 추론 |
| `Referrer-Policy` | `no-referrer` | 외부로 경로 유출 방지 |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | 다운그레이드 방지 |

`script-src`에 `'unsafe-inline'`이 남아 있는 것은 이 페이지들이 인라인 스크립트 한 덩어리로 되어 있기 때문이다.
그래서 CSP만으로는 부족하고 아래 SRI가 함께 있어야 한다.

### 10-3. SRI

`admin.html`이 CDN에서 받는 스크립트 두 개에 `integrity="sha384-..."`를 박아 버전을 고정한다.
CDN이 사고를 당해 파일이 바뀌면 브라우저가 실행을 거부한다 — sessionStorage의 평문 비밀번호를
읽어갈 수 있는 것이 바로 그 스크립트들이다.

## 11. 의존성 · 관련 스펙

| 스펙 | 관계 |
| --- | --- |
| `spec_space_control` | 기기 목록·명령·손님 시간창. 이 스펙의 역할 판정 결과를 그대로 받는다 |
| `spec_cctv` | `camera_*` action은 admin 전용. 로그아웃 시 스트림·자격증명 폐기가 이 스펙 5-4의 계약 |
| `spec_payback_claim` | `reveal`(주민번호 복호화)이 어드민 비밀번호 뒤에 있다. 개인정보 수명주기는 그쪽이 정본 |
| `spec_support_apply` | 어드민 전용 action(`decide`·`mark_manual`)이 같은 비밀번호·같은 카운터를 쓴다 |
| `spec_cleaning_sms` | `CLEANING_TOKEN`·QR 경로와 `cleaner` 역할의 출처 |
| `spec_reservation_automation` | `automate`가 자격증명 없이 도는 유일한 action — 시도 제한 설계의 제약 조건 |

## 파일(페이지) 구성

| 파일 | 경로 | 설명 |
| --- | --- | --- |
| `auth.ts` | `supabase/functions/control/auth.ts` | 역할 판정·허용 범위·손님 응답 스크러빙. 이 함수의 유일한 인증 정책 |
| `auth.test.ts` | `supabase/functions/control/auth.test.ts` | 위 계약의 단위 테스트 |
| `throttle.ts` | `supabase/functions/_shared/throttle.ts` | 시도 제한 판정·기록·IP 추출. 세 함수 공용 |
| `throttle.test.ts` | `supabase/functions/_shared/throttle.test.ts` | 경계·fail-open·IP 우선순위 테스트 |
| `secret.ts` | `supabase/functions/_shared/secret.ts` | 상수 시간 문자열 비교 단일 구현 |
| `cors.ts` | `supabase/functions/_shared/cors.ts` | 허용 오리진 화이트리스트 |
| `index.ts` | `supabase/functions/control/index.ts` | 시도 제한 → 역할 판정 → 허용 범위 → action 분기 |
| `index.ts` | `supabase/functions/claim/index.ts` | 어드민 전용 action 앞의 `isAdmin` + 시도 제한 |
| `index.ts` | `supabase/functions/apply/index.ts` | 어드민 전용 action 앞의 `isAdmin` + 시도 제한 |
| `20260813100000_auth_throttle.sql` | `supabase/migrations/` | `auth_attempts` 테이블·인덱스·RLS·정리 크론 |
| `20260813110000_admin_secret.sql` | `supabase/migrations/` | `admin_secret` + `admin_check` + `admin_set_password` (도구만) |
| `20260813111000_admin_use_secret.sql` | `supabase/migrations/` | 인가 판정을 해시 검증으로 전환 + 롤백 게이트 |
| `20260813111100_admin_rpc_recover.sql` | `supabase/migrations/` | 라이브 전용이던 `admin_*` 다섯 회수 + 같은 게이트 |
| `admin.html` | `06-applications/admin.html` | 게이트 UI·세션·오류 분기(`tryUnlock`·`lock`·`isAuthError`) |
| `vercel.json` | 레포 루트 | CSP·HSTS 등 응답 헤더 |
| `control-setup.md` | `06-applications/control-setup.md` | M절 — 해시 전환·회전 절차 정본(이 스펙에 복사하지 않는다) |

## 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-14 | 최초 작성 — 라이브 코드·마이그레이션·`control-setup.md` M절에서 역기획 |
| 2026-08-14 | 의사결정 반영 — 네 번째 표면(PostgREST RPC)을 `admin_check` 안의 SQL 시도 제한으로 해소(`20260814150000`) · 게이트 입력칸 maxlength 64 · throttle 오류 분기(`isThrottleError`) 추가 |
