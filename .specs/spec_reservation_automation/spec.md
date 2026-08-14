# spec_reservation_automation

> 예약 시각에 맞춰 냉난방·조명을 스스로 준비하고 끄며, 사람이 없는 공간에서 벌어진 일(현장 조작·
> 유휴 가동·연결 끊김·자동화 자체의 정지)을 Mattermost로 알리는 무인 운영의 심장.
> pg_cron이 1분마다 찌르는 `automate` 액션 하나가 전부를 돌린다.

## 1. 개요

타입라운지는 상주 인력이 없다. 손님은 예약 시간에 혼자 들어와 혼자 나가고, 그 사이 기기를
켜고 끄는 사람이 아무도 없다. 이 스펙은 그 빈자리를 네 층으로 메운다.

| 층 | 무엇을 | 언제 | 모듈 |
|---|---|---|---|
| **예정된 전환** | 입실 준비(전원→냉방→26도 · 조명 나이트모드) · 퇴실 종료(전원 가능한 기기 전부 끄기) | 예약당 각 1회 | `automation/schedule.ts` |
| **지속 강제** | 퇴실 후 10분 스윕 · 이용 중 온도 하한(24도) | 창이 열린 동안 매 틱 | `automation/enforce.ts` |
| **관측·경보** | 유휴 가동 경보 · 현장 조작 추론 · 연결 끊김/복구 · 서브시스템 오류 | 매 틱 | `enforce.ts` · `observe.ts` · `connectivity.ts` · `events.ts` |
| **생존 감시** | 자동화 틱 자체의 정지 | 5분마다, Edge Function **밖**(pg_cron + SQL) | `automation/heartbeat.ts` + 마이그레이션 `20260813130000` |

핵심 성질 다섯:

1. **판단은 SQL이 아니라 TS가 한다.** pg_cron은 1분마다 `{"action":"automate"}`를 찌르기만
   하고, "지금 어떤 예약이 대상인가"는 `handlers/automation.ts`가 계산한다. 날짜+시각 산술을
   SQL과 TS로 나눠 두면 한쪽만 고쳐지는 순간 조용히 어긋난다(마이그레이션 `20260807000000` 주석).
2. **끄는 것과 알리는 것을 구분한다.** 예약 창 안에서는 끄고(스윕·하한), 예약이 없는 시간에는
   끄지 않고 알리기만 한다. 빈 시간에 사람이 일부러 켜둔 것(청소·예열·촬영 답사)까지 되돌리면
   자동화가 현장에 있는 사람과 싸우고, 1분마다 도는 쪽이 이긴다.
3. **조용한 실패를 금지한다.** 전환 만료·전환 실패·서브시스템 예외·연결 끊김·자동화 정지가
   전부 장부(`device_events`)나 워치독을 통해 채널로 나간다. 무인 공간에서 침묵은 정상이
   아니라 판별 불가다.
4. **모름(null)은 OFF가 아니다.** `power = null`을 `'OFF'`로 합치면 "꺼진 줄 알았는데 실제로는
   켜져 있는" 상황이 조용히 숨는다. 스윕은 `'ON'`인 것만 끄고, 현장 조작 판별은 null이 낀
   전이를 조작으로 세지 않는다.
5. **기기 명령은 문 하나로만 나간다.** 모든 명령이 `automation/dispatch.ts`의 `issue()`를 지나
   장부에 남는다. 우회해서 `handlers/command.ts`를 직접 부르면 그 변화를 다음 틱이 **현장 조작으로
   오탐**한다.

### 이 스펙이 하지 않는 것 (Non-Requirements)

| 안 하는 것 | 사유 |
|---|---|
| 기기 명령 자체의 구현(ThinQ·Tasmota 어댑터, 값 검증, 큐) | `spec_space_control`이 정본. 이 스펙은 "언제 무엇을 보낼지"만 정하고 발행은 `issue()`에 위임한다 |
| 손님 안내 문자 · 청소 담당자 문자 | 같은 `automate` 틱에 얹혀 있지만 설계 정본은 `spec_guest_sms` · `spec_cleaning_sms`다. 여기서는 "기기 제어와 격리해 실행한다"는 사실만 다룬다 |
| 예약 데이터의 유입 경로(스페이스클라우드 동기화) | `spec_reservation_sync` 정본. 이 스펙은 `reservations` 테이블을 읽기만 한다 |
| CCTV 영상·등록·화면 | `spec_cctv` 정본. 여기서는 카메라를 **연결 끊김 감시 대상**으로만 본다 |
| 유휴 상태의 자동 소등 | 의도적으로 안 한다(위 핵심 성질 2) |
| 자동화 설정 화면(온도·리드타임 조정 UI) | 정책 숫자는 코드 상수 하나에만 둔다. 화면을 만들 만큼의 변동이 없고, SQL과 TS에 숫자를 이중화하면 어긋난다 |
| 전환 실패의 자동 재시도 | 선점(`claimTransition`)이 표시를 먼저 찍으므로 재시도하지 않는다. 실패는 장부에 남겨 사람이 본다 |

## 기술 스택

프로젝트 공통(Supabase Edge Function `control` · Deno · supabase-js v2 from jsr · PostgreSQL)
+ 이 스펙 고유:

- **pg_cron** — `reservation-automation` 잡(`* * * * *`), `device-events-cleanup` 잡(`17 4 * * *`),
  `automation-heartbeat-watchdog` 잡(`*/5 * * * *`). 세 잡 모두 스키마를 지정하지 않고 만든다
  (pg_cron·pg_net은 relocatable이 아니라 `with schema extensions`를 붙이면 미설치 프로젝트에서
  생성 자체가 실패한다).
- **pg_net** — cron에서 Edge Function을 찌르는 HTTP(`timeout_milliseconds := 20000`)와, 워치독이
  Mattermost 웹훅을 직접 때리는 HTTP(`10000`). **비동기라 `cron.job_run_details`에는 응답 코드가
  남지 않는다** — 이 성질이 워치독을 Edge Function 밖에 둔 이유다.
- **Mattermost 인커밍 웹훅** — `MATTERMOST_DEVICE_WEBHOOK_URL ?? MATTERMOST_WEBHOOK_URL` 순서로
  고른다(`automation/notify.ts`). 워치독은 SQL이라 시크릿을 못 읽어, 같은 URL을 매 틱
  `automation_config`로 동기화해 쓴다.
- **ThinQ / Tasmota 상태 캐시** — 직접 부르지 않는다. `handlers/list.ts`가 주는 `device_state`
  캐시를 읽을 뿐이고, 갱신 주기만 이 스펙이 정한다(이용 중 30초 · 빈 시간 600초).

## 실행 환경

- Supabase Edge Function `control` (Deno Deploy). **런타임 타임존은 UTC다** — 예약은 KST 벽시계
  값이므로 모든 시각 계산은 `automation/windows.ts`가 명시 오프셋 `+09:00`으로 파싱한다. 개발
  맥(KST)에서는 오프셋을 빠뜨려도 우연히 맞게 나와 테스트로 안 잡힌다(실제로 한 번 틀렸다).
- pg_cron 1분 주기 → `POST /functions/v1/control` `{"action":"automate"}`.
  Authorization은 anon key다 — `admin.html`·`guest-control.html` 소스에 이미 공개된 값이라
  비밀이 아니다(마이그레이션 `20260807000000`에 인라인으로 들어 있고, 키를 회전하면 그 잡도
  같이 갱신해야 한다).
- 워치독은 Edge Function을 거치지 않는다 — Postgres 안에서 `do $watchdog$ ... $watchdog$`
  블록이 돌고 `net.http_post`로 직접 나간다.
- 배포: `supabase db push` → `supabase functions deploy control`. **마이그레이션이 먼저다** —
  하트비트 테이블은 `alerted_at`을 `now()`로 초기화해 약 55분의 배포 유예를 스스로 만든다.
- CI: `.github/workflows/test.yml`이 `supabase/**` 변경 시 `deno lint` · `deno check` ·
  `deno test --allow-env`를 돌린다. 이 스펙의 순수 판정 함수는 DB 없이 검증된다
  (`windows.test.ts` · `observe.test.ts` · `connectivity.test.ts` · `events.test.ts` · `message.test.ts`).

## 2. 접근 제어

`automate`는 **손님(비밀번호 미제출) 권한으로 열려 있는 세 action 중 하나다**
(`auth.ts`의 `GUEST_ACTIONS = {list, command, automate}`). 두 가지 예외가 겹쳐 있어, 둘 다
사고를 겪고 나서 명시적으로 고정된 결정이다.

### 2-1. 왜 guest 권한인가

pg_cron이 anon key만으로 부를 수 있어야 하기 때문이다. 대안은 전용 토큰을 pg_cron 잡에 심는
것인데, 그러면 시크릿이 마이그레이션(=git) 안으로 들어오거나 Vault를 도입해야 한다.

열어도 안전하다고 본 근거:

| 근거 | 내용 |
|---|---|
| 대상을 호출자가 못 고른다 | 요청 본문에 예약 id가 없다. 서버가 **지금 시각**으로 대상을 직접 계산한다 |
| 새로 열리는 제어 권한이 없다 | 손님 페이지가 이미 같은 조명·냉난방 명령을 비밀번호 없이 부를 수 있다(2026-08-04 정책) |
| 반복 호출이 벤더 부하가 안 된다 | ThinQ 상태에 TTL이 있어 호출을 늘려도 벤더 왕복이 비례해 늘지 않는다 |
| 중복 실행이 중복 결과가 안 된다 | 전환은 `claimTransition`, 알림은 `claimPending`으로 **선점 먼저, 실행 나중** |

⚠️ 그래도 `automate`는 `command`가 못 하는 일을 한다 — 외부 웹훅 발송, `device_events` ·
`device_watch` 쓰기, 무조건적인 `list()` 호출. 더 조이려면 이 목록에서 빼고 전용 토큰을 Vault에
둬야 한다(형운 결정, 2026-08-07: 위 두 방어로 충분하다고 봤다).

### 2-2. 예약 시간 게이트의 예외 (사고 2회의 근거)

손님 role은 `withinReservationWindow()`를 통과해야 한다 — "지금이 예약 구간 안인가"를 서버가
판정한다. **`automate`만 이 게이트를 건너뛴다**(`index.ts:107`).

> `if (role === "guest" && action !== "automate" && !(await withinReservationWindow(sb)))`

이유는 정의상 자명하다 — 자동화가 일해야 하는 순간은 전부 예약 구간 **밖**이다. 입실 15분 전
준비, 그보다 앞선 안내 문자, 퇴실 시각 전원 끄기, 퇴실 후 10분 스윕. 게이트를 통과하는
시간대에는 할 일이 없고, 할 일이 있는 시간대에는 통과를 못 한다.

| 사고 | 무슨 일이 있었나 |
|---|---|
| #44 (2026-08-09) | 게이트가 도입되면서 `automate`가 통째로 403을 받아 자동화가 죽었다. pg_net은 비동기라 pg_cron 실행은 **'성공'으로 기록**됐고, 채널에는 아무 말도 없었다 |
| #70 (2026-08-13) | 같은 침묵이 재현됐다 — 08-09부터 자동화가 죽어 있었던 것을 뒤늦게 발견하고 복구했다. 자정 넘김 시간창(`endTime`) 결함도 같이 잡았다 |

이 두 번이 **시도 제한(throttle)의 예외**와 **워치독의 존재 이유**를 동시에 낳았다.

- 시도 제한: 자격증명을 뭐라도 보낸 요청만 시도 제한을 탄다(`index.ts:71`). 아무것도 안 보낸
  요청은 손님이거나 pg_cron이고, 그걸 세면 1분마다 오는 자동화가 스스로 문을 잠근다.
- 워치독: 아래 4-8.

### 2-3. 테이블 접근

`device_events` · `device_watch` · `automation_heartbeat` · `automation_config`는 전부 **RLS를
켜되 정책을 하나도 두지 않는다** = anon·authenticated로는 읽기도 쓰기도 불가능하고, Edge
Function의 service_role만이 유일한 경로다. 장부는 "언제 누가 공간의 기기를 만졌는지"를 통째로
담고 있어 예약 정보만큼이나 새면 안 된다.

pg_cron 잡(정리·워치독)은 스케줄링 역할(테이블 소유자)로 돌아 RLS와 무관하게 읽고 쓴다.

## 3. 틱 파이프라인

순서 자체가 설계다. 각 단계가 왜 그 자리에 있는지가 아래 표에 있다.

```
pg_cron (1분)
   │  POST /control  {"action":"automate"}
   ▼
automate()  ── try ─────────────────────────────────────────────┐
   │                                                            │ catch:
   │  1. fetchRecent()          어제~내일 KST · cancelled=false  │  system_error(automate_failed)
   │  2. 전환 루프              예약별 입실 준비 / 퇴실 종료      │  → 그 자리에서 flush()
   │        └ claimTransition() 선점 먼저, 실행 나중             │  → 다시 던진다
   │                                                            │
   │  ┌─ 전환이 이번 틱에 일어났으면 3~5를 건너뛴다 ─┐          │
   │  3. detectOnsite()         현장 조작 추론 (관측이 먼저)     │
   │  4. 창 판정 (택일)                                          │
   │       isSweeping  → sweepIdleDevices()                     │
   │       isOccupied  → enforceTempFloor()                     │
   │       그 외        → alertIdleDevices()                     │
   │  └────────────────────────────────────────────┘            │
   │  5. checkConnectivity()    항상 돈다 (기기 + 카메라)        │
   │  6. sweepSms()             손님 문자   (격리 · spec_guest_sms)
   │  7. sweepCleaning()        청소 안내   (격리 · spec_cleaning_sms)
   │  8. flush()                알림 발송 (선점 → 발송 → 실패 시 해제)
   │  9. recordHeartbeat()      정상 종료 직전에만
   │ 10. syncWatchdogWebhook()  시크릿 → automation_config
   ▼
요약 JSON 반환
```

| 순서 결정 | 이유 |
|---|---|
| 전환이 일어난 틱은 관측·강제를 건너뛴다 | 방금 보낸 명령이 상태 캐시에 반영되기 전이라(조명은 아직 큐에도 안 나갔다), 지금 읽은 상태로 판단하면 방금 켠 것을 도로 끄거나 방금 맞춘 26도를 낮은 값으로 오인한다 |
| 관측(`detectOnsite`)이 강제보다 먼저 | 강제가 먼저 돌면 그것이 만든 변화까지 현장 조작 후보로 잡힌다 |
| 관측은 절대 예외를 던지지 않는다 | 관측은 알림용 부가 기능이고 그 아래 스윕·하한은 **제어 안전장치**다. 관측이 던지면 그 틱의 냉난방이 안 꺼진다 — 새 관심사가 기존 안전장치를 인질로 잡으면 안 된다 |
| 연결 점검은 창 판정 밖에서 항상 | 이용 중에 CCTV가 끊기는 것이 가장 비싼 경우인데, 그건 `isOccupied` 분기라 빈 시간 전용 경보로는 못 잡는다 |
| 문자·청소는 각각 try/catch로 격리 | 입실 준비가 실패했다고 손님에게 길 안내를 안 보낼 이유가 없고, 그 반대도 마찬가지다. 셋이 **같은 `reservations` 배열**을 쓰는 것이 중요하다 — 따로 조회하면 세 판정이 서로 다른 예약 목록을 본다 |
| 하트비트는 정상 종료 직전 | 앞에서 던졌으면 갱신되지 않고 낡아, 게이트 밖의 워치독이 정지를 알아차린다. 그게 이 설계의 목적이다 |
| 최상위 try/catch가 틱 전체를 감싼다 | 서브시스템 격리는 이미 잡히는 예외만 막는다. `fetchRecent`·`list()`·`claimTransition`처럼 그 밖에서 새면 `automate`가 그대로 500을 내고 끝나는데, pg_net이 비동기라 cron 로그엔 '성공'만 남는다(#70). 원인을 장부에 남기고 **그 자리에서 보내본 다음** 다시 던진다 — '다음 틱의 flush가 보낸다'는 초입이 지속 실패하면 영원히 도달하지 못하는 줄이다 |

### 상태 신선도 (ThinQ 호출 절약)

| 상황 | ThinQ 재조회 기준 | 근거 |
|---|---|---|
| 이용 중 또는 스윕 중 | 매 틱 신선하게(`undefined` → 기본 30초 TTL) | 판단이 상태에 걸려 있다 |
| 그 외(빈 시간) | 600초까지 묵힌 값 그대로 | 호출을 1/10로 줄인다. 이 레포는 PAT 401을 재시도조차 못 하게 막아둘 만큼 ThinQ 인증이 약해 부하를 늘리는 게 공짜가 아니다(형운 결정, 2026-08-07) |

조명(Tasmota)은 MQTT push라 이 값과 무관하게 항상 최신이다.

## 4. 규칙별 상세

### 4-1. 입실 준비 · 퇴실 종료 (예정된 전환)

| 항목 | 입실 준비 | 퇴실 종료 |
|---|---|---|
| 실행 시각 | 입실 15분 전(`prepTime`) | 퇴실 시각(`endTime`) |
| 만료 경계 | **입실 시각** + 10분 (`checkinDueState`) | 퇴실 시각 + 10분 (`dueState`) |
| 표시 컬럼 | `reservations.checkin_automation_at` | `reservations.checkout_automation_at` |
| 명령 | 냉난방: `power_on` → `set_mode COOL` → `set_temp 26` / 조명: SiHAS는 `power_off`, 그 외는 `power_on` | `capabilities`에 `power`가 있는 기기 전부 `power_off` |

**냉난방은 한 기기 안에서 반드시 순차다.** 모드를 바꾸면 목표온도가 기기 기본값으로 되돌아가는
기종이 있어, 온도를 모드보다 먼저(또는 동시에) 보내면 26도가 조용히 지워진다. 기기끼리는 병렬
(`Promise.allSettled`)이라 일부 실패가 나머지를 막지 않는다.

**준비 온도 26도는 하한 24도보다 높아야 한다.** 낮게 잡으면 준비하자마자 하한 강제가 되돌려
두 자동화가 서로 싸운다. 냉방 모드가 기기 프로파일에 없으면 조용히 넘기지 않고 `console.error`로
남긴다 — 실기기 등록이 잘못됐거나 기기가 바뀐 것이고, 사람이 봐야 한다.

**조명 나이트모드의 SiHAS 반전**은 이름에 `sihas`가 들어가는지로 판별한다(DB에는 `kind='light'`만
있고 벤더 구분이 없다). `admin.html`·`guest-control.html`과 같은 표식이라 **세 곳 중 하나만 바꾸면
나이트모드가 서로 다르게 동작한다.**

#### 선점 먼저, 실행 나중

```
runTransition(r, state, column, fire)
  state === "wait"                    → 아무것도 안 함
  claimTransition(...) === false       → 다른 호출이 이미 가져갔다 (또는 이미 실행됨)
  state === "expired"                  → 실행하지 않고 device_events(status='failed')로 남긴다
  fire() 성공                          → 카운트
  fire() 예외                          → device_events(status='failed', detail=원인)
```

- 예전 순서(`확인 → 실행 → 표시`)는 두 호출이 나란히 확인을 통과해 **입실 준비를 두 번 쏠 수
  있었다.** `is(column, null)` 조건이 붙은 update는 행 단위로 원자적이라 경쟁하는 쪽 중 하나만
  행을 돌려받는다.
- 대가는 실행에 실패해도 재시도하지 않는다는 것이다. 예전에도 실패 시 표시했으므로 새로 잃은
  것은 없고, 대신 그 실패가 조용하지 않도록 장부에 남긴다.
- **이 실패 기록만 `device_id`가 null이다.** 전환이 시작조차 못 한 것은 특정 기기의 일이 아니고,
  기기를 하나 골라 적으면 거짓이다(알림에는 '공간 전체'로 렌더된다).

#### 입실만 만료 경계가 다른 이유

준비는 입실 15분 전에 돌지만 만료는 **입실 시각** 기준으로 잰다. 당일 즉시 예약이 '입실 5분
전~직후'에 처음 동기화되면 준비 시각은 이미 지났는데, prep 시각 기준 10분 캐치업으로 판정하면
곧바로 `expired`가 되어 준비가 통째로 스킵되고 채널엔 장애처럼 읽히는 실패만 남는다(입실 전인데도).
입실 시각까지 넘겼으면 손님이 이미 이용 중이라 뒤늦은 준비가 손님이 맞춰둔 값과 싸우므로 그때는
`expired`가 맞다.

#### 자정을 넘기는 예약 (#70)

예약 행은 날짜 하나에 시각 둘을 들고 있어서 `18:00~00:00`을 그대로 읽으면 종료가 시작보다
**이르게** 나온다. `endTime()`이 `end <= start`면 하루를 더한다. 2026-08-08 실측:

- 8/23 **00:00**(시작 18시간 전)에 퇴실 종료가 돌아 표시가 찍히고 → 진짜 퇴실(8/24 00:00)엔
  '이미 했다'고 보고 **아무것도 안 꺼졌다.** 냉난방이 밤새 돌았다.
- 문자도 같이 어긋나 "퇴실 15분 남았어요"가 **하루 전날 23:45**에 나갔다.

이 판정이 `windows.ts`에 있어야 하는 이유는 기기 자동화·문자·청소·손님 페이지 게이트가 **같은
함수를 봐야** 서로 어긋나지 않기 때문이다(손님 게이트는 이 통합 전까지 SQL로 따로 판정해
2026-08-11에 예약 내내 안 열린 사고가 있었다).

### 4-2. 퇴실 후 스윕

퇴실 후 10분 동안, **켜져 있는(`power === 'ON'`)** 기기를 매 틱 다시 끈다.

| 규칙 | 내용 |
|---|---|
| 대상 | `capabilities`에 `power`가 있고 상태가 `'ON'`인 기기. `null`('모름')은 건드리지 않는다 — 상태를 한 번도 못 받은 기기에 10분 내내 명령을 쏘면 조명 큐만 쌓인다 |
| 중단 조건 | `isOccupied`가 true면 스윕 자체가 돌지 않는다. 다음 예약의 **준비 시각**(입실 15분 전)이 지났으면 그 예약을 위해 켠 기기이므로 꺼선 안 된다 |
| 명령 | 매 틱 계속 보낸다 |
| 알림 | 창당 기기별 **한 번만**. 기기가 응답하지 않아 상태가 계속 'ON'이면 10분 내내 매 분 알림이 가는데, 하필 그때가 채널이 조용해야 할 때다. 멈추는 건 명령이 아니라 알림이다(`issue(..., {silent})`) |
| 잔존 경고 | 창의 마지막 틱(경과 9분 이상)에도 켜져 있으면 `status='failed'`로 기록해 채널에 경고를 띄운다. 조명 명령은 큐에 넣기만 하므로 성공 응답이 곧 소등이 아니다 — 이 신호가 없으면 에이전트가 죽어 조명이 밤새 켜져 있어도 채널엔 '퇴실 종료 성공'만 남는다 |
| 창 시작 기준 | 겹친 예약이 둘 이상 끝나 있으면 **가장 이른 퇴실**을 창의 시작으로 본다(`Math.max`의 경과 분). 늦은 쪽을 잡으면 '이미 알렸나' 조회 범위가 실제 스윕 시작보다 짧아져 같은 기기를 다시 알린다 |

**'이미 알렸나'의 판단 근거는 장부다.** 예전엔 `device_watch`의 직전 관측값을 썼는데, 전환이
일어난 틱은 관측을 건너뛰므로 퇴실 종료 직후 기준선이 낡은 채로 남아 **스윕 알림이 한 건도
안 나갔다**(2026-08-08 실측 — 스윕은 동작했는데 채널에만 안 떴다). 장부는 낡지 않는다.

### 4-3. 온도 하한 (24도)

이용 중일 때만 돈다(빈 시간의 냉난방은 스윕이 어차피 끈다).

```
floorApplies(power, mode, target) =
     power === 'ON'
  && Number.isFinite(target) && target < 24
  && typeof mode === 'string' && mode ∈ {COOL, AIR_DRY, AUTO}
```

모드 집합의 기준은 이름이 아니라 **압축기를 돌려 실내를 목표온도까지 내리는가**다. 제습
(`AIR_DRY`)이 여기 든 것은 그래서다 — 이 기기의 모드 목록엔 `AUTO`가 없어 제습이 '낮은
온도로 오래 트는' 유일한 다른 경로이고, 이름만 제습일 뿐 과냉방은 그대로 일어난다
(형운 결정, 2026-08-15). `HEAT`·`FAN`·`AIR_CLEAN`은 24도를 밀어봐야 난방이 세지거나
아무 일도 일어나지 않는다.

| 규칙 | 내용 |
|---|---|
| 시계 시작 | 조건 성립 첫 틱에 `device_watch.below_since`를 지금으로 찍는다. **이미 돌고 있으면 덮지 않는다** — 덮으면 5분이 영원히 다시 시작된다 |
| 유예 | 5분. "잠깐 세게 트는 것" 자체는 막지 않는다 |
| 해제 | 조건이 깨지거나(정상 온도 복귀·전원 OFF·모드 변경) 되돌리기에 성공하면 `below_since = null`. **행을 지우지 않는다** — 같은 행에 관측 기준선이 들어 있어, 지우면 다음 틱이 기준선을 잃고 모든 변화를 현장 조작으로 오인한다 |
| 비교 | `< 24`. 정확히 24도면 되돌릴 것이 없고, `<=`로 두면 매 틱 같은 값을 다시 쓰는 명령이 나간다 |
| 실패 시 | 해제가 아니라 **5분 백오프**(`startTempFloor(..., {force:true})`로 시계를 지금으로 민다). 그대로 두면 다음 틱에도 5분이 지난 상태라 매 분 재시도·매 분 실패 알림이 나간다 — 만료된 PAT 하나가 3시간 예약에 실패 175건을 남긴 사고가 근거다. 스윕은 10분 창으로 유계인데 여기는 상한이 없었다 |

**HEAT에 하한을 밀지 않는 것이 핵심 판단이다.** 하한 24도의 동기는 과냉방 방지인데, HEAT 20도로
둔 손님에게 24도를 밀면 난방을 더 세게 만들어 목적과 정반대가 된다(에너지도 더 쓴다).
**모드를 모르면 아예 강제하지 않는다** — HEAT를 잘못 미는 위험이 과냉방을 한 틱 놓치는 것보다 크다.

### 4-4. 유휴 경보 (끄지 않고 알린다)

예약도 스윕 창도 아닌 시간 — **끄는 규칙이 하나도 안 도는 구간**이다. 여기서만 유휴 경보가 돈다.

기기를 끄는 길이 둘뿐이었고 **둘 다 살아있는 예약 행에 매달려** 있었다:

| 상황 | 왜 아무도 안 끄나 |
|---|---|
| 이용 중 취소·삭제 | `fetchRecent`의 `cancelled = false`에서 빠져 대상 자체가 없어진다 |
| 함수가 10분 넘게 죽음 | 종료도 스윕도 `expired`로 지나간다 |
| 빈 시간에 사람이 그냥 켬 | 애초에 어떤 창에도 안 걸린다 |

셋 다 냉난방이 밤새 도는 결과가 같은데 채널엔 한 줄도 안 떴다.

| 규칙 | 내용 |
|---|---|
| 동작 | 끄지 않는다. `kind='idle'` 이벤트만 남긴다 |
| 재알림 간격 | 기기별 60분 |
| 사람 면제 | 최근 60분 안에 `remote_admin` · `remote_guest`가 있던 기기는 건너뛴다 — 방금 눌렀다면 켜져 있는 것은 사고가 아니라 의도다 |
| **현장 조작은 면제 목록에 넣지 않는다** | 처음엔 넣었다가 바로 뺐다. `onsite`는 관측이 아니라 **잔여 추론**이고, 하필 "아무도 없는데 켜져 있다"의 가장 흔한 원인(재연결·복전·벤더 글리치)이 거기로 분류된다. 그걸 면제로 쓰면 **경보가 존재하는 바로 그 상황을 경보가 스스로 막는다.** 2026-08-08 11:34 실측이 정확히 그랬다 — 바닥 조명 두 대가 끊겼다 돌아오며 `onsite`로 잡혔고, 그 이벤트가 같은 기기의 유휴 경보를 1시간 먹었다 |
| 표기 | 상태 갱신이 끊긴 기기는 `"켜짐 (상태 갱신 끊김)"`으로 구분해 적는다 — '마지막으로 들은 게 ON이고 그 뒤로 연락이 끊겼다'와 '지금 켜져 있다'는 다른 문장이고, 사람이 할 일도 다르다 |

### 4-5. 현장 조작 추론

벽 스위치와 에어컨 리모컨은 우리 API를 거치지 않아 직접 볼 방법이 없다. 그래서 이렇게 뺀다:

```
관측된 상태 변화  −  최근 우리가 보낸 명령(장부)  =  현장 조작
```

즉 이 판정은 관측이 아니라 **추론이고 잔여 범주**다. 장부가 비거나 늦으면 우리가 켠 것을
"현장에서 누가 켰다"고 알리게 된다.

#### 판정을 통과해야 하는 문 다섯

| # | 문 | 통과 못 하면 |
|---|---|---|
| 1 | 기준선이 있는가(`prev.seenAt`) | 처음 보는 기기는 변화로 안 친다 — 없으면 배포 직후 모든 기기가 "현장에서 조작됐다"고 나간다 |
| 2 | 상태를 한 번이라도 받았는가(`never_seen === false`) | '모름'끼리 비교하게 된다 |
| 3 | 관측 공백이 아닌가(`isContactGap`) | 기준선과 이번 판독값 사이가 1200초를 넘으면 그 사이의 변화는 '사람이 만졌다'가 아니라 **'우리가 못 봤다'**이다. 조작으로 치지 않고 **기준선만 갱신한다** |
| 4 | null이 낀 전이가 아닌가 | ThinQ가 200을 주면서 payload만 이상해도 power가 null이 된다. 그걸 조작으로 알리면 손님이 아무것도 안 했는데 '켜짐 → 모름', 다음 틱에 '모름 → 켜짐' 두 건이 나간다 |
| 5 | 우리 명령으로 설명되지 않는가(`explains`) | 설명되면 조작이 아니다. **축(power/temp/mode/wind)까지 좁혀 대조한다** — 기기 단위로 두면 우리가 `set_temp`를 보낸 직후 손님이 리모컨으로 전원을 꺼도 "설명됨"으로 삼켜지고 기준선까지 갱신돼 그 사건은 영영 안 잡힌다 |

#### 대조 창 (오탐의 급소)

창은 **기기별로 "마지막으로 기준선을 뜬 시각(`seen_at`) 이후"**이고, `CORRELATION_FLOOR_MS`
(120초)가 그 창이 그보다 짧아지지 않게 막는 바닥이다.

- **고정 120초 창을 버린 것이 이 파일에서 가장 중요한 수정이다.** 빈 시간엔 ThinQ 상태를
  600초에 한 번만 물어보는데 창이 120초 고정이면 **우리가 보낸 명령은 항상 창 밖으로 나간다** —
  빈 시간에 사람이 원격으로 누른 것이 몇 분 뒤 '현장 조작'으로 뜬다.
- 바닥을 남기는 이유: 명령 직후의 상태 읽기가 벤더 반영보다 빠를 수 있어(조명 큐 TTL 60초,
  ThinQ도 control 직후 재조회가 옛 값을 주는 일이 있다) 명령이 기준선보다 조금 앞선 시각에 찍힐
  수 있다.
- 조회는 모든 기기 중 **가장 이른 창 시작**으로 한 번만 하고, 대조는 기기별 시작으로 다시
  좁힌다 — 한 기기의 오래된 기준선이 다른 기기의 창까지 넓히면 남의 명령이 이 변화를 설명해버린다.
- 설명으로 인정하는 것은 `COMMAND_KINDS` **화이트리스트**(prep · shutdown · sweep · temp_floor ·
  remote_admin · remote_guest)이고, `status='ok'`인 것만이다. 실패한 명령은 기기를 바꾸지
  못했으므로 어떤 변화도 설명할 수 없다 — 빼지 않으면 PAT 만료 중 쌓인 실패 기록이 그 기기를
  영원히 '설명됨'으로 만들어 진짜 현장 조작이 한 건도 안 잡힌다.

#### 기준선 갱신 (`seen_at`은 틱 시각이 아니다)

**벤더가 그 판독값을 준 시각**(`device_state.updated_at`)을 기록한다. 틱 시각을 쓰면 창이 항상
1분짜리로 좁아져 고정 120초와 똑같아진다 — 2026-08-08 배포 직후 실측에서 6대의 `seen_at`이
전부 직전 틱 시각이었고, 그래서 창을 넓힌 수정이 사실상 무용지물이었다.

`power`와 `temp`가 둘 다 null인 틱은 **아무것도 쓰지 않는다**(기준선도 그 시각도 안 바뀌었으니까).
null로 기준선을 덮지도 않는다 — 판정이 `prev.lastPower !== null`을 요구하므로 이상 응답 한 번이
기준선을 null로 만들면 **그다음 진짜 변화 한 건이 통째로 먹힌다.**

#### 알림에 조작 시각을 쓰지 않는 이유

**언제 일어났는지는 모른다 — 언제 알아챘는지만 안다.** 빈 시간엔 관측이 10분에 한 번이라 실제
조작보다 한참 뒤일 수 있다. 그래서 `detail`에 기준선 판독 시각을 함께 남겨 표에 '08:37~08:47
사이'로 찍는다. 2026-08-08의 '꺼짐 → 켜짐 (08:47)'이 방향이 뒤집힌 것 아니냐는 의심을 받았는데,
방향은 기준선과 판독값 그대로였고 08:47이 조작 시각이 아니라 **관측 시각**이었던 게 원인이었다.

### 4-6. 연결 끊김 · 복구

새로 관찰하지 않는다 — 이미 쌓이는 상태 캐시(`device_state.online`/`is_stale`,
`camera_state.online`/`is_stale`)를 매 틱 읽어 **전환**만 장부에 남긴다.

| 대상 | down 판정 | 원인 문구 |
|---|---|---|
| 조명·냉난방 | `!online || is_stale`(600초) | ThinQ 실패 원인이 있으면 그것(401 만료 / 400 거부 / 응답 없음), 없으면 오프라인 보고·갱신 끊김 |
| CCTV | `!online || is_stale`(180초) | MediaMTX 미연결 / 에이전트 보고 끊김 |

```
decideTransition(down, latest, recentOfflineCount)
  down && (latest 없음 | latest.kind === recovered)   → 새 끊김
        └ recentOfflineCount >= 4 이면 "none"(플래핑 억제)
        └ 아니면 "offline" (첫 끊김은 언제나 즉시)
  down && latest.kind === offline                      → 60분 지났으면 "offline", 아니면 "none"
  !down && latest.kind === offline                     → "recovered"
  !down && 그 외                                        → "none"
```

| 판단 | 이유 |
|---|---|
| 집합이 아니라 **대상별 최신 이벤트 하나**를 본다 | 끊김→복구→끊김이 짧은 창에서 반복되면 두 kind 집합에 같은 기기가 동시에 들어가, 소속만으로는 두 번째 끊김을 알려야 하는지 알 수 없다 |
| `never_seen`은 게이트에서 먼저 뺀다 | 한 번도 보고를 못 받은 기기는 '끊김'이 아니라 '모름'이다. 섞으면 최초 등록 직후부터 경보가 뜬다 — '설치 전'과 '죽음'을 구분한다 |
| 플래핑 상한 4회/60분 | ThinQ는 폴링 1회 실패로도 down이 되고, 조명은 재연결 지연 이력이 있다(공유기 신규 TCP 블랙홀, 2026-08-09 판별). 진짜 장기 장애는 전환이 드물어(첫 끊김 + 60분마다 1건) 상한에 닿지 않으므로 상한은 플래핑만 자른다 |
| 트레이드오프 | 플래핑이 상한에 걸린 뒤 진짜 장기 장애로 굳으면 옛 끊김이 창에서 빠질 때까지(최대 60분) 재알림이 늦는다 — 첫 끊김 즉시성을 지키는 대가다 |
| 조회 실패는 빈 Map | **알리는 쪽으로 기운다.** 중복 알림은 시끄러울 뿐이지만 놓친 끊김은 아무도 모르게 만든다 |

### 4-7. 서브시스템 오류 (system_error)

`automate`가 삼키던 예외를 장부에 남긴다. action이 곧 서브시스템 이름이다:
`automate_failed` · `observe_failed` · `connectivity_failed` · `sms_sweep_failed` ·
`cleaning_sweep_failed` · `notify_flush_failed`.

**같은 action의 오류가 15분 창 안에 이미 있으면 원인 문구와 무관하게 조용히 넘어간다.**
원인 문자열이 같을 때만 억제하는 방식은 "다른 문제면 즉시 알린다"는 장점처럼 보였지만, 벤더 에러
메시지에 요청 ID·소요 시간처럼 매번 바뀌는 값이 섞이면 문자열이 절대 같아지지 않아 **매 틱
알리는 최악의 경우**로 조용히 퇴화한다.

### 4-8. 하트비트 워치독 (생존 감시)

**감시 주체가 automate와 같은 실행 경로에 있으면, 그 경로가 통째로 죽는 실패 모드를 원리상
못 본다.** #44·#70에서 게이트가 `automate` 진입 전에 403을 반환해 장부에 아무것도 안 남았고,
pg_net이 비동기라 `cron.job_run_details`엔 '성공'만 남았다.

```
automate 정상 완주 ──▶ automation_heartbeat.beat_at = now, alerted_at = null   (재무장)

pg_cron '*/5 * * * *'  (Edge Function 밖 · 순수 SQL)
  ├ automation_config['heartbeat_webhook_url'] 없거나 빈 값 → 조용히 종료
  ├ beat_at이 10분 이내로 신선            → 종료
  ├ alerted_at이 55분 이내                → 종료 (재알림 억제)
  └ net.http_post(웹훅) → alerted_at = now
```

| 판단 | 이유 |
|---|---|
| 10분 낡음 기준 | 1분 틱이 10회 이상 미실행 = 확실한 정지 |
| 55분 억제 | 며칠 이어지는 정지에서 5분마다 알리면 주말에 수백 건이 쌓인다. 정상 완주가 `alerted_at`을 null로 되돌려 **회복 후 재정지는 즉시** 알린다 |
| 웹훅 URL을 매 틱 시크릿→DB 동기화 | SQL은 Edge Function 시크릿을 못 읽는다. 사람이 손으로 넣으면 (1) 평문 URL이 SQL 편집기 기록에 남고 (2) 나중에 웹훅을 교체하면 두 곳이 조용히 어긋나 **정작 알림이 필요한 날 아무 데도 안 간다** |
| 시크릿이 비면 아무것도 쓰지 않는다 | 빈 값을 넣으면 워치독이 '설정됨'으로 보고 빈 주소로 POST를 시도한다. 설정 안 된 상태는 조용해야지 오작동이면 안 된다 |
| 하트비트 기록 실패는 던지지 않는다 | 이미 끝난 자동화를 실패로 만들지 않는다. 다만 지속 실패하면 워치독이 오탐하므로 로그에는 반드시 남긴다 |

### 4-9. 알림 발송 (선점)

장부의 미발송분(`notified_at is null`)을 종류별로 묶어 Mattermost로 보낸다.

| 규칙 | 내용 |
|---|---|
| **선점 먼저, 발송 나중** | `claimPending`이 `notified_at`을 먼저 찍고 실제로 찍힌 행만 돌려준다. `automate`는 누구나 부를 수 있어 두 호출이 겹치면 같은 알림이 두 번 가는데, `is('notified_at', null)` 조건이 붙은 update는 행 단위로 원자적이라 하나만 가져간다. 대가는 발송 중 함수가 죽으면 그 이벤트가 유실된다는 것 — 중복을 막는 대신 아주 드문 유실을 받아들였다(형운 결정, 2026-08-07) |
| 정렬 | `at` 오름차순, 같으면 `id`. `update ... returning`의 행 순서는 정의돼 있지 않은데 메시지 조립이 거의 전부 순서에 매달려 있다. `recordMany`는 한 statement라 `at`이 전부 같아 `id`가 곧 일어난 순서다 |
| 발송 순서 | **일어난 순서대로.** 채널은 우선순위 목록이 아니라 타임라인이다 — 손님이 조명을 켜고(00:59:41) 스윕이 끈 것(01:00:01)이 위에 올라온 적이 있다(2026-08-08 지적). 급한 것은 순서가 아니라 제목의 경고 표시가 드러낸다 |
| 앞이 밀리면 뒤도 미룬다 | 먼저 일어난 묶음이 재시도로 넘어갔는데 나중 묶음만 나가면 다음 틱에 그게 뒤늦게 붙어 시간이 거꾸로 흐른다 |
| 실패 분류 | 400만 버린다('이 메시지가 잘못됐다' = 다시 보내도 같다). 401·403·404는 **설정 오류**라 사람이 고치면 되살아나므로 되돌린다. 4xx 전체로 넓히면 웹훅 주소 하나 잘못 넣었을 때 모든 알림이 조용히 사라진다 |
| 웹훅 미설정 | `sent`로 본다(=소진). 안 한 것은 '나중에 보낼 것'이 아니라 '안 보내기로 한 것'이다. 되돌리면 미발송이 영원히 쌓인다 |
| 상한 | 한 번에 200건, 메시지 3500자(Mattermost 기본 4000자). 넘으면 자르되 잘린 사실을 숨기지 않는다 |
| 타임아웃 | 10초. 웹훅이 에러가 아니라 **응답 없이 매달리면** 선점만 찍힌 채 무기한 블록되고, 런타임이 함수를 죽이면 해제가 못 돌아 그 이벤트는 '알림됨'으로 표시된 채 발송되지 않는다 |

## 5. 수치 상수

정책 숫자는 **코드 한 곳에만** 둔다. SQL과 TS 양쪽에 두면 한쪽만 고쳐지는 순간 조용히 어긋난다
(마이그레이션 `20260807010000` 주석).

| 값 | 상수 | 위치 | 의미 |
|---|---|---|---|
| 1분 | cron `* * * * *` | `20260807000000` | automate 틱 주기 |
| 20초 | `timeout_milliseconds` | `20260807000000` | pg_net → Edge Function 호출 상한 |
| 15분 | `PREP_LEAD_MINUTES` | `windows.ts` | 입실 준비 리드타임 |
| 10분 | `CATCHUP_WINDOW_MINUTES` | `windows.ts` | 전환 캐치업 창(넘기면 `expired`) |
| 10분 | `SWEEP_WINDOW_MINUTES` | `windows.ts` | 퇴실 후 스윕 창 |
| 9분 | `SWEEP_LAST_TICK_MINUTES` | `enforce.ts` | 창의 마지막 틱(= 스윕 창 − 1). 잔존 경고 1회 |
| 26도 | `PREP_TEMP` | `schedule.ts` | 입실 준비 목표온도 (하한보다 높아야 한다) |
| COOL | `PREP_MODE` | `schedule.ts` | 준비 모드(형운 지시, 2026-08-07) |
| 24도 | `TEMP_FLOOR` | `enforce.ts` | 온도 하한 |
| 5분 | `TEMP_GRACE_MINUTES` | `enforce.ts` | 하한 미만 가동 유예 |
| 5분 | (같은 값 재사용) | `enforce.ts` → `startTempFloor({force:true})` | 하한 강제 실패 시 백오프 |
| COOL·AIR_DRY·AUTO | `FLOOR_MODES` | `enforce.ts` | 하한을 거는 모드(압축기가 도는 것들). HEAT·FAN·AIR_CLEAN·모드 미상은 제외 |
| 60분 | `IDLE_ALERT_QUIET_MINUTES` | `enforce.ts` | 유휴 경보 재알림 간격 |
| 60분 | `IDLE_HUMAN_GRACE_MINUTES` | `enforce.ts` | 최근 원격 조작 기기의 유휴 경보 면제 |
| 600초 | `IDLE_THINQ_MAX_AGE_SECONDS` | `handlers/automation.ts` | 빈 시간의 ThinQ 재조회 기준 |
| 600초 | `STALE_AFTER_SECONDS` | `types.ts` | 기기 상태 '갱신 끊김' 판정 |
| 180초 | `CAMERA_STALE_AFTER_SECONDS` | `cameras.ts` | 카메라 보고 '끊김' 판정 |
| 120초 | `CORRELATION_FLOOR_MS` | `observe.ts` | 명령 대조 창의 **하한**(창 자체는 `seen_at` 이후) |
| 1200초 | `CONTACT_GAP_MS` | `observe.ts` | 이보다 긴 관측 공백은 조작이 아니라 단절(= 2 × `STALE_AFTER_SECONDS`) |
| 60분 | `REPEAT_MINUTES` | `connectivity.ts` | 같은 끊김의 재알림 간격 |
| 60분 / 4회 | `FLAP_WINDOW_MINUTES` / `FLAP_CAP` | `connectivity.ts` | 플래핑 억제 창과 상한 |
| 24시간 | `LOOKBACK_HOURS` | `connectivity.ts` | 최신 전환 조회 범위 |
| 15분 | `SYSTEM_ERROR_BACKOFF_MINUTES` | `events.ts` | 같은 서브시스템 오류 재알림 억제 |
| 200건 | `PENDING_LIMIT` | `events.ts` | 한 틱에 선점할 미발송 상한 |
| 3500자 | `MAX_CHARS` | `message.ts` | 메시지 길이 상한(Mattermost 기본 4000) |
| 10초 | `POST_TIMEOUT_MS` | `notify.ts` | 웹훅 왕복 상한 |
| 5분 | cron `*/5 * * * *` | `20260813130000` | 워치독 주기 |
| 10분 | `interval '10 minutes'` | `20260813130000` | 하트비트 낡음 판정 |
| 55분 | `interval '55 minutes'` | `20260813130000` | 워치독 재알림 억제 |
| 30일 / 7일 | `device-events-cleanup` | `20260807120000` | 발송 완료분 / 미발송분 보관 |

## 6. 데이터 모델

실제 SQL(마이그레이션)에서 파생한 타입이다.

```typescript
// ── 장부: device_events (20260807120000 · 20260808000000 · 20260812130000)
type EventKind =
  | "prep"              // 입실 준비 (자동)
  | "shutdown"          // 퇴실 종료 (자동)
  | "sweep"             // 퇴실 후 정리 (자동)
  | "temp_floor"        // 온도 하한 강제 (자동)
  | "remote_admin"      // 어드민이 원격에서
  | "remote_guest"      // 손님이 /control에서
  | "onsite"            // 현장 조작 (추론)
  | "idle"              // 예약 없이 켜져 있음 (관측만 — 끄지 않는다)
  | "device_offline"    // 조명·냉난방 연결 끊김
  | "device_recovered"  // 조명·냉난방 연결 복구
  | "camera_offline"    // CCTV 연결 끊김
  | "camera_recovered"  // CCTV 연결 복구
  | "system_error";     // automate 서브시스템 실패

/** 현장 조작 대조가 '설명'으로 인정하는 종류. 제외 목록이 아니라 화이트리스트다 —
 *  새 kind가 생길 때 반드시 한 번 판단을 거치게 만든다. */
const COMMAND_KINDS: EventKind[] = [
  "prep", "shutdown", "sweep", "temp_floor", "remote_admin", "remote_guest",
];

interface DeviceEvent {
  id: number;                 // bigserial
  device_id: string | null;   // uuid FK devices(id) on delete cascade
  camera_id: string | null;   // uuid FK cameras(id) on delete cascade — device_id와 배타
  at: string;                 // timestamptz default now()
  kind: EventKind;
  action: string;             // 'power_on' | 'set_temp' | 'observed' | 'connectivity' | 서브시스템명
  value: string | null;       // 온도·모드 값, 또는 '전원 꺼짐 → 켜짐' 같은 관측 문장
  status: "ok" | "failed";
  detail: string | null;      // 실패 사유. onsite는 기준선 판독 시각(ISO)을 넣는다
  notified_at: string | null; // null = 아직 안 보냄. 선점이 여기를 먼저 찍는다
}

/** 기록 입력. `silent`는 장부에는 남기되 알림만 건너뛴다(notified_at을 미리 채운다) —
 *  기록 자체를 건너뛰면 그 명령이 만든 변화를 다음 틱이 현장 조작으로 둔갑시킨다. */
interface EventInput {
  device_id: string | null;
  camera_id?: string | null;
  kind: EventKind;
  action: string;
  value?: string | null;
  status: "ok" | "failed";
  detail?: string | null;
  silent?: boolean;
}

/** 연결 전환 판정의 근거 — 대상별 '마지막 한 건'. */
interface LatestEvent { kind: EventKind; at: string; }
```

```typescript
// ── 자동화가 기기에 대해 기억하는 것: device_watch
//    (20260807010000 device_temp_floor → 20260807120000에서 rename + 컬럼 추가)
interface DeviceWatchRow {
  device_id: string;             // uuid PK FK devices(id) on delete cascade
  below_since: string | null;    // 하한 미만 가동 시작(null = 정상 또는 꺼짐)
  last_power: string | null;     // 마지막으로 관측한 전원
  last_temp: number | null;      // 마지막으로 관측한 목표온도
  seen_at: string | null;        // **벤더가 그 값을 준 시각** (틱 시각이 아니다)
}

/** 코드에서 다루는 형태(store.ts). 행이 있다 = 한 번이라도 관측했다는 뜻이지
 *  '하한 미만'이 아니다 — 하한 판정은 belowSince가 null인지로 한다. */
interface Watch {
  belowSince: Date | null;
  lastPower: string | null;
  lastTemp: number | null;
  seenAt: Date | null;
}
```

```typescript
// ── 생존 감시: automation_heartbeat / automation_config (20260813130000)
interface AutomationHeartbeat {
  id: 1;                       // smallint PK check (id = 1) — 단일 행
  beat_at: string;             // not null. 마지막 정상 완주
  alerted_at: string | null;   // 워치독의 마지막 알림(억제용). 정상 완주가 null로 되돌린다(재무장)
}

interface AutomationConfig {
  key: string;                 // 'heartbeat_webhook_url'
  value: string | null;        // 매 틱 시크릿에서 동기화된다. 비면 워치독은 조용히 아무것도 안 한다
}
```

```typescript
// ── 예약 쪽 추가 컬럼 (20260807000000)
//    null = 아직 실행 안 됨. 창을 놓쳐 '건너뜀'으로 닫은 경우도 채운다(무한 재시도 방지)
//    → 이 컬럼만으로 기기에 실제로 명령이 갔는지는 확정할 수 없다.
interface ReservationAutomationColumns {
  checkin_automation_at: string | null;
  checkout_automation_at: string | null;
}

/** 틱이 읽는 예약 행(store.ts). 뒤 여섯 필드는 문자·청소가 쓰지만 같은 조회에 얹는다 —
 *  따로 조회하면 기기·손님문자·청소안내가 서로 다른 예약 목록을 보는 순간이 생긴다. */
interface Reservation {
  id: string;
  date: string;        // 'YYYY-MM-DD' (KST 벽시계)
  start_time: string;  // 'HH:MM:SS'
  end_time: string;    // 배타적 상한. start 이하면 endTime()이 하루를 더한다
  checkin_automation_at: string | null;
  checkout_automation_at: string | null;
  name: string;
  phone: string | null;
  deposit_required: boolean;
  sms_auto: boolean;
  guests: number | null;
  purpose: string | null;   // 자주 비어 있다(Gmail 동기화 경로는 항상 null)
}
```

```typescript
// ── 순수 판정 타입 (windows.ts · connectivity.ts)
interface ReservationWindow { date: string; start_time: string; end_time: string; }
type DueState = "wait" | "fire" | "expired";

/** 연결 감시 대상 — devices.ts가 아니라 구조적 타입으로 받는다(순환 import 회피). */
interface WatchedDevice {
  id: string;
  state: { online: boolean; is_stale: boolean; never_seen: boolean };
}
type ConnectivityDecision = "offline" | "recovered" | "none";
```

### 기본값·경계 규칙

| 상황 | 동작 | 이유 |
|---|---|---|
| `power = null` | 스윕·유휴 경보 대상이 **아니다**. 현장 조작 전이로도 안 센다 | '모름'과 'OFF'를 합치면 냉난방이 밤새 도는 상황이 조용히 숨는다 |
| `device_watch` 행 없음 | 관측한 적 없음 → 현장 조작 판정 스킵, 기준선만 만든다 | 배포 직후 전 기기 오탐 방지 |
| `below_since` = null | 하한 시계 정지 | 행의 존재는 '관측했다'는 뜻이지 '하한 미만'이 아니다 |
| `updated_at` = null(`never_seen`) | 끊김 경보 대상에서 제외 | '설치 전'과 '죽음'을 섞지 않는다 |
| `automation_config` 값 없음/빈 문자열 | 워치독이 조용히 종료 | 설정 안 된 상태가 오작동이 되면 안 된다 |
| `device_events.device_id`·`camera_id` 둘 다 null | '공간 전체' 사건(전환 만료·전환 실패·system_error) | 기기를 하나 골라 적으면 거짓이다 |

## 7. 데이터 저장 구조

```
reservations
  ├ checkin_automation_at    ← 전환 선점 표시 (조건부 update로 원자적으로 가져간다)
  └ checkout_automation_at

device_events                ← 장부 (RLS on, 정책 없음)
  ├ device_events_pending_idx  (at) where notified_at is null   ← 미발송 훑기
  ├ device_events_recent_idx   (device_id, at desc)             ← 기기별 최근 명령
  ├ device_events_kind_idx     (kind, at desc)                  ← kind로 좁히는 조회 넷
  ├ device_events_action_idx   (kind, action, at desc)          ← system_error 백오프
  ├ device_events_camera_idx   (camera_id, at desc)
  ├ check kind in (13종)
  └ check (device_id is null or camera_id is null)              ← 대상 배타

device_watch                 ← 자동화의 기억 (RLS on, 정책 없음)
  device_id PK / below_since / last_power / last_temp / seen_at

automation_heartbeat         ← 단일 행 id=1 (RLS on, 정책 없음)
automation_config            ← key/value. 지금 쓰는 키는 heartbeat_webhook_url 하나
```

**정리 크론**(`device-events-cleanup`, 매일 04:17): 발송 완료분은 30일, **미발송분도 7일이면
버린다.** 미발송을 무기한 남기면 웹훅이 오래 죽어 있을 때 테이블이 무한히 자라고, 살아난 뒤엔
밀린 것이 통째로 한 메시지가 되어 길이로 거절당하는 악순환에 빠진다.

**`device_state`에 컬럼을 더하지 않은 이유**: 그 테이블은 **벤더가 보고한 상태**의 캐시이고
`device_watch`는 **우리 정책의 집행 기록**이다. 섞으면 '기기가 말한 것'과 '우리가 정한 것'의
경계가 흐려지고, 상태 upsert가 집행 기록을 밟고 지나갈 여지가 생긴다.

**마이그레이션의 제약 조작은 조건 없이 한다**(`drop constraint` / `rename`에 `if exists`를 안
붙인다). 조건을 걸면 이름이 다를 때 조용히 넘어가고 뒤이은 add가 성공해 **옛 제약이 남는다** —
마이그레이션은 성공한 것처럼 보이는데 새 kind는 계속 거부되는, 가장 나쁜 실패 방식이다.

## 8. 기술 구현

### 모듈 구조

```
supabase/functions/control/
  index.ts                      ← action 라우팅. automate만 예약 시간 게이트를 면제한다
  auth.ts                       ← GUEST_ACTIONS에 automate 포함
  handlers/automation.ts        ← 틱 진입점: 판정과 실행을 이어 붙인다 (이 스펙의 오케스트레이터)
  automation/
    windows.ts                  ← 순수 시각 판정. DB도 기기도 안 건드린다
    schedule.ts                 ← 예정된 전환: 무엇을 보낼 것인가
    enforce.ts                  ← 지속 강제: 스윕 · 온도 하한 · 유휴 경보
    observe.ts                  ← 현장 조작 추론 + 기준선 갱신
    connectivity.ts             ← 끊김/복구 전환 판정
    heartbeat.ts                ← 완주 기록 + 워치독 웹훅 동기화
    dispatch.ts                 ← 명령 발행의 유일한 문 (command + 장부 기록)
    events.ts                   ← 장부 읽기/쓰기, 선점, system_error 백오프
    store.ts                    ← 예약 조회 · 전환 선점 · device_watch 접근
    message.ts                  ← 알림 본문 조립 (순수)
    notify.ts                   ← 웹훅 발송과 그 실패만
```

### 주요 함수

```
handlers/automation.ts
  ├── automate(sb)                      ← 최상위 try/catch. 실패를 장부에 남기고 그 자리에서 보낸 뒤 재던짐
  ├── runAutomation(sb, now)            ← 파이프라인 본체
  └── runTransition(sb, r, state, ...)  ← 선점 → 만료/실패 기록 → fire()

automation/windows.ts   (전부 순수 — DB 없이 테스트된다)
  ├── targetTime(date, time)            ← KST +09:00 명시 파싱
  ├── kstDay(now) / prepTime(r) / endTime(r)   ← endTime은 자정 넘김을 보정한다
  ├── dueState(target, now)             ← wait | fire | expired
  ├── checkinDueState(r, now)           ← 만료 경계만 입실 시각 기준
  ├── isOccupied(rs, now) / isSweeping(rs, now)
  └── sweepElapsedMinutes(rs, now)      ← 겹칠 때는 가장 이른 퇴실 기준(Math.max)

automation/schedule.ts
  ├── prepareHvac(sb, d)                ← 전원 → 모드 → 온도 순차
  ├── firePrep(sb, devices)             ← 기기끼리 병렬(allSettled)
  └── fireShutdown(sb, devices)

automation/enforce.ts
  ├── floorApplies(power, mode, target) ← 순수. 하한을 걸 조건
  ├── sweepIdleDevices(sb, devices, elapsed, now)
  ├── enforceTempFloor(sb, devices, now)
  └── alertIdleDevices(sb, devices, now)

automation/observe.ts
  ├── isContactGap(baselineAt, readingAt)  ← 순수. 판정을 통째로 삼키는 문
  └── detectOnsite(sb, devices, now)

automation/connectivity.ts
  ├── decideTransition(down, latest, count, ...)  ← 순수. 플래핑 정확성의 핵심
  └── checkConnectivity(sb, devices, cameraPairs, thinqErrors, now)

automation/heartbeat.ts
  ├── recordHeartbeat(sb, now)          ← beat_at 갱신 + alerted_at 재무장
  └── syncWatchdogWebhook(sb)           ← set | unchanged | missing | failed

automation/events.ts
  ├── record / recordMany               ← 절대 던지지 않는다
  ├── fetchRecentCommands(sb, since)    ← COMMAND_KINDS · status='ok'만
  ├── fetchActedDevices / fetchSweptSince
  ├── fetchLatestByTarget / countRecentByTarget
  ├── claimPending(sb, now) / release(sb, ids) / sortByOccurrence(rows)
  └── recordSystemError(sb, action, detail, now)

automation/store.ts
  ├── fetchRecent(sb, now)              ← 어제~내일 KST · cancelled=false
  ├── claimTransition(sb, id, column, now)
  ├── fetchWatch(sb) / saveObservation(...)
  └── startTempFloor(..., {force}) / clearTempFloor(...)
```

### 조회 범위가 '어제~내일'인 이유

준비가 입실 15분 전이라 자정 직후 예약의 준비 시각이 **전날**이다. 오늘까지만 가져오면
23:45~23:59에 그 예약이 안 보이고, 자정을 넘겨 처음 보일 땐 이미 캐치업 창을 넘겨 `expired`로
지나간다 — 00:00~00:05 시작 예약은 준비가 통째로 안 됐고, 그 사이 다음 예약이 있다는 사실을
몰라 퇴실 스윕도 안 막혔다. 어제까지 읽는 것은 자정을 넘긴 예약(`22:00~02:00`)이 `date`는
어제인 채로 오늘 새벽까지 이어지기 때문이다.

이미 자동화가 끝난 예약도 가져온다 — 창 판정은 '실행했는가'가 아니라 '지금 쓰이는 중인가'를
묻는다. 여기서 걸러내면 이용 중인 손님 머리 위로 스윕이 돈다.

## 9. API

| 메서드 | 경로 | 본문 | 설명 |
| --- | --- | --- | --- |
| POST | `/functions/v1/control` | `{"action":"automate"}` | 틱 1회. 비밀번호 없음(guest role). pg_cron 전용이지만 anon key로 누구나 부를 수 있다 |

응답(200):

```typescript
interface AutomateResult {
  watchdog: "set" | "unchanged" | "missing" | "failed"; // 웹훅 동기화 결과(URL은 안 싣는다)
  prep_fired: number;        // 이번 틱에 실행된 입실 준비 수
  shutdown_fired: number;
  swept: number;             // 스윕으로 끈 기기 수
  temp_corrected: number;    // 하한으로 되돌린 기기 수
  onsite: number;            // 현장 조작으로 기록된 변화 수
  idle: number;              // 유휴 경보를 낸 기기 수
  device_offline: number;    // 기기 연결 전환(끊김+복구) 기록 수
  camera_offline: number;    // 카메라 연결 전환 기록 수
  notified: number;          // 실제 발송된 이벤트 수
  sms: { sent: number; failed: number; no_phone: number; expired: number };
  cleaning: { digest: number; update: number; quiet: number; failed: number };
  reservations: number;      // 이번 틱이 본 예약 수
}
```

`watchdog`을 응답에 싣는 이유는 URL을 노출하지 않고 '설정됐는지'만 확인하기 위해서다.

## 10. 의존성 · 관련 스펙

| 스펙 | 관계 |
|---|---|
| `spec_space_control` | **기기 명령의 정본.** 이 스펙은 `dispatch.issue()`를 통해 그 `command()`를 부르기만 한다. 명령 값 검증·어댑터·조명 큐는 그쪽 |
| `spec_reservation_sync` | `reservations` 행을 만든다. `date`/`start_time`/`end_time`이 KST 벽시계 naive 값인 것, `end_time`이 배타적 상한인 것이 이 스펙의 전제 |
| `spec_guest_sms` | 같은 `automate` 틱에 얹혀 돈다(`sweepSms`). 같은 `reservations` 배열과 같은 `endTime()`을 쓴다 |
| `spec_cleaning_sms` | 같은 틱에 얹혀 돈다(`sweepCleaning`). 전용 cron 없음 |
| `spec_cctv` | 카메라 목록·상태의 정본. 이 스펙은 연결 끊김 감시 대상으로만 읽는다 |
| `spec_admin_auth` | `automate`가 예외인 게이트(예약 시간 창)와 시도 제한 정책의 정본 |

## 파일(페이지) 구성

| 파일 | 경로 | 설명 |
| --- | --- | --- |
| `automation.ts` | `supabase/functions/control/handlers/` | 틱 진입점. 판정과 실행을 이어 붙인다 |
| `windows.ts` | `supabase/functions/control/automation/` | 순수 시각 판정(KST·자정 넘김·캐치업·스윕 창) |
| `schedule.ts` | `supabase/functions/control/automation/` | 입실 준비·퇴실 종료 명령 조립 |
| `enforce.ts` | `supabase/functions/control/automation/` | 스윕·온도 하한·유휴 경보 |
| `observe.ts` | `supabase/functions/control/automation/` | 현장 조작 추론, 기준선 갱신 |
| `connectivity.ts` | `supabase/functions/control/automation/` | 연결 끊김/복구 전환 판정 |
| `heartbeat.ts` | `supabase/functions/control/automation/` | 완주 기록 + 워치독 웹훅 동기화 |
| `dispatch.ts` | `supabase/functions/control/automation/` | 명령 발행의 유일한 문 |
| `events.ts` | `supabase/functions/control/automation/` | 장부 접근·선점·백오프 |
| `store.ts` | `supabase/functions/control/automation/` | 예약 조회·전환 선점·device_watch |
| `message.ts` | `supabase/functions/control/automation/` | 알림 본문 조립(순수) |
| `notify.ts` | `supabase/functions/control/automation/` | 웹훅 발송과 실패 분류 |
| `windows.test.ts` · `observe.test.ts` · `connectivity.test.ts` · `events.test.ts` · `message.test.ts` | `supabase/functions/control/automation/` | 순수 판정 회귀 테스트(CI) |
| `20260807000000_reservation_automation.sql` | `supabase/migrations/` | 예약 표시 컬럼 2개 + pg_cron 1분 잡 |
| `20260807010000_device_temp_floor.sql` | `supabase/migrations/` | 온도 하한 시계 테이블 |
| `20260807120000_device_events.sql` | `supabase/migrations/` | 장부 신설 + `device_watch` 개명·확장 + 정리 크론 |
| `20260808000000_device_events_idle.sql` | `supabase/migrations/` | `idle` kind, `device_id` nullable, kind 인덱스 |
| `20260812130000_device_events_connectivity.sql` | `supabase/migrations/` | `camera_id` + kind 5종(연결·시스템 오류) |
| `20260813130000_automation_heartbeat.sql` | `supabase/migrations/` | 하트비트·설정 테이블 + 5분 워치독 잡 |
| `index.ts` | `supabase/functions/control/` | (수정) `automate`의 예약 시간 게이트 예외 |
| `auth.ts` | `supabase/functions/control/` | (수정) `GUEST_ACTIONS`에 `automate` |
| `list.ts` | `supabase/functions/control/handlers/` | (수정) `thinqMaxAgeSeconds` · `errorSink` 매개변수 |

## 11. 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-07 | 예약 기반 자동화 도입 — 입실 준비·퇴실 종료·스윕·온도 하한, 조작 알림(#26·#27) |
| 2026-08-08 | 자정 넘김 `endTime` 보정, 스윕 알림·현장 조작 판별 정정, 유휴 경보 신설(#28~#32·#34~#37) |
| 2026-08-09 | 예약 시간 게이트 도입에 따른 `automate` 예외(#44) |
| 2026-08-12 | 연결 끊김/복구 + 시스템 오류 알림(#71) |
| 2026-08-13 | 08-09부터 죽어 있던 자동화 복구·자정 넘김 시간창(#70), 워치독 웹훅 자동 동기화(#74), 하트비트 워치독 신설(#73) |
| 2026-08-14 | 스펙 문서 최초 작성(역기획 — 구현이 선행) |
