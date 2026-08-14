# spec_space_control

> 손님과 운영자가 타입라운지(합정)의 **냉난방과 조명**을 웹에서 직접 조작하는 기능.
> 손님은 비밀번호 없이 `/control`에서, 운영자는 `/admin`의 "공간 제어" 탭에서 같은 서버를 부른다.

## 1. 개요

타입라운지는 상주 인력이 없다. 손님이 도착했을 때 공간이 더우면 물어볼 사람이 없고, 벽 스위치는
게스트 가이드가 **고장·비용 청구**로 경고하는 대상이라 만지라고 할 수도 없다. 그래서 조작 창구를
웹으로 만든다.

화면은 둘이고, 같은 Edge Function(`control`) 하나를 부른다.

| 화면 | 경로 | 누가 | 언제 | 할 수 있는 것 |
|---|---|---|---|---|
| 손님 제어 | `/control` (`guest-control.html`) | 비밀번호 없이 누구나 | **자기 예약 시간 안에서만** | 조회 · 전원 · 온도 · 모드 · 바람 세기 · 전체 · 나이트모드 |
| 어드민 공간 제어 | `/admin`의 탭 (`admin.html`) | 어드민 비밀번호 보유자 | 항상 | 위 전부 + 기기 등록 · 등록 해제 |

기기는 두 계열이고, **고장 지점이 완전히 다르다.**

| 계열 | 어댑터 | 명령이 가는 길 | 합정 맥 의존 |
|---|---|---|---|
| 냉난방 (에어컨) | `thinq` | Edge Function → LG 클라우드 HTTP → 기기 | **없음** — 맥이 꺼져 있어도 동작한다 |
| 조명 | `tasmota` | Edge Function → 명령 큐 → Realtime → 합정 맥 에이전트 → 로컬 mosquitto → 기기 | **있음** — 맥이 죽으면 조명만 멈춘다 |

이 비대칭이 이 스펙의 뼈대다. 같은 버튼을 눌러도 냉난방은 **`acked`**(기기 반영 확인)를,
조명은 **`sent`**(큐에 넣기만 함)를 돌려준다. 둘을 "성공"으로 뭉개면 조명이 밤새 켜져 있는데
화면에는 성공만 남는다.

핵심 동작 세 가지:

1. **손님에게 여는 "언제"를 서버가 정한다.** 손님 경로엔 비밀번호가 없어 URL만 알면 누구나
   요청을 보낼 수 있다. 예약 시간 창 판정은 서버(`reservation-window.ts`)가 하고, 클라이언트는
   그 결과를 화면에 반영만 한다. 버튼을 감추는 것은 방어가 아니다 — 소스가 공개돼 있어
   누구나 `fetch`로 직접 부를 수 있다.
2. **기기의 능력을 하드코딩하지 않는다.** ThinQ 냉난방의 제어 가능 축(전원·온도·모드·바람)과
   값의 경계는 **등록 시점에 실기기 프로파일에서 파생**해 저장한다. 문서 예시와 실기기가
   step·모드·풍량 세 군데에서 달랐던 실측이 근거다.
3. **`power = null`은 `'OFF'`가 아니다.** null은 '모름'이고, 둘을 합치면 꺼진 줄 알았는데
   실제로는 켜져 있는 상황 — 냉난방 무한 가동 — 이 조용히 숨는다. DB · 타입 · 손님 화면 ·
   어드민 화면이 전부 이 구분을 유지한다.

### 이 스펙이 하지 않는 것 (Non-Requirements)

| 안 하는 것 | 어디로 |
|---|---|
| 예약 기반 자동화(입실 준비 · 퇴실 종료 · 스윕 · 연결 감시 · 현장 조작 감지) | `spec_reservation_automation`. 이 스펙은 **사람이 누른 명령**만 다룬다 |
| 역할 판정 · 비밀번호 · 시도 제한 · CORS 화이트리스트의 정본 서술 | `spec_admin_auth`. 여기서는 제어에 걸리는 결과만 인용한다 |
| CCTV(카메라 목록 · 자격증명 · 영상 경로) | `spec_cctv`. 같은 함수의 다른 action이다 |
| 손님 안내 문자 · 청소 문자 | `spec_guest_sms` · `spec_cleaning_sms` |
| 예약 데이터가 어디서 오는가 | `spec_reservation_sync`. 이 스펙은 예약을 **읽기만** 한다(그것도 boolean 하나로) |
| 조명 밝기 · 색온도 · 씬 | 기기가 on/off 스위치라 제어할 축 자체가 없다 |
| 기기별 타이머 · 스케줄 UI | 예약이 곧 스케줄이다. 시간에 따른 동작은 자동화가 한다 |
| 현장 설치 절차(브로커 · 에이전트 · 기기 배선) | `06-applications/control-setup.md`의 A(냉난방)·B(조명)가 정본. 절차를 두 곳에 두면 한쪽만 고쳐져 현장에서 어긋난다 |

## 기술 스택

프로젝트 공통(Supabase Edge Function `control` · Deno · supabase-js v2 from jsr · PostgreSQL ·
빌드 단계 없는 단독 HTML) + 이 스펙 고유:

- **LG ThinQ Connect Open API** — HTTP. `GET /devices` · `GET /devices/{id}/profile` ·
  `GET /devices/{id}/state` · `POST /devices/{id}/control`. 인증 헤더는 5종이다 —
  `Authorization`(PAT Bearer) · `x-country` · `x-client-id` · `x-api-key` ·
  요청마다 새로 만드는 `x-message-id`.
- **MQTT 3.1.1 (QoS 1)** — 합정 맥의 로컬 mosquitto. 토픽은 **Tasmota 기본 문법**
  `%prefix%/%topic%/%suffix%`를 그대로 쓴다.
- **Supabase Realtime** (`postgres_changes` INSERT) — 조명 명령이 서버에서 현장 맥으로 내려가는
  유일한 경로.
- **현장 에이전트** (`06-applications/control-agent/`) — Node >= 20, ESM. `mqtt@5` ·
  `ws@8`(Node 20에 네이티브 WebSocket이 없어 Realtime에 명시적으로 물린다) ·
  `@supabase/supabase-js@2`.
- **SiHAS 브리지** (`06-applications/sihas-bridge/`) — Python 3, `paho-mqtt>=2.0`(콜백 API v2),
  기기와는 로컬 UDP 502.
- 프런트: 외부 프레임워크 없음. `Paperlogy` 웹폰트만 jsDelivr에서 받는다.

## 실행 환경

- **Edge Function `control`** — Deno Deploy. 런타임 타임존은 UTC라 KST 계산은 전부
  `automation/windows.ts`(명시 `+09:00`)를 통한다. 시크릿은 `ADMIN_PASSWORD` ·
  `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `THINQ_PAT` · `THINQ_CLIENT_ID` ·
  `THINQ_API_KEY` (+선택 `THINQ_COUNTRY` · `THINQ_BASE_URL` · `THINQ_TIMEOUT_MS`).
  **값은 Supabase 시크릿에만 둔다 — 레포·문서에 쓰지 않는다.**
- **브라우저** — 손님 페이지는 모바일 우선(본문 최대 520px, 터치 타겟 48px 이상), 어드민은
  데스크톱·모바일 양쪽. 라이트/다크 테마는 `localStorage`.
- **배포** — `public/`의 심링크를 Vercel이 서빙한다(`cleanUrls: true`).
  `public/control.html -> ../06-applications/guest-control.html`,
  `public/admin.html -> ../06-applications/admin.html`.
  서버는 `supabase functions deploy control`, 스키마는 `supabase db push`.
- **합정 맥** — 상주. `control-agent`(Node)와 필요 시 `sihas-bridge`(Python)가 launchd로 돈다.
  **인바운드 포트를 열지 않는다** — MQTT는 LAN 안, Supabase 쪽은 아웃바운드 WebSocket이다.
- **CI** — `.github/workflows/test.yml`이 `supabase/**` 변경 시 `deno lint` · `deno check` ·
  `deno test --allow-env`를 돌린다(`reservation-window.test.ts` · `auth.test.ts` 포함).

## 2. 접근 제어

### 역할 판정

자격증명은 요청 본문에 실려 오고, 판정은 `auth.ts` 한 곳에서만 한다.

| 역할 | 자격증명 | 이 스펙에서 할 수 있는 것 |
|---|---|---|
| `admin` | `password` = `ADMIN_PASSWORD` | 전부 |
| `guest` | **아무것도 안 보냄** | `list` · `command`(5종) · `automate` |
| `cleaner` | `token` = `CLEANING_TOKEN` | 없음 — 청소 action 둘뿐(`spec_cleaning_sms`) |

판정 순서가 곧 계약이다. `password`를 먼저 끝까지 처리해서 **"뭔가 보냈는데 admin과 안 맞으면
401"**을 남긴다. 여기서 조용히 guest로 낮추면 어드민의 오타가 "비밀번호가 맞지 않아요"가 아니라
알 수 없는 403으로 보인다. `ADMIN_PASSWORD` 미설정은 전면 거부(503)다 — 무인증 제어로 열리는
것보다 닫혀 있는 편이 낫다.

손님이 부를 수 있는 명령은 5종 전부 열려 있다. 손님은 이미 물리 리모컨으로 온도·모드·풍량을
바꿀 수 있어서 여기서 막아도 새로 막히는 게 없고 페이지만 반쪽이 된다. **그래도 목록은 목록으로
남긴다** — `command` action 전체를 열면 다음에 명령이 하나 추가될 때(기기 초기화 같은 것)
아무도 안 본 채 손님에게까지 열린다.

손님 응답에서는 `address`(ThinQ deviceId · MQTT 토픽)를 지운다(`scrubDevices`). PAT나 LAN 없이는
쓸 수 없는 값이지만, 손님 화면이 안 쓰는 값이고 **안 내리면 안 새는** 값이다.

### 예약 시간 창 (손님 전용 게이트)

```
손님이 /control 을 연다
  │
  └─ POST /functions/v1/control  {action:"list"}          (password 없음)
       │
       ├─ resolveRole("", "") ─────────────────────────> "guest"
       ├─ assertAllowed("guest", "list") ──────────────> 통과
       └─ withinReservationWindow(sb)
            ├─ false ─> 403 {error:"지금은 예약 시간이 아니에요",
            │                 code:"outside_reservation_window"}
            └─ true  ─> 200 scrubDevices("guest", list(sb))
```

| 규칙 | 값 | 왜 |
|---|---|---|
| 구간 | `[start_time, end_time)` 반열림 | `end_time`은 스클 동기화가 이미 **배타적 상한**으로 저장한다(16~18시 이용 → `19:00`) |
| 조회 날짜 | 어제 + 오늘 (KST) | 자정을 넘긴 예약은 `date`가 어제인 채로 오늘 새벽까지 이어진다. 오늘 것만 읽으면 01:00의 손님이 자기 예약 중인데 닫힌다 |
| 대상 | `cancelled = false` | |
| 사전 개방 | **없음** | 시작 정각부터 열린다 |
| 조회 실패 | `false` (닫힘) | fail-closed. 반쯤 실패한 채 제어를 열어주는 것보다 한 번 더 새로고침하게 하는 편이 낫다 |
| 판정 함수 | `targetTime()` · `endTime()` (`automation/windows.ts`) | 예전에는 여기서 `date`·`time` 문자열을 SQL로 직접 비교했는데, 그러면 `19:00~00:00` 예약이 **진행 중에도 항상 거짓**이 된다(`00:00 > 19:00`이 거짓). 2026-08-11 실제 예약에서 손님 페이지가 예약 내내 안 열렸다 |
| admin | 게이트 없음 | 운영자는 예약과 무관하게 늘 열려 있어야 한다 |
| `automate` | **게이트 예외** | 자동화가 일해야 하는 순간은 정의상 전부 예약 구간 **밖**이다. 예외가 빠진 배포로 자동화가 두 번 죽었다(#44·#70). 상세는 `spec_reservation_automation` |

손님 페이지는 이 창이 닫혀도 **폴링을 멈추지 않는다.** 예약 시작 시각이 되면 손님이 새로고침을
누르지 않아도 열려야 하기 때문이다. 그래서 클라이언트는 `code`로 분기한다 — 메시지 문자열을
비교하면 문구가 바뀌는 순간 조용히 깨진다.

> 이 창은 "지금 예약이 진행 중인가"만 본다. **호출자가 그 예약자인지는 확인하지 않는다.**
> 남의 브라우저를 빌려 조작하는 경로는 CORS 오리진 화이트리스트가 한 겹 막는다(`_shared/cors.ts`).

## 3. 명령 5종

| 명령 | 축(capability) | 값 | 대상 |
|---|---|---|---|
| `power_on` | `power` | 없음 | 냉난방 · 조명 |
| `power_off` | `power` | 없음 | 냉난방 · 조명 |
| `set_temp` | `temp` | 숫자. `constraints.temp`의 min/max/step 검증 | 냉난방 |
| `set_mode` | `mode` | 문자열. `constraints.modes` enum | 냉난방 |
| `set_wind` | `wind` | 문자열. `constraints.wind` enum | 냉난방 |

명령은 먼저 축으로 걸린다 — `device.capabilities`에 그 축이 없으면 **기기가 못 하는 일**이므로
400이다. 조명은 `capabilities = ['power']`뿐이라 이 검사만으로 `set_*`가 전부 걸러지고, 조명
경로 코드는 전원만 다루면 된다.

값 검증은 벤더에 보내기 **전에** 우리가 한다. 범위·step 밖 값을 보내면 ThinQ가 400을 주거나 —
더 나쁘게 — 조용히 무시한다. `constraints`가 없으면(프로파일 미파생) 검증할 기준이 없으므로
**거부한다.**

### 어댑터 비대칭 — `acked` vs `sent`

```
[ThinQ · 냉난방]                        [Tasmota/SiHAS · 조명]

버튼                                    버튼
 │ POST command                          │ POST command
 ▼                                       ▼
Edge Function                           Edge Function
 │ buildControlBody()                    │ commandTopic(address,"POWER")
 │ HTTPS POST /control ──> LG 클라우드   │ INSERT device_commands (pending)
 │        200 ◀────────────  │           │        └─ id 반환
 │                           ▼           ▼
 │                         기기        {status:"sent"}   ← 여기서 응답 끝
 │ getState() 재조회                      ╎
 │ upsertState()                          ╎ Realtime INSERT
 ▼                                        ▼
{status:"acked"}                        합정 맥 에이전트
                                          │ requested_at 60초 초과? ─ 예 ─> expired (실행 안 함)
                                          │ 아니오
                                          │ mosquitto publish cmnd/<addr>/POWER
                                          ▼   └─ device_commands.status = sent
                                        기기 ── stat/<addr>/POWER ──> 에이전트
                                                                       │ upsertState()
                                                                       ▼
                                                                  device_state
```

| | ThinQ (냉난방) | Tasmota/SiHAS (조명) |
|---|---|---|
| 응답 `status` | `acked` | `sent` |
| 그 뜻 | 벤더가 200을 줬다 = 기기 반영 확인 | 큐에 넣었다. **아직 발행조차 안 됐다** |
| 실패가 보이는 곳 | 그 자리에서 400/502 | 조용할 수 있다 — 60초 뒤 `expired`로 버려진다 |
| 상태 갱신 방향 | pull. 우리가 물어봐야 안다 | push. 기기가 `stat`으로 보고한다 |
| 목록 조회 시 | TTL(기본 30초) 지나면 벤더 재조회 | 항상 최신. 물어볼 필요가 없다 |
| 명령 TTL | 없음 (동기라 개념이 없다) | 60초 (`COMMAND_TTL_MS`) |
| 합정 맥 | 무관 | 필수 |

조명의 `sent`를 `ok`로 뭉개지 않는 것이 이 설계의 핵심이다. 맥이 죽어 있으면 명령은 60초 뒤
조용히 버려지는데, 그걸 성공으로 적으면 **조명이 밤새 켜져 있는데 기록에는 "퇴실 종료 성공"만
남는다.**

### 60초 TTL — 왜 늦게라도 실행하지 않는가

맥이 몇 시간 꺼져 있다가 켜졌을 때 밀린 명령을 그대로 재생하면 **새벽 3시에 조명이 켜진다.**
사람이 그 순간에 누른 버튼이고, 그 순간은 지났다. 늦은 실행보다 미실행이 안전하다.

판정 주체는 DB가 아니라 **에이전트**다. '지금'이 에이전트 쪽 시계이고, 실제로 발행 여부를
결정하는 것도 그쪽이기 때문이다. 브로커 연결이 없으면 `pending`으로 그대로 두고, 재접속 시
`drainPending`이 다시 집는다 — 그때도 TTL을 다시 본다.

### 토픽 문법의 단일 출처

```
    cmnd  /  light_main  /  POWER
     (1)        (2)          (3)

 (1) prefix — cmnd(하행 명령) / stat(상행 결과) / tele(상행 텔레메트리·LWT)
 (2) 기기 ID = Tasmota의 `Topic` 설정값 = devices.address
 (3) 서브토픽 — POWER / RESULT / LWT / STATE ...
```

**토픽을 아는 곳은 `tasmota/topics.ts` 하나다.** Edge Function이 `topic`·`payload`를 완성해
`device_commands.payload`에 넣고, 에이전트는 그것을 그대로 발행한다. 에이전트가 따로 조립하게
하면 양쪽 문법이 어긋나는 순간 명령이 **에러 없이 조용히** 사라진다.

`validateDeviceId()`는 등록 시점에 주소를 검사한다 — 빈 값 · 와일드카드(`+` `#`) · `/` ·
영숫자·`_`·`-` 외 문자 · 32자 초과를 거부한다. 와일드카드를 막는 게 핵심이다: 구독이 남의 기기
토픽까지 빨아들이고, 발행에는 쓸 수 없어 브로커가 거부하거나 **의도치 않은 다수 기기에 명령이
간다**(조명 전체가 한꺼번에 켜지는 식). 등록 시점이 이걸 막을 수 있는 가장 싼 지점이다.

> Space(원본)는 여기에 `space_id` 세그먼트를 하나 더 끼웠다. 그건 AWS IoT라는 **공용 브로커**를
> 여러 공간이 나눠 썼기 때문이다. 여기 브로커는 합정 맥 위의 전용 로컬 브로커라 나눠 쓸 상대가
> 없어 세그먼트를 하나 줄였다(설정 실수 여지 감소).

### SiHAS 브리지 — 백엔드가 몰라도 되는 세 번째 기기

SiHAS SQM-300 스위치는 로컬 UDP(포트 502) 커스텀 프로토콜만 안다. 이 브리지가 현장 맥에서
상시 돌며 UDP를 MQTT로 번역하는데, **Tasmota가 쓰는 것과 문자 하나 다르지 않은 토픽 계약을
흉내 낸다.**

| 토픽 | 방향 | payload |
|---|---|---|
| `cmnd/<address>/POWER` | 브리지가 구독 | `ON`/`OFF` = 명령, **빈 값 = 상태 질의**(전원 불변) |
| `stat/<address>/POWER` | 브리지가 발행 | `ON`/`OFF` = 실측 상태 |
| `tele/<address>/LWT` | 브리지가 발행 | `Online`/`Offline`, retained (+ MQTT will) |

그래서 DB에는 `adapter = 'tasmota'`로 등록하고, `supabase/functions/control/`·`admin.html`은
**단 한 줄도 바뀌지 않는다.** 어드민의 "+ 조명 추가"에 브리지 `config.json`의 `address`를 그대로
넣으면 끝이다. 주소는 두 곳(브리지 설정 · 등록한 기기 ID)에서 일치해야 하고, 어긋나면 명령이
에러 없이 사라진다 — 브리지가 기동 시 자기 토픽을 로그에 찍는 이유다.

브리지 내부 동작(명령 후 0.5초/1.2초 재확인, 30초 폴링, UDP 직렬화, 재접속 backoff)은
`sihas-bridge/README.md`가 정본이다. 이 스펙에서 중요한 것은 **백엔드가 그 존재를 모른다**는
한 줄이다.

## 4. 손님 페이지 (`/control`)

### 열려 있을 때

```
┌───────────────────────────────────────────┐
│                                    [ 🌙 ] │  ← 테마 토글(고정)
│              TYPE LOUNGE                  │
│               조명 · 냉난방               │
│                                           │
│  전체                                     │
│  ┌─────────────────┬─────────────────┐    │
│  │    전체 켜기    │    전체 끄기    │    │
│  └─────────────────┴─────────────────┘    │
│  ┌───────────────────────────────────┐    │
│  │            나이트모드             │    │
│  └───────────────────────────────────┘    │
│                                           │
│  기기                                     │
│  ┌───────────────────────────────────┐    │
│  │ 메인 조명 (SiHAS)                 │    │
│  │ 켜짐 · 12초 전                    │    │
│  │ ┌───────────────┬───────────────┐ │    │
│  │ │    켜기 ●     │     끄기      │ │    │
│  │ └───────────────┴───────────────┘ │    │
│  └───────────────────────────────────┘    │
│  ┌───────────────────────────────────┐    │
│  │ 에어컨                            │    │
│  │ 켜짐 · 3초 전 · 현재 27C          │    │
│  │ ┌───────────────┬───────────────┐ │    │
│  │ │    켜기 ●     │     끄기      │ │    │
│  │ └───────────────┴───────────────┘ │    │
│  │ ┌──────┬─────────────────┬──────┐ │    │
│  │ │  −   │       24        │  +   │ │    │
│  │ └──────┴─────────────────┴──────┘ │    │
│  │ 희망 온도 18~30C. 숫자를 직접     │    │
│  │ 적고 Enter를 눌러도 바뀌어요.     │    │
│  │ 모드                              │    │
│  │ ┌──────┬──────┬──────┬──────┐     │    │
│  │ │ 냉방●│ 난방 │ 송풍 │ 제습 │     │    │
│  │ └──────┴──────┴──────┴──────┘     │    │
│  │ 바람 세기                         │    │
│  │ ┌──────┬──────┬──────┬──────┐     │    │
│  │ │  약  │  중  │ 강 ● │ 자동 │     │    │
│  │ └──────┴──────┴──────┴──────┘     │    │
│  └───────────────────────────────────┘    │
│  ┌───────────────────────────────────┐    │
│  │           상태 새로고침           │    │
│  └───────────────────────────────────┘    │
│  ─────────────────────────────────────    │
│  냉난방은 여기서 온도·모드·바람 세기까지  │
│  맞추실 수 있어요. 거울 선반 위 작은      │
│  흰색 리모컨을 쓰셔도 돼요.               │
│  조명은 명령을 보낸 뒤 실제로 반영되기    │
│  까지 몇 초 걸릴 수 있어요.               │
│  나가실 때 전체 끄기를 한 번 눌러 주시면  │
│  큰 도움이 돼요.                          │
└───────────────────────────────────────────┘
```

### 예약 시간 밖일 때

```
┌───────────────────────────────────────────┐
│                                    [ 🌙 ] │
│              TYPE LOUNGE                  │
│               조명 · 냉난방               │
│  ┌───────────────────────────────────┐    │
│  │ 지금은 예약 시간이 아니에요.      │    │ ← 서버 문구, textContent로만
│  │                                   │    │
│  │ 예약 시간이 되면 이 화면이 자동   │    │
│  │ 으로 열려요. 화면을 열어 둔 채    │    │
│  │ 잠시만 기다려 주세요.             │    │
│  │                                   │    │
│  │ 이용 안내 보기 →                  │    │
│  └───────────────────────────────────┘    │
│                                           │
│  (전체 · 기기 · 푸터 영역 전부 숨김)      │
└───────────────────────────────────────────┘
```

서버 문구는 신뢰 경계 밖이라 `textContent`로만 넣는다. 그 아래 안내와 링크는 우리가 만드는 고정
노드다. 막다른 화면으로 느끼지 않도록 "기다리면 열린다"를 명시한다 — 실제로 폴링이 계속 돌아
시작 시각에 자동으로 열린다.

### 섹션별 상세

#### 전체 켜기 / 전체 끄기

- **기능**: `capabilities`에 `power`가 있는 기기 전부에 `power_on`/`power_off`를 **병렬로** 보낸다.
- **UI**: **끄기만 확인창을 받는다**("기기 N개를 모두 끌까요?"). 켜기는 바로 실행된다 —
  아직 쓰는 사람이 있는데 눌리면 곤란한 쪽은 끄기다. (어드민은 켜기·끄기 **둘 다** 확인을
  받는다. 운영자는 손님이 있는 시간에도 누를 수 있어서다.)
- **부분 실패**: 일부가 실패해도 나머지는 계속 보낸다. 반쯤 꺼진 채 포기하면 손님이 뭐가
  남았는지 모른다. 끝나면 실패한 기기 **이름만** 모아 안내한다.
- **첫 로드 잠금**: 첫 `list` 응답 전에는 캐시가 빈 배열이라 누르면 "기기가 없어요"라는 거짓
  오류가 뜬다. 첫 조회가 끝날 때까지 버튼 3개를 `disabled`로 둔다.

#### 나이트모드

- **기능**: `kind === 'light'` 중 **SiHAS 계열은 끄고 나머지 조명은 켠다.** 냉난방은 건드리지
  않는다.
- **SiHAS 판별**: `/sihas/i.test(d.name)` — **기기 이름의 문자열**이 유일한 표식이다. DB에는
  `kind='light'`만 있고 벤더 구분 컬럼이 없다(브리지가 백엔드에 Tasmota로 위장하는 게 설계
  원칙이므로 앞으로도 생기지 않는다). 등록할 때 이름에 SiHAS를 넣어 두는 것이 계약이다.
- **UI 문구**: 손님에게 벤더명은 의미가 없어 **결과로 말한다** — "영화·모임에 맞게 메인 조명은
  끄고 무드 조명만 켤까요? 냉난방은 그대로 둬요." (어드민은 "SiHAS 조명 N개는 끄고..."처럼
  기기 구성 그대로 보여준다.)

#### 기기 카드

| 요소 | 내용 |
|---|---|
| 이름 | `device.name` |
| 메타 줄 | `전원 라벨 · 상태 라벨 · 현재 NNC` — 이상 상태면 경고색 |
| 전원 | `power` 축이 있으면 켜기/끄기 토글. 없으면 "이 기기는 여기서 켜고 끌 수 없어요." |
| 목표온도 | `temp` 축 + `constraints.temp`가 있을 때만 |
| 모드 · 바람 세기 | 해당 축 + enum 목록이 비어 있지 않을 때만 |

조명은 `capabilities = ['power']`이라 전원 줄만 붙고 나머지 세 줄은 통째로 건너뛴다.

**빈 목록**: "아직 연결된 기기가 없어요. 냉난방은 거울 선반 위 작은 흰색 리모컨으로 조절하실 수
있어요." — 벽 스위치를 권하지 않는다. 게스트 가이드가 수동 조작을 고장·비용 청구로 경고하고
있어 정면으로 충돌한다.

#### 온도 조절

| 항목 | 규칙 | 왜 |
|---|---|---|
| 버튼 한 번의 이동 폭 | **1도** (`max(1, step)`) | 에어컨 프로파일 step은 0.5인데, 그대로 쓰면 한 번 눌러 0.5도가 움직여 두 번씩 눌러야 한다. 1은 0.5의 배수라 서버 검증을 그대로 통과한다 |
| 서버 검증 기준 | **프로파일 step 그대로**(0.5) | 화면 편의로 기기 계약을 바꾸지 않는다 |
| 직접 입력 | clamp(min,max) → step 격자에 snap → 소수 2자리 반올림 | `27.2`를 적으면 `27`이 간다는 걸 **보내기 전에** 칸에 되돌려 보여준다. 부동소수 꼬리(`25.700000000000003`)가 남으면 서버의 `(값-min)/step` 정수 검증이 그걸로 떨어진다 |
| 전송 시점 | `change`(포커스 이탈)에서만 | `input`에서 보내면 `25`를 치는 중간의 `2`가 명령으로 나간다 |
| Enter | `preventDefault` 후 `blur()` | 뒤따르는 `change`가 보낸다. 여기서도 보내면 같은 명령이 두 번 간다 |
| 스피너 | 숨김 | 48px 타겟 안의 2px 화살표는 손가락으로 못 누른다 |

#### 모드 · 바람 세기

값은 기기 프로파일이 준 enum **원값 그대로** 보내고 라벨만 한글로 바꾼다. 한글을 보내면 서버
enum 검증이 자른다.

| 축 | 라벨 매핑 |
|---|---|
| 모드 | `COOL`=냉방 · `HEAT`=난방 · `FAN`=송풍 · `AIR_DRY`=제습 · `AIR_CLEAN`=공기청정 |
| 바람 | `LOW`=약 · `MID`=중 · `HIGH`=강 · `AUTO`=자동 · `POWER`=강력 |

**모르는 값은 원값 그대로 보여준다.** 목록은 기기 프로파일에서 오므로 여기 없는 모드가 생길 수
있고, 그때 버튼을 숨기면 기기가 할 수 있는 일을 손님만 못 하게 된다.

#### 상태 표시 규칙

| DB 상태 | 손님 화면 | 어드민 화면 |
|---|---|---|
| `power = 'ON'` | 켜짐 | 켜짐 |
| `power = 'OFF'` | 꺼짐 | 꺼짐 |
| `power = null` | **상태 모름** | **상태 모름** |
| `updated_at = null` | "아직 상태를 받은 적 없어요" | 같음 |
| `online = false` | "연결 끊김" + 마지막 보고 시각 | 같음 |
| `updated_at`이 600초 초과 | `is_stale` — 메타 줄을 경고색으로 | 같음 |

`never_seen`과 `is_stale`을 섞지 않는다. 한 번도 못 들은 기기를 '갱신 끊김'으로 보이면 마치
예전엔 정상이었던 것처럼 읽힌다.

#### 갱신 주기

| 시점 | 동작 | 왜 |
|---|---|---|
| 명령 직후 | 즉시 `list` | |
| 명령 4초 뒤 | 한 번 더 `list` (`LATE_REFRESH_MS`) | 조명의 응답은 '보냈다'지 '켜졌다'가 아니다. 실제 반영을 따라잡는다 |
| 30초마다 | **탭이 보일 때만** `list` (`POLL_MS`) | 손님 휴대폰 배터리와 데이터를 조용히 태울 이유가 없다 |
| 탭 복귀 | 즉시 `list` | |
| 예약 시간 밖 | 폴링 **유지** | 시작 시각에 자동으로 열려야 한다 |

## 5. 어드민 공간 제어 탭 (`/admin`)

```
┌──────────────┬────────────────────────────────────────────┐
│ 예약관리     │  ┌──────────────────┬──────────────────┐    │
│ 공간 제어 ●  │  │    전체 켜기     │    전체 끄기     │    │
│ CCTV         │  └──────────────────┴──────────────────┘    │
│ 공간 지원신청│  ┌─────────────────────────────────────┐    │
│ 지원금 신청  │  │             나이트모드              │    │
│              │  └─────────────────────────────────────┘    │
│              │  기기                                       │
│              │  ┌─────────────────────────────────────┐    │
│              │  │ 에어컨               [ 등록 해제 ]  │    │
│              │  │ 켜짐 · 8초 전 · 현재 27C            │    │
│              │  │ 전원      [켜기 ●][끄기]            │    │
│              │  │ 목표온도 (18~30C, 1C 단위)          │    │
│              │  │           [−][  24  ][+]            │    │
│              │  │ 모드      [COOL ●][HEAT][FAN][...]  │    │
│              │  │ 풍량      [LOW][MID][HIGH ●][...]   │    │
│              │  └─────────────────────────────────────┘    │
│              │  ┌─────────────────────────────────────┐    │
│              │  │ 메인 조명(SiHAS)     [ 등록 해제 ]  │    │
│              │  │ 꺼짐 · 41초 전                      │    │
│              │  │ 전원      [켜기][끄기 ●]            │    │
│              │  └─────────────────────────────────────┘    │
│              │  [ + 냉난방 기기 추가 ]                     │
│              │  [ + 조명 추가 ]                            │
└──────────────┴────────────────────────────────────────────┘
```

어드민은 모드·풍량을 **원값 그대로**(`COOL`·`HIGH`) 보여준다. 손님 화면과 반대인데 의도한
차이다 — 여기는 기기가 뭐라고 대답했는지 그대로 보여야 하는 화면이다.

### 등록 모달

```
  + 냉난방 기기 추가                      + 조명 추가
┌─────────────────────────────┐       ┌─────────────────────────────┐
│ 냉난방 기기 추가        [✕] │       │ 조명 추가               [✕] │
│ LG ThinQ 계정에 등록된 기기를│       │ 이름                        │
│ 불러옵니다. 서버에 PAT가     │       │ [ 예: 메인 조명           ] │
│ 설정돼 있어야 합니다.        │       │ Tasmota Topic               │
│ ┌─────────────────────────┐ │       │ [ 예: light_main          ] │
│ │ 거실 에어컨             │ │       │ 기기 Console에 Topic으로    │
│ │ DEVICE_AIR_CONDITIONER  │ │       │ 넣은 값입니다(영숫자·_·-,   │
│ │              [ 등록 ]   │ │       │ 32자 이내). 조명은 합정     │
│ ├─────────────────────────┤ │       │ 에이전트가 켜져 있어야      │
│ │ 안방 에어컨   등록됨    │ │       │ 동작합니다(냉난방은 무관).  │
│ └─────────────────────────┘ │       │ (오류 메시지 자리)          │
│ [ 다시 불러오기 ]           │       │ [ 조명 추가 ]               │
└─────────────────────────────┘       └─────────────────────────────┘
```

| 단계 | 냉난방(ThinQ) | 조명(Tasmota/SiHAS) |
|---|---|---|
| 후보 목록 | `thinq_devices`로 LG 계정 기기를 불러온다. `deviceId`는 사람이 알아볼 수 없어 **별칭·타입·모델**과 함께 보여주고 고르게 한다 | 없다. 사람이 주소를 직접 입력한다 |
| 이미 등록된 것 | `devicesCache`의 `address`와 대조해 "등록됨"으로 표시(버튼 없음) | 중복은 서버가 막는다 |
| 이름 | `prompt`로 받고 기본값은 LG 별칭 | 폼 입력 |
| capabilities · constraints | **서버가 프로파일을 읽어 파생한다.** 클라이언트가 준 값은 쓰지 않는다 | 항상 `['power']` · `constraints = null`. 읽을 프로파일이 없다 |
| 주소 검증 | `/^[A-Za-z0-9_-]{1,128}$/` — URL 경로에 그대로 박히므로 `/`·`..`·공백을 막는다 | `validateDeviceId()` — 와일드카드·`/`·32자 |
| 실패 시 모달 | 알림에 사유 | **열어둔 채** 안에 사유를 남긴다 — 닫으면 뭐가 틀렸는지 볼 수 없다 |

프로파일에서 **쓰기 가능한 축만** capabilities에 넣는다. ThinQ 리프는
`{"type":..., "value":{"r":..., "w":...}}` 꼴이고, `value`에 `w` 키가 있어야 쓰기 가능이다.
`['r']`뿐인 속성(`currentTemperature` 등)을 제어하려 들면 400이다.

| 프로파일 경로 | 축 | 파생되는 제약 |
|---|---|---|
| `operation.airConOperationMode` | `power` | 없음 |
| `temperature.targetTemperature` | `temp` | `{min, max, step, unit}` — step 없으면 1, unit 없으면 `temperature.unit` → `'C'` |
| `airConJobMode.currentJobMode` | `mode` | 문자열 배열 |
| `airFlow.windStrength` | `wind` | 문자열 배열 |

온도의 min/max/step이 숫자가 아니면 **온도 축만 건너뛴다** — 등록 전체를 실패시키지 않는다.
쓰기 가능한 축이 하나도 없으면 "이 기기에서 제어 가능한 항목을 찾지 못했습니다"로 400.

### 등록 해제

확인창("이 기기의 등록을 해제할까요? 기기 자체는 그대로예요.") 후 `devices` 행을 지운다.
`device_state`·`device_commands`는 `on delete cascade`로 함께 사라진다. 기기 자체는 그대로다 —
우리 인벤토리에서만 빠진다.

`address`는 등록 후 불변이다. 주소가 바뀌면 그건 '다른 기기'이고, `device_state`가 `device_id`에
매달려 있어 주소만 갈아끼우면 이전 기기의 상태가 새 기기 것인 척 남는다. 바꾸려면 해제 후
재등록한다.

### 다시 그리기 가드

제어 화면을 보고 있을 때 15초마다 `list`를 다시 부른다. 하지만 **다시 그리지 않는 조건**이 둘이다.

| 조건 | 안 그리면 무슨 일이 | 그리면 무슨 일이 |
|---|---|---|
| `ctlBusy > 0` (명령이 도는 중) | 상태 글자가 최대 15초 낡는다 | 눌러서 `disabled`된 버튼이 **활성 클론**으로 갈려 같은 명령이 두 번 나간다 |
| 목록 안에 포커스가 있다 | 같음 | 타이핑 중이던 온도 값이 `change` 이벤트도 없이 사라진다 |

명령이 끝나면 곧바로 `refreshDevices()`가 불려 그때 정확한 값으로 맞춰진다. 그래서 낡음은
최대 한 주기이고 자동으로 회복된다.

## 6. 데이터 모델

```typescript
export type DeviceKind = "light" | "hvac";
export type AdapterName = "tasmota" | "thinq";

export type Command =
  | "power_on"
  | "power_off"
  | "set_temp"   // hvac 전용
  | "set_mode"   // hvac 전용
  | "set_wind";  // hvac 전용

/** sent = 벤더/브로커가 받음(기기 실행은 미확인) · acked = 기기 반영 확인 */
export type CommandStatus = "sent" | "acked";

/** 목표온도가 받을 수 있는 범위. ThinQ 프로파일 targetTemperature.value.w에서 파생. */
export interface TempRange {
  min: number;
  max: number;
  step: number;
  unit: string;
}

/** 기기가 받아들이는 값의 경계. UI 렌더의 근거이기도 하다.
 *  null/빈 배열 = 그 축을 쓰지 못함. */
export interface DeviceConstraints {
  temp?: TempRange | null;
  modes?: string[];
  wind?: string[];
}

export interface Device {
  id: string;             // uuid
  name: string;           // 사람이 부르는 이름
  kind: DeviceKind;
  adapter: AdapterName;
  address: string;        // tasmota=MQTT 토픽 세그먼트 / thinq=벤더 deviceId. 등록 후 불변
  capabilities: string[]; // 쓰기 가능한 축만: power / temp / mode / wind
  constraints: DeviceConstraints | null;  // tasmota는 항상 null
}

export interface DeviceState {
  device_id: string;
  online: boolean;
  power: "ON" | "OFF" | null;   // ⚠ null = '모름'. 'OFF'와 다르다 (아래 참조)
  attrs: Record<string, unknown>;
  reported_at: string | null;   // 기기/벤더 보고 시각. ThinQ에는 없다
  updated_at: string | null;    // null = 이 기기로부터 한 번도 상태를 받은 적 없음
}

/** 갱신이 끊긴 지 이 시간을 넘으면 캐시를 믿지 말라는 신호. */
export const STALE_AFTER_SECONDS = 600;

export function isStale(state: DeviceState): boolean;   // updated_at === null 이면 false
export function neverSeen(state: DeviceState): boolean; // updated_at === null
```

`attrs`에 담기는 키(ThinQ 상태에서 파생, 값이 있을 때만 넣는다):

| 키 | 원천 | 예 |
|---|---|---|
| `mode` | `airConJobMode.currentJobMode` | `"COOL"` |
| `target_temp` | `temperature.targetTemperature` | `24` |
| `current_temp` | `temperature.currentTemperature` | `27` |
| `unit` | `temperature.unit` | `"C"` |
| `wind` | `airFlow.windStrength` | `"HIGH"` |

### `power = null`을 `'OFF'`로 합치지 않는 이유

합치면 **꺼진 줄 알았는데 실제로는 켜져 있는 상황 — 냉난방이 밤새 도는 상황 — 이 조용히 숨는다.**
손님 화면이라고 다르지 않다. 그래서:

- DB 컬럼은 `text check (power in ('ON','OFF'))` — nullable로 두고 기본값을 주지 않는다.
- ThinQ 파서는 `operation.airConOperationMode`가 없거나 낯선 값이면 `null`로 남긴다.
- 조명 상행 파서는 LWT(`Online`/`Offline`)를 받아도 `power`를 **건드리지 않는다.**
  `mergeState()`가 델타의 `null` 축에 기존값을 유지한다 — 이걸 안 하면 LWT 하나가 마지막
  전원값을 지운다.

### `updated_at` 기본값을 `now()`로 주지 않는 이유

상태 행이 없거나 `updated_at`이 비어 있으면 = **한 번도 상태를 받은 적 없음**이다. 여기에 지금
시각을 채우면 "방금 갱신됨"이라는 거짓말이 되고, 화면이 '0초 전'이라 표시해 신선한 상태처럼
보인다. `never_seen`과 `is_stale`을 나눈 것도 같은 이유다.

### 명령 큐 행

```typescript
interface DeviceCommandRow {
  id: string;                  // uuid
  device_id: string;
  command: string;             // 'power_on' | 'power_off'  (조명은 전원뿐)
  payload: { topic: string; payload: "ON" | "OFF" };  // Edge Function이 완성해 넣는다
  status: "pending" | "sent" | "expired" | "failed";
  error: string | null;
  requested_at: string;        // TTL 판정 기준 (에이전트 시계로 60초)
  sent_at: string | null;
}
```

| status | 뜻 |
|---|---|
| `pending` | 에이전트가 아직 안 집어감 |
| `sent` | mosquitto에 발행됨 |
| `expired` | 60초를 넘긴 명령 — **실행하지 않고 버림** |
| `failed` | 발행 시도했으나 실패(또는 `topic`/`payload` 누락 = 계약 위반) |

### `list` 응답

```typescript
interface ListResponse {
  thinq_configured: boolean;   // PAT·clientId·apiKey 셋이 다 있는가
  devices: Array<Device & {    // guest 응답에서는 address가 빠진다
    state: DeviceState & { is_stale: boolean; never_seen: boolean };
  }>;
}
```

`is_stale`·`never_seen`은 파생값이라 DB에 없다. UI가 '모름'과 '끊김'을 구분하려면 필요해서
응답에서 계산해 붙인다.

## 7. 데이터 저장 구조

```
devices                        ← 기기 인벤토리
  unique (adapter, address)    ← 중복 등록 방지. 위반(23505) → "이미 등록된 기기입니다"
  │
  ├── device_state             ← 1:1, on delete cascade. 마지막 알려진 상태 캐시
  └── device_commands          ← 1:N, on delete cascade. 조명 명령 큐 + 감사 로그
        index (status, requested_at) where status='pending'
        publication supabase_realtime  ← 에이전트가 INSERT를 밀어서 받는다
```

세 테이블 모두 **RLS를 켜되 정책을 하나도 만들지 않는다** = anon 키로는 읽기도 쓰기도 불가능하다.
접근 경로는 service_role을 쓰는 Edge Function과 현장 에이전트뿐이다. 예약과 이유가 다르다 —
예약은 읽히면 손님 정보가 새는 정도지만, **기기 제어는 소스만 본 사람이 손님 이용 중에
조명·냉난방을 끌 수 있다.** 게다가 ThinQ PAT는 절대 브라우저에 내려가면 안 되므로 어차피 서버
경유가 강제된다.

> 조회는 전부 `device_state`에서 읽는다 — 목록을 그릴 때 기기를 실시간으로 찌르지 않는다.
> 오프라인 기기 하나가 요청 전체를 타임아웃까지 잡는 것을 막기 위한 설계다.

### 왜 큐 + Realtime인가

합정 맥은 NAT 뒤라 Edge Function이 직접 MQTT를 쏠 수 없다. 그래서 서버는 행을 넣기만 하고,
에이전트가 **아웃바운드 WebSocket**으로 그 INSERT를 받아 로컬 mosquitto에 발행한다.
포트포워딩·DDNS·터널이 전부 불필요하고 인바운드 개방은 0이다.

폴링을 안 쓰는 이유는 비용이다. 조명 반응이 1초 안이어야 쓸 만한데, 1초 폴링이면 월 260만
호출로 Supabase 무료 한도(50만)를 넘는다. Realtime은 상시 연결 하나다.

부산물로 **감사 로그가 자동으로 남는다.** 이 테이블이 전송 경로 그 자체라서, "누가 어떤 기기에
무슨 명령을 눌렀나"가 따로 적지 않아도 쌓인다. (원본 Space에는 같은 테이블이 있었지만 어느
경로도 거기에 쓰지 않아 기록이 통째로 비어 있었다.)

## 8. 기술 구현

### 서버 (Edge Function `control`)

```
supabase/functions/control/
  index.ts                  ← HTTP 표면만: CORS · 인증 · 시간 창 · 라우팅 · 직렬화
  auth.ts                   ← resolveRole / assertAllowed / scrubDevices  (정본: spec_admin_auth)
  reservation-window.ts     ← withinReservationWindow — 손님 시간 창의 유일한 판정
  devices.ts                ← devices·device_state 읽기/쓰기 + enqueueCommand (service_role)
  types.ts                  ← Device · DeviceState · Command · isStale · neverSeen
  handlers/
    shared.ts               ← HandlerError · thinqClient · thinqConfigured
    list.ts                 ← list() — 캐시 읽고 ThinQ만 TTL 넘으면 갱신
    command.ts              ← command() — 축 검증 → 어댑터 분기 → acked / sent
    registry.ts             ← thinqDevices · registerThinq · registerLight · remove
  thinq/
    client.ts               ← HTTP 클라이언트. 헤더 5종 · 상태코드→예외 · 제한적 재시도
    profile.ts              ← parseProfile: 프로파일 → [capabilities, constraints]
    commands.ts             ← buildControlBody + 범위/enum 검증
    state.ts                ← toDeviceState: ThinQ state JSON → DeviceState
  tasmota/
    topics.ts               ← validateDeviceId · commandTopic. 토픽 문법의 유일한 출처
  automation/dispatch.ts    ← issue() — 모든 기기 명령이 지나가는 하나의 문(장부 기록)
```

**모든 기기 명령은 `automation/dispatch.ts`의 `issue()`를 지난다.** `command()`를 직접 부르면
그 조작은 장부(`device_events`)에 안 남고, 나중에 그 변화가 '설명할 명령이 없는 변화' =
현장 조작으로 잘못 잡힌다. `issue()`는 역할을 출처로 받아 `remote_admin`/`remote_guest`로
구분해 적는다 — 어드민이 누른 것과 손님이 누른 것은 읽는 사람에게 전혀 다른 정보다.
(장부 자체는 `spec_reservation_automation`.)

### 목록 조회의 TTL

```
list(sb, thinqMaxAgeSeconds = 30, errorSink?)
  │
  ├─ db.listDevices()                    ← 캐시 한 번 읽기. 기기 부하 0
  └─ thinq 기기가 있고 설정돼 있으면:
       각 기기마다  fresh(state, maxAge)?
         예   → 캐시 그대로
         아니오 → client.getState() → upsertState()
           실패 → 마지막 값 유지 + online=false   ← '지금은 모른다'이지 '꺼졌다'가 아니다
```

조명(Tasmota)은 상태가 MQTT로 밀려 올라오므로 이 값과 무관하게 항상 최신이다. TTL은 ThinQ에만
적용된다. 자동화 틱은 보는 사람이 없어 더 느슨한 값을 넘긴다(`spec_reservation_automation`).

`errorSink`가 **반환값이 아니라 매개변수**인 이유: `list()`의 결과는 손님·어드민 양쪽에 그대로
내려간다. 여기 새 필드를 반환하면 그게 공개 응답에 얹힌다.

### ThinQ 클라이언트의 오류 매핑

| 응답 | 예외 | 우리 동작 |
|---|---|---|
| 200 | — | `response` 페이로드를 벗겨 반환 |
| 400 | `ThinQBadRequest` | 400 "기기가 명령을 거부했습니다". **재시도 안 함**(같은 요청은 또 400) |
| 401 | `ThinQAuthError` | 502 "ThinQ 인증 실패 — PAT 갱신이 필요합니다". **재시도 금지** — 자동 재발급 경로가 없고 계정 잠금 위험만 만든다 |
| 그 외·타임아웃·네트워크 | `ThinQUnavailable` | 1회만 재시도 후 502. 사용자가 버튼 앞에서 기다리고 있어 백오프가 무의미하다 |

제어 성공 직후의 상태 재조회 실패는 **삼킨다.** 명령은 이미 성공했는데 상태 반영 실패가 그걸
실패로 보이게 하면 사용자가 같은 명령을 또 누른다.

### 현장 에이전트 (`control-agent`)

```
06-applications/control-agent/src/
  index.js       ← 부트: 기기 로드 → MQTT 연결 → Realtime 구독 → 5분마다 재로드
  config.js      ← 환경변수 검증(없으면 기동 실패) · COMMAND_TTL_MS = 60_000
  devices.js     ← DeviceRegistry — address→기기 캐시, 상태·명령 쓰기 (service_role)
  mqtt.js        ← connectMqtt(QoS 1) · publish · queryInitialState
  commands.js    ← isExpired · executeCommand · drainPending · subscribeCommands
  state.js       ← parseTopic · parsePayload · mergeState (상행 파싱)
```

| 방향 | 흐름 |
|---|---|
| 하행(명령) | Supabase Realtime INSERT → TTL 검사 → `mosquitto publish cmnd/<addr>/POWER` → `status='sent'` |
| 상행(상태) | `stat/+/#`·`tele/+/#` 구독 → 델타 파싱 → 기존 상태와 병합 → `device_state` upsert |

- **접속(재접속 포함) 직후 초기 상태를 질의한다.** Tasmota에서 **빈 payload는 '설정'이 아니라
  '질의'**다 — 전원을 바꾸지 않고 현재값만 되돌려준다. 이게 없으면 기기가 스스로 보고할 때까지
  화면이 '아직 상태를 받은 적 없음'으로 남는다.
- **재구독 성공 시 밀린 `pending`을 한 번 훑는다.** 끊겨 있던 동안의 INSERT는 못 받았기
  때문이다. 대부분 만료로 버려지는 게 정상이다.
- 우리 문법이 아닌 토픽, 전원과 무관한 텔레메트리(`SENSOR` 등), DB에 없는 주소는 **조용히
  무시한다** — 오류가 아니라 '내 것이 아님'이다.
- 이 맥에 service_role 키와 브로커 비밀번호가 있다 = **맥 자체가 신뢰 경계**다.

### 프런트

두 HTML은 빌드 없이 각자 단독 배포물이라 스타일·헬퍼(`tempStep`·`snapTemp`·`timeAgo`·
`powerLabel`·`isSihasLight`)가 **의도적으로 중복**돼 있다. 공유 파일을 만들지 않은 이유는
번들러가 없어서다. 대신 **한쪽만 고치면 같은 기기가 두 페이지에서 다르게 움직인다** — 온도
단위·SiHAS 판별처럼 값에 영향을 주는 헬퍼를 고칠 때는 반드시 양쪽을 함께 본다. 색·타이포 토큰의
정본은 `03-identity/design-tokens.md`다.

## 9. API

엔드포인트는 하나다: `POST {SUPABASE_URL}/functions/v1/control`. 본문의 `action`으로 갈린다.
`GET`을 포함한 다른 메서드는 405, JSON이 아니면 400.

| action | 역할 | 요청 | 응답 |
|---|---|---|---|
| `list` | admin · guest | — | `{thinq_configured, devices[]}` (guest는 `address` 제거) |
| `command` | admin · guest | `device_id` · `command` · `value?` | `{device_id, command, status}` (+조명은 `command_id`) |
| `thinq_devices` | admin | — | `{devices: [{device_id, alias, type, model}]}` |
| `register` | admin | `address`(ThinQ deviceId) · `name` | `{device}` |
| `register_light` | admin | `address`(토픽 세그먼트) · `name` | `{device}` |
| `delete` | admin | `device_id` | `{ok: true}` |

| 상태 | 언제 |
|---|---|
| 400 | 알 수 없는 action · 값 검증 실패 · 축 미지원 · 주소 문법 위반 · 중복 등록 |
| 401 | 자격증명을 보냈는데 안 맞음 |
| 403 | 손님이 허용 밖 action/command · **예약 시간 밖**(`code: "outside_reservation_window"`) |
| 404 | 없는 기기 |
| 429 | 시도 제한(자격증명을 보낸 요청만 센다 — `spec_admin_auth`) |
| 502 | ThinQ 인증 실패 · 벤더 이상 · 프로파일 조회 실패 |
| 503 | `ADMIN_PASSWORD` 미설정 · ThinQ 미설정 |

오류 본문은 `{error: "..."}`이고, 시간 창만 `code`를 추가로 준다. 클라이언트가 안내 문구를
바꾸는 유일한 분기점이라 문자열 비교를 피하려고 넣었다.

## 10. 의존성

| 스펙 | 무엇에 기대는가 |
|---|---|
| `spec_admin_auth` | 역할 판정(`resolveRole`) · 손님 허용 목록 · `scrubDevices` · 시도 제한 · CORS. 이 스펙의 모든 접근 제어 서술은 거기서 인용한 것이다 |
| `spec_reservation_automation` | `automate` action(게이트 예외) · `device_events` 장부 · 자동 준비/종료가 같은 `issue()` 문을 지난다는 계약 |
| `spec_reservation_sync` | `reservations`의 `date`·`start_time`·`end_time`·`cancelled`. 시간 창이 읽는 유일한 데이터이고, `end_time`이 **배타적 상한**이라는 전제가 여기서 온다 |
| `spec_cctv` | 같은 Edge Function을 공유한다. 기기 제어와 무관하지만 `index.ts`의 라우팅·CORS를 함께 쓴다 |

## 파일(페이지) 구성

| 파일 | 경로 | 역할 |
|---|---|---|
| `guest-control.html` | `06-applications/guest-control.html` | 손님 제어 페이지. `public/control.html` 심링크로 `/control`에 배포 |
| `admin.html` | `06-applications/admin.html` | 어드민. "공간 제어" 탭이 이 스펙 범위(제어·등록 모달·15초 폴링) |
| `index.ts` | `supabase/functions/control/index.ts` | HTTP 표면. 인증·시간 창·action 라우팅 |
| `auth.ts` | `supabase/functions/control/auth.ts` | 역할 판정·손님 허용 목록·`scrubDevices` |
| `reservation-window.ts` | `supabase/functions/control/reservation-window.ts` | 손님 시간 창 판정(자정 넘김·fail-closed) |
| `devices.ts` | `supabase/functions/control/devices.ts` | `devices`·`device_state` 접근 + `enqueueCommand` |
| `types.ts` | `supabase/functions/control/types.ts` | 도메인 타입·`STALE_AFTER_SECONDS`·`isStale`·`neverSeen` |
| `handlers/list.ts` | `supabase/functions/control/handlers/list.ts` | 목록 조회 + ThinQ TTL 갱신 |
| `handlers/command.ts` | `supabase/functions/control/handlers/command.ts` | 명령 1건 검증·발행. `acked`/`sent` 분기 |
| `handlers/registry.ts` | `supabase/functions/control/handlers/registry.ts` | 기기 등록·해제·ThinQ 후보 목록 |
| `handlers/shared.ts` | `supabase/functions/control/handlers/shared.ts` | `HandlerError`·ThinQ 클라이언트 팩토리 |
| `thinq/client.ts` | `supabase/functions/control/thinq/client.ts` | ThinQ HTTP 클라이언트·오류 매핑·재시도 |
| `thinq/profile.ts` | `supabase/functions/control/thinq/profile.ts` | 프로파일 → capabilities/constraints 파생 |
| `thinq/commands.ts` | `supabase/functions/control/thinq/commands.ts` | 명령 직렬화 + 범위·enum 검증 |
| `thinq/state.ts` | `supabase/functions/control/thinq/state.ts` | ThinQ state → `DeviceState` |
| `tasmota/topics.ts` | `supabase/functions/control/tasmota/topics.ts` | 토픽 조립·기기 ID 검증(유일 출처) |
| `reservation-window.test.ts` | `supabase/functions/control/reservation-window.test.ts` | 시간 창 단위 테스트(자정 넘김 포함) |
| `20260803150000_device_control.sql` | `supabase/migrations/` | `devices` · `device_state` + RLS |
| `20260803160000_device_commands.sql` | `supabase/migrations/` | `device_commands` + 인덱스 + Realtime publication |
| `control-agent/src/*` | `06-applications/control-agent/src/` | 현장 에이전트(명령 하행·상태 상행) |
| `control-agent/README.md` | `06-applications/control-agent/` | 에이전트가 **왜** 그렇게 동작하는지(절차는 `control-setup.md`) |
| `sihas-bridge/` | `06-applications/sihas-bridge/` | SQM-300 UDP↔MQTT 브리지. Tasmota 토픽 계약을 흉내 낸다 |
| `control-setup.md` | `06-applications/control-setup.md` | 현장 설치 절차의 정본 — A(냉난방) · B(조명) |

## 확인이 필요한 것

| 항목 | 왜 지금은 모르는가 |
|---|---|
| [확인 필요: 라이브 `devices` 테이블의 실제 등록 목록(대수·이름·어댑터)] | 런타임 데이터라 레포에 없다. 나이트모드가 이름의 `sihas` 문자열에 의존하므로 **실제 이름에 그 문자열이 들어 있는지** 확인이 필요하다 |
| [확인 필요: 등록된 에어컨의 실제 프로파일 파생값 — `temp` min/max/step·unit, `modes`·`wind` enum 실값] | 등록 시점에 실기기에서 파생해 DB에 들어간다. 이 문서의 `18~30C`·`COOL`/`HIGH`는 **예시**다 |
| [확인 필요: SiHAS SQM-300 현장 E2E 검증 결과(브리지 README의 4단계)] | 코드 작성 환경에 실기기가 없어 수행하지 못했다고 README가 명시하고 있다 |
| [확인 필요: 손님 페이지의 `power_off` 확인창이 실제 운영에서 과한지] | 어드민은 켜기·끄기 둘 다 확인을 받고 손님은 끄기만 받는다. 의도된 차이지만 현장 사용 관찰이 없다 |

## 11. 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-14 | 최초 작성 (배포된 구현 기준 역기획) |
