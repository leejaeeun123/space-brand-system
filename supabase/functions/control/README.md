# 공간 제어 (냉난방 · 조명 큐 · CCTV 목록)

`admin.html`의 **공간 제어**·**CCTV** 탭과 손님용 `guest-control.html`이 쓰는 Edge Function.
세 가지를 다룬다 —
**냉난방(LG ThinQ)** 직접 제어, **조명(Tasmota)** 명령 큐잉, **CCTV** 목록·자격증명 발급.
영상 자체는 여기를 지나가지 않는다(→ `handlers/cameras.ts`).

Space(`nmwc-ai/Space`, 유재형)의 `src/control/thinq` 를 이식한 것이다. 그쪽 AWS 인프라는
쓰지 않는다 — 접근 권한이 없다. ThinQ는 순수 HTTPS REST라 인프라 없이 그대로 옮겨진다.

## 왜 Edge Function인가 (편의가 아니라 필수)

`admin.html`은 소스가 그대로 공개된다. ThinQ PAT가 거기 들어가면 **LG 계정 전체**가 노출된다.
그래서 비밀을 들고 있는 층이 서버에 하나 필요하고, 그게 이 함수다.

같은 이유로 `devices`·`device_state` 테이블은 RLS를 켜되 **정책을 만들지 않았다** — anon 키로는
읽기도 쓰기도 불가능하고, 이 함수(service_role)만이 유일한 접근 경로다. 예약(`reservations`)과
다르게 간 이유는 위험의 등급이 다르기 때문이다: 예약은 읽혀도 정보가 새는 정도지만, 기기 제어는
소스만 본 사람이 **손님 이용 중에 냉난방을 끌 수 있다**.

## 부르는 쪽이 둘이다 — 그래서 권한도 둘이다

| 역할 | 판정 | 부르는 화면 | 할 수 있는 일 |
|---|---|---|---|
| `admin` | `password`가 `ADMIN_PASSWORD`와 일치 | `admin.html` | 11개 action 전부 |
| `guest` | `password`를 아예 안 보냄 | `guest-control.html` (`/control`) | `list` + `command` 5종 + `automate` (등록·해제·CCTV 제외) |

**손님 경로에는 비밀번호가 없다.** 예전엔 `GUEST_PASSWORD`(=현관 비밀번호)로 게이트를 걸었지만,
그 값은 사이트 루트(`guest-guide.html`)에 이미 평문으로 공개돼 있어 별도 장벽이 아니었다. 지금은
`password`를 안 보낸 요청이 곧 guest다 — 그 대신 guest가 부를 수 있는 action·command는 그대로
서버가 잘라낸다.

admin 비밀번호는 이 함수만 여는 열쇠가 아니라 `reservations`의 `admin_*` RPC — 예약자 이름·
전화번호·이메일 — 까지 여는 열쇠다(`admin.html`이 같은 값을 양쪽에 쓴다). 그래서 admin 판정은
여전히 비밀번호가 정확히 일치해야 하고, 틀린 값(빈 값 아님)은 guest로 낮추지 않고 401로 막는다 —
그렇지 않으면 `admin.html`의 오타가 "비밀번호가 맞지 않아요" 대신 알 수 없는 403으로 보인다.

판정은 전부 [`auth.ts`](./auth.ts)에 있고, **서버에 있어야 한다** — `guest-control.html`도 소스가
공개되므로 클라이언트에서 버튼을 감추는 것은 아무것도 막지 못한다 — 누구나 `fetch`로
`delete`나 `camera_credentials`를 직접 부를 수 있다.

**냉난방 명령 다섯 가지는 손님에게 전부 열려 있다.** 손님은 이미 물리 리모컨으로
온도·모드·풍량을 다 바꿀 수 있어서 여기서 막아도 새로 막힐 게 없다. 값은
`thinq/commands.ts`가 기기 프로파일에 대고 검증한다 — 온도는 min/max/step, 모드·풍량은
프로파일이 준 enum 목록.

그래도 `command` action을 통째로 열지 **않았다.** 명령이 하나 추가될 때(기기 초기화
같은 것) 기본값은 '손님은 못 한다'여야 하고, `GUEST_COMMANDS`에 한 줄 적는 일이 그
결정을 한 번 거치게 한다. 손님에게 닫힌 경계는 이제 명령이 아니라 **action**이다 —
기기 등록·해제와 CCTV는 기기를 잡는 게 아니라 구성과 영상을 잡는 일이라 등급이 다르다.

`ADMIN_PASSWORD` 미설정은 예전처럼 전면 거부(503)다 — 무인증 제어로 열리는 것보다 닫혀 있는 게
낫다.

이 파일은 이 레포에서 유일하게 테스트가 붙어 있다(`auth.test.ts`). 나머지 핸들러의 실수는
기능이 안 되는 정도지만, 여기 실수는 조용히 열린 채로 잘 돌아간다.

```bash
deno test --allow-env supabase/functions/control/auth.test.ts
```

## 설치 절차

**→ [`06-applications/control-setup.md`](../../../06-applications/control-setup.md) 의 A 단계를 따른다.**
손님 페이지를 여는 것은 같은 문서의 **G 단계**다.

절차를 그쪽 한 군데에만 둔 이유: 냉난방과 조명 절차를 나눠두면 한쪽만 고쳐졌을 때 조용히 어긋난다.
이 문서는 **왜 그렇게 만들었는지**와 구조를 다룬다.

한 가지만 여기 남긴다 — 등록 시 capabilities/constraints를 **기기 프로파일에서 파생한다.**
클라이언트가 준 값을 쓰지 않는다. 근거는 원본의 실측이다 — 문서 예시와 실기기가
**step·모드·풍량 세 군데에서 달랐다**(ss-4er). 실기기 프로파일이 유일한 진실원이다.

## 확인

```bash
# admin 비밀번호 틀리면 401 (guest면 password를 아예 뺀다)
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
  -d '{"action":"list","password":"<비밀번호>"}'
```

`{"thinq_configured":true, ...}` 가 나오면 시크릿이 제대로 들어간 것이다.
로그는 Supabase 대시보드 → Edge Functions → control → Logs.

## 예약 자동화 (automate)

pg_cron이 1분마다 이 action을 찌른다(마이그레이션 `20260807000000_reservation_automation.sql`).
진입점은 [`handlers/automation.ts`](./handlers/automation.ts), 로직은 [`automation/`](./automation/)에 있다.

하는 일이 **두 종류**다 — 이 구분이 파일 분리의 기준이다.

| | 언제 | 몇 번 | 파일 |
|---|---|---|---|
| **예정된 전환** | 입실 15분 전 · 퇴실 시각 | 예약당 한 번(기록으로 닫힌다) | `automation/schedule.ts` |
| **지속 강제** | 창이 열려 있는 동안 | 매 틱(반복이 곧 기능이다) | `automation/enforce.ts` |

**예정된 전환** — 입실 15분 전엔 냉난방을 전원→냉방→26도 **순서대로** 넣고(모드를 바꾸면
목표온도가 기본값으로 되돌아가는 기종이 있다), 조명은 나이트모드와 같은 SiHAS on/off 조합으로
맞춘다. 퇴실 시각엔 전원 가능한 기기를 전부 끈다.

**지속 강제** — 두 가지다:

- **퇴실 후 스윕(10분)**: 퇴실 직후 10분 동안 켜지는 기기를 매 틱 다시 끈다. **다음 예약의
  준비 시각이 이미 지났으면 돌지 않는다**(`isOccupied`가 `isSweeping`보다 우선) — 바로 붙은
  예약을 위해 켠 기기를 도로 끄면 손님이 들어왔을 때 불이 꺼져 있다.
- **온도 하한(24도)**: 24도 미만으로 **5분 넘게 가동**하면 24도로 되돌린다. 잠깐 세게 트는 것
  자체는 막지 않는다. 시계는 `device_watch` 테이블이 잡고, 전원이 꺼지면 해제된다
  (요구사항이 "5분간 **가동**하다"이기 때문).

준비 온도(26)는 하한(24)보다 **높아야 한다** — 낮게 잡으면 준비하자마자 하한 강제가 되돌려
두 자동화가 서로 싸운다.

호출자가 어떤 예약을 대상으로 할지 고르지 않는다 — 서버가 매번 지금 시각으로 다시 계산한다.
그래서 guest 권한으로 열어도(`GUEST_ACTIONS`) 새로 여는 권한이 없다: 발행하는 명령은 손님이
이미 `command`로 직접 부를 수 있는 것들이고, pg_cron은 ADMIN_PASSWORD 없이 anon key만으로
부른다.

**캐치업 창은 10분이다.** control-agent의 60초 TTL과 같은 철학 — 스케줄러가 밀렸다가 뒤늦게
재생하면 엉뚱한 시각에 냉난방이 켜진다. 창을 넘긴 예약은 실행하지 않고 `*_automation_at`을
채워 건너뛴 채로 표시한다(무한 재시도 방지).

**전환이 방금 일어난 틱엔 강제를 건너뛴다.** 방금 보낸 명령이 상태 캐시에 반영되기 전이라
(조명은 아직 큐에도 안 나갔다) 지금 읽은 상태로 판단하면 방금 켠 것을 도로 끄는 수가 있다.


## 조작 알림 (Mattermost)

기기가 움직이면 그 사실을 채널로 보낸다. **누가 움직였는지를 넷으로 가른다.**

| 구분 | 어떻게 아는가 | 확실성 |
|---|---|---|
| 자동 (`prep`·`shutdown`·`sweep`·`temp_floor`) | `automate`가 직접 발행 | 확실 |
| 원격 어드민 (`remote_admin`) | `command` 요청 + admin 역할 | 확실 |
| 원격 손님 (`remote_guest`) | `command` 요청 + guest 역할 | 확실 |
| 현장 (`onsite`) | 상태가 바뀌었는데 설명할 명령이 없음 | **추론** |

벽 스위치와 에어컨 리모컨은 우리 API를 거치지 않아 직접 볼 방법이 없다. 그래서 이렇게 뺀다:

    관측된 상태 변화  −  최근 120초 내 우리 명령  =  현장 조작

즉 현장 조작은 관측이 아니라 **잔여 범주**다. 그래서 두 가지가 생명이다 —

- **모든 명령이 `automation/dispatch.ts`의 `issue()`를 지나야 한다.** 여기를 우회해
  `command()`를 직접 부르면 그 조작은 장부에 안 남고, 다음 틱이 그 변화를 **현장 조작으로
  잘못 알린다.**
- **대조 창(120초)은 조명 지연을 덮어야 한다.** 조명은 큐(최대 60초 TTL) → 에이전트 발행 →
  기기 stat 보고를 거쳐야 상태가 바뀐다. 창을 줄이면 우리가 켠 조명이 현장 조작으로 둔갑한다.
  반대 대가는 감수한 것이다 — 우리 명령 직후 120초 안의 진짜 현장 조작은 우리 것으로 흡수된다.

**묶기가 기능이다.** 입실 준비 한 번이 명령 8개(냉난방 3 + 조명 5)를 낳는다. 하나씩 보내면
채널을 못 쓴다. 틱이 종류별로 묶어 보내므로 알림은 **분당 최대 (종류 수)건**이고, 같은 기기의
여러 명령은 한 줄로 합쳐 최종 상태만 보인다(단, 실패는 마지막이 아니어도 반드시 보인다).

**채널**은 예약 알림과 같은 곳을 쓴다(형운 결정, 2026-08-07). 기기 알림이 잦아 예약 알림을
덮게 되면 `MATTERMOST_DEVICE_WEBHOOK_URL` 시크릿만 넣어 **코드 수정 없이** 분리할 수 있다 —
`notify.ts`가 그쪽을 먼저 보고 없으면 `MATTERMOST_WEBHOOK_URL`로 떨어진다.

알림 실패는 절대 밖으로 던지지 않는다. 알림이 안 갔다고 기기 제어가 망가지면 안 된다.

## 구조

| 파일 | 책임 |
|---|---|
| `index.ts` | HTTP 표면 — CORS·라우팅 |
| `auth.ts` | 역할 판정(admin/guest) + 손님 허용 범위 |
| `handlers/list.ts` | 목록 조회 + ThinQ 상태 갱신(TTL 30초) |
| `handlers/command.ts` | 명령 1건 검증·발행 |
| `handlers/automation.ts` | 자동화 진입점 — 틱당 판정과 실행을 이어 붙임 |
| `automation/windows.ts` | 순수 시각 판정(KST) — 준비/퇴실/스윕 창 |
| `automation/schedule.ts` | 예정된 전환 — 입실 준비 · 퇴실 종료 명령 |
| `automation/enforce.ts` | 지속 강제 — 퇴실 후 스윕 · 온도 하한 |
| `automation/store.ts` | 예약 조회·기기 감시(device_watch) Postgres 접근 |
| `automation/dispatch.ts` | **모든 기기 명령이 지나가는 문** — 발행 + 장부 기록 |
| `automation/events.ts` | 조작 이벤트 장부(device_events) 접근 |
| `automation/observe.ts` | 상태 변화 → 현장 조작 판별(추론) |
| `automation/notify.ts` | 이벤트를 묶어 Mattermost로 발송 |
| `handlers/registry.ts` | 기기 등록/해제, ThinQ 계정 기기 목록 |
| `handlers/cameras.ts` | 카메라 목록·등록·해제 + 스트림 자격증명·보관기간 발급 |
| `handlers/shared.ts` | 핸들러 공통 — 에러 타입·입력 검증 |
| `thinq/client.ts` | HTTP 클라이언트 + 에러 매핑 |
| `thinq/commands.ts` | Command → 제어 본문 + 범위/enum 검증 |
| `thinq/profile.ts` | 프로파일 → capabilities/constraints 파생 |
| `thinq/state.ts` | state 응답 → DeviceState |
| `devices.ts` | Postgres 접근 (service_role) |
| `cameras.ts` | 카메라·카메라 상태 Postgres 접근 |
| `types.ts` | 공유 타입 |
| `tasmota/topics.ts` | 조명 MQTT 토픽 문법 + 기기 ID 검증 |

action은 11개다. **그중 손님이 부를 수 있는 건 3개**(`list` · `command` · `automate`)뿐이다.

- 기기 제어 7개: `list` · `thinq_devices` · `register` · `register_light` · `command` · `delete` · `automate`
- CCTV 4개: `cameras` · `camera_credentials` · `camera_register` · `camera_delete`

CCTV 설치는 [`06-applications/cctv-setup.md`](../../../06-applications/cctv-setup.md)에 있다.

## 절대 되돌리면 안 되는 것

- **`power = null`('모름')을 `'OFF'`로 합치지 말 것.** 합치면 꺼진 줄 알았는데 실제로는 켜져 있는
  상황 — 즉 **냉난방이 밤새 돌아가는 상황** — 이 조용히 숨는다. UI도 이 둘을 구분해 표시한다.
- **`updated_at`의 기본값을 `now()`로 주지 말 것.** 한 번도 상태를 못 받은 기기가 '방금 갱신됨'으로
  보여 화면에 '0초 전'이라 표시된다. 수신 이력이 없으면 `null`이다.
- **PAT 401은 재시도하지 말 것.** 자동 재발급 경로가 없다 — 만료되면 사람이 갱신하는 수밖에 없고,
  재시도는 계정 잠금 위험만 만든다.
- **capabilities를 클라이언트가 주는 값으로 쓰지 말 것.** ThinQ는 프로파일에서만 파생한다.
- **손님 허용 목록을 클라이언트로 옮기지 말 것.** `guest-control.html`에서 버튼을 감추는 건
  방어가 아니다 — 누구나 `fetch`로 `delete`를 직접 부를 수 있다. 비밀번호 게이트가 없는 지금은
  이 서버측 검사가 손님 경로의 **유일한** 방어선이다.
- **틀린(비어 있지 않은) 비밀번호를 guest로 조용히 낮추지 말 것.** `resolveRole`이 그렇게
  하면 `admin.html`의 오타가 401이 아니라 알 수 없는 403으로 보인다. guest는 `password`를
  아예 안 보낸 경우로만 판정한다.
- **예약 시각을 오프셋 없이 파싱하지 말 것.** `new Date("2026-08-10T14:00:00")`은 **로컬** 시각이다 —
  배포 런타임(Deno Deploy)은 UTC라 예약이 **9시간 어긋난 채로 조용히** 돌아간다. 개발 맥은 KST라
  같은 코드가 우연히 맞게 나오고, `getHours()`로 검증하는 테스트도 그걸 못 잡는다(실제로 한 번
  이렇게 틀렸다). `windows.ts`가 `+09:00`을 명시하고, 테스트는 `toISOString()`으로 단언한다.
- **`issue()`를 우회해 `command()`를 직접 부르지 말 것.** 장부에 안 남는 명령은 다음 틱이
  '설명할 수 없는 변화' = 현장 조작으로 잘못 알린다. 기기를 움직이는 코드는 그 문을 지난다.
- **대조 창(120초)을 조명 지연보다 짧게 줄이지 말 것.** 조명은 큐 TTL 60초에 발행·보고 지연이
  더 붙는다. 짧으면 우리가 켠 조명이 매번 '현장 조작'으로 알려진다.
- **`device_watch` 행을 지우지 말 것.** 온도 하한이 풀렸다고 행을 지우면 관측 기준선이 사라져
  다음 틱이 모든 변화를 현장 조작으로 본다. `below_since`만 null로 비운다.
- **스윕이 `power = null`을 끄게 하지 말 것.** '모름'을 'ON'으로 보면 상태를 한 번도 못 받은 기기에
  10분 내내 매 틱 명령이 나간다. 퇴실 시각의 '전체 끄기'는 `schedule.ts`가 이미 한 번 보냈다.

## 조명은 여기서 큐에만 넣는다

`command`에 조명 기기가 오면 MQTT를 직접 쏘지 않고 **`device_commands`에 행을 넣기만 한다.**
합정 맥은 NAT 뒤라 여기서 닿을 수 없기 때문이다. 현장 에이전트가 Supabase Realtime으로
그 INSERT를 받아 로컬 mosquitto에 발행한다 → [`06-applications/control-agent/`](../../../06-applications/control-agent/)

그래서 조명 응답은 `acked`가 아니라 **`sent`**다 — 아직 발행도 안 됐고, 발행돼도 '기기가
실행했다'는 뜻이 아니다. 실제 반영은 기기가 `stat`으로 보고하고 에이전트가 `device_state`에 쓴다.
ThinQ(HTTP 동기)가 한 호출에서 `acked`로 확정하는 것과 정반대다 — 이 차이를 흐리면
꺼진 줄 알았는데 켜져 있게 된다.

Space의 AWS IoT 경로(계정 `203060559062`)는 접근 권한이 없어 쓰지 않는다. 브릿지를 아예
없앤 결과, Space가 "우회 불가"로 판정했던 문제 — retained가 브릿지를 통과하지 못하는 것 —
도 원인째 사라졌다.
