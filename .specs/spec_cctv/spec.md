# spec_cctv

> 운영자가 어드민 CCTV 탭에서 합정 라운지 카메라 3대의 실시간 영상을 보고, 카메라를 등록·해제하고,
> 생존·오디오 유입을 감시하는 원격 관제 기능. **영상 프레임은 Supabase를 지나지 않는다** —
> 브라우저가 합정 맥의 MediaMTX에 직접 붙고, 서버는 주소와 자격증명 전달, 그리고 생존 확인만 한다.

## 1. 개요

타입라운지는 무인 운영이라 "지금 저기 사람이 있나", "어제 그 시간에 무슨 일이 있었나"를 확인할
경로가 카메라뿐이다. 그런데 CCTV는 기능 하나가 아니라 **세 개의 서로 다른 문제**가 겹쳐 있다.

| 문제 | 이 스펙의 답 |
|---|---|
| 영상은 초당 수 Mbps다 — 제어(초당 JSON 한 건)와 같은 경로로 못 나른다 | 영상 경로와 제어 경로를 **분리**한다. Edge Function은 주소·자격증명만 알려주고 브라우저가 MediaMTX에 직접 붙는다 |
| 카메라 마이크가 꺼지지 않는다 — 오디오가 서버에 들어오면 「개인정보 보호법」 §25⑤ 위반이다 | 카메라를 MediaMTX에 직접 걸지 않고, **오디오를 떼는 ffmpeg `-an` 재발행**을 유일 경로로 둔다. 그래도 새면 잡도록 오디오 트랙을 상태로 승격해 감시한다 |
| 끊기면 아무도 모른다 — 검은 화면은 소리를 내지 않는다 | 브라우저는 **재연결 상태머신**으로 스스로 돌아오고, 서버는 상태 보고를 3분법으로 구분해 표시하고, 끊김·복구 전환은 Mattermost로 나간다 |

핵심 동작 넷:

1. **영상은 서버를 안 지난다.** `카메라 → ffmpeg(-an) → MediaMTX → cloudflared → 브라우저`가
   전부다. Supabase는 이 경로 밖에서 "어떤 카메라가 있다고 선언했는가"와 "그게 지금 살아 있는가"만
   안다.
2. **서버는 녹화하지 않는다**(`record: no`, 2026-08-10 현장 지시). 영상은 카메라 SD카드에만 남고
   합정 맥에는 아무것도 저장되지 않는다. 되감기(playback) UI도 같이 걷어냈다.
3. **자격증명은 Authorization 헤더로만** 전달된다. 쿼리스트링 경로는 MediaMTX가 v1.18.0에서
   보안 결함으로 규정해 막았고, `authMethod: internal`은 애초에 토큰을 보지 않는다.
4. **끊김은 없앨 수 없고 되돌아오게만 만든다.** 터널이 Cloudflare LAX 엣지를 타서 왕복이
   0.73~0.94초다(2026-08-10 실측). 이 환경에서 플래핑은 예외가 아니라 기본값이라, 재연결 로직은
   "안 끊기게"가 아니라 "새로고침 없이 돌아오게"를 목표로 설계됐다.

### 이 스펙이 하지 않는 것 (Non-Requirements)

| 안 하는 것 | 사유 |
|---|---|
| 서버 녹화·되감기 재생 | 2026-08-10 현장 지시로 껐다(`record: no` · `playback: no`). 되살리려면 `mediamtx.yml` 녹화 절과 `playback`을 함께 켜고 보관기간 4곳을 맞춘다 |
| 카메라를 `devices` 테이블에 통합 | 카메라는 명령을 받지 않고 `power`가 없다. `kind='camera'`로 우겨넣으면 `capabilities=[]`·`power=null` 행이 생겨 '상태 모름' 경고가 카메라마다 영구히 뜬다 |
| 영상 프레임을 Supabase로 중계 | 초당 수 Mbps는 Edge Function으로 못 나르고, 비용상으로도 성립하지 않는다 |
| 요청마다 검증하는 외부 인증(`authMethod: http`) | HLS는 플레이리스트·세그먼트 **매 요청**마다 인증한다(초당 4~5회). 지연이 재생을 덜컥거리게 하고, 시청 1시간당 약 1.6만 호출이라 무료 한도에 닿는다 |
| 손님·청소 역할의 CCTV 접근 | 카메라 관련 4개 action은 `auth.ts`에서 admin 전용이다. 손님은 기기 목록 조회와 냉난방 조작만 |
| 등록 해제 시 녹화 파일 삭제 | 되돌릴 수 없는 삭제를 되돌릴 수 있는 조작에 딸려 보내지 않는다 |
| 브라우저 버퍼 튜닝(`liveSyncDurationCount` 등) | `hlsSegmentDuration`을 4초로 올린 뒤의 끊김 빈도를 아직 관찰하지 못했다. 관찰 없이 숫자를 옮기면 무엇이 효과였는지 알 수 없게 된다 |

## 기술 스택

프로젝트 공통(Supabase Edge Function `control` · Deno · supabase-js v2 from jsr · PostgreSQL)
+ 이 스펙 고유:

- **MediaMTX** — 합정 맥의 스트리밍 서버. HLS(`hlsVariant: mpegts`) 배포, `authMethod: internal`
  내장 인증, `/v3/paths/list` API로 스트림 생존·트랙 목록 제공.
- **ffmpeg** (`/usr/local/bin/ffmpeg`) — 카메라 RTSP를 받아 `-an`으로 오디오를 버리고
  `-c:v copy`로 재인코딩 없이 MediaMTX에 재발행.
- **hls.js 1.7.0** (jsDelivr CDN, `admin.html`에 script 태그) — 브라우저 HLS 재생.
  `xhrSetup`으로 요청마다 Authorization 헤더를 붙인다.
- **cloudflared** (Cloudflare Tunnel, locally-managed) — 합정 맥의 로컬 포트를
  `cam.nmwc.ai.kr`·`camrec.nmwc.ai.kr`로 노출.
- **Cloudflare Transform Rule** (Request Header Transform) — iOS User-Agent 덮어쓰기.
- **Node.js 에이전트**(`control-agent`) — MediaMTX API·디스크를 관찰해 `camera_state`에 upsert.
- **launchd** LaunchAgent 2종 + ad-hoc 서명 `.app` 번들(TCC 권한 주체용, `relay-launcher.c`).

## 실행 환경

| 구간 | 런타임·플랫폼 |
|---|---|
| 어드민 화면 | 브라우저(PC 크롬·맥 사파리·iPhone 사파리 실기기 확인). 빌드 단계 없는 단일 HTML, Vercel 정적 배포 |
| 서버 | Supabase Edge Function `control` (Deno Deploy). 배포는 `supabase functions deploy control` |
| 현장 에이전트 | 합정 맥(macOS 26)의 Node.js 프로세스. `control-agent/.env`로 설정 |
| 스트리밍 서버 | 합정 맥의 MediaMTX. HLS `:8888`, API `127.0.0.1:9997`, RTSP `127.0.0.1:8554` |
| 재발행 | 합정 맥의 ffmpeg 3개 프로세스(카메라 1대당 1개). `.app` 번들 → 셸 루프 |
| 터널 | 합정 맥의 cloudflared LaunchAgent(사용자 도메인, `sudo` 불필요) |
| CI | `.github/workflows/test.yml` — `deno test`(서버) + `deno test --allow-read 06-applications/admin-retry.test.js`(재연결 상태머신) |

## 2. 아키텍처 — 영상이 지나는 길

```
  [Tapo 카메라 3대]                          합정 맥 (macOS 26)
   office        RTSP  영상+오디오
   lounge_left  ─────────────────►  [ffmpeg -an]  RTSP  ┌──────────────┐
   lounge_right   :554/stream1      오디오 폐기 ───────► │  MediaMTX    │
                                    camera-republish.sh  │ 127.0.0.1:   │
                                    (path 당 1 프로세스)  │   8554 (RTSP)│
                                                         │   8888 (HLS) │
                                                         │   9997 (API) │
                                                         └──┬───────┬───┘
                                                            │       │ /v3/paths/list
                                            HLS (인증 필요)  │       │ (127.0.0.1 한정)
                                                            ▼       ▼
                                                   [cloudflared]  [control-agent]
                                                            │       │ 30초마다
                                                            │       │ camera_state upsert
   ┌──────────────────────┐                                 │       │
   │ 브라우저 (admin.html)│◄──── HLS ── cam.nmwc.ai.kr ◄────┘       │
   │  hls.js + Authorization                                        │
   │  Basic 헤더 (요청마다)                                          ▼
   └──────────┬───────────┘                            ┌────────────────────────┐
              │  action: cameras / camera_credentials  │ Supabase               │
              └───────────────────────────────────────►│ Edge Function control  │
                    (주소·자격증명·상태만. 영상 없음)     │ cameras / camera_state │
                                                       └────────────────────────┘
```

읽는 법 세 가지:

- **가로줄(영상)과 세로줄(제어)이 만나지 않는다.** 영상은 왼쪽 아래로 흘러 브라우저에 직접
  닿고, Supabase는 오른쪽에서 "어떤 카메라가 있고 살아 있나"만 안다.
- **카메라와 MediaMTX 사이에 반드시 ffmpeg가 있다.** `mediamtx.yml`의 `paths`가 전부
  `source: publisher`이고 `rtspAddress`가 `127.0.0.1`로 묶인 이유가 이것이다. 카메라를 직접
  `source`로 걸면 오디오가 서버로 흐른다.
- **API 포트(9997)는 절대 터널로 나가지 않는다.** 나가면 인증 없이 서버를 조작할 수 있다.

### 왜 MediaMTX 내장 인증인가

요청마다 우리 서버가 검증하는 방식(`authMethod: http` → Edge Function이 인증 서버)을 먼저 검토하고
폐기했다. HLS는 플레이리스트와 세그먼트 **매 요청마다** 인증을 거는데 그게 초당 4~5회다.

| 폐기 사유 | 수치 |
|---|---|
| 지연 | 요청 하나하나에 합정 맥 → Supabase 왕복이 끼면 재생이 계속 덜컥거린다 |
| 호출 수 | 시청 1시간당 약 1.6만 호출. 하루 한 시간씩만 봐도 월 48만으로 무료 한도(50만)에 닿는다 |

대가는 **자격증명이 장기 유효하다는 것**이다. 받아들이는 근거 셋: (1) 이 계정은 `read`/`playback`만
갖고 `publish`가 없어 가짜 영상으로 덮어쓸 수 없다, (2) 받으려면 이미 admin 비밀번호를 통과해야
하므로 admin 비밀번호와 같은 등급이지 새 약점이 아니다, (3) 회수는 `mediamtx.yml` 계정과 Supabase
시크릿 두 곳을 같이 바꾸면 된다.

## 3. 접근 제어

카메라 관련 4개 action(`cameras`·`camera_credentials`·`camera_register`·`camera_delete`)은
**admin 전용**이다. `auth.ts`의 `GUEST_ACTIONS`(`list`·`command`·`automate`)와
`CLEANER_ACTIONS`(`cleaning_pending`·`cleaning_complete`) 어디에도 없다 — 손님·청소 역할이 부르면
403이다.

```
  요청 도착
    ├─ password 미제출               → guest   → cameras* 전부 403
    ├─ password 제출, admin과 불일치 → 401 (guest로 조용히 낮추지 않는다)
    ├─ password 제출, admin과 일치   → admin   → 허용
    └─ CLEANING_TOKEN 제출          → cleaner → cameras* 전부 403
```

이 판정이 **서버에 있어야 하는 이유**: 손님 페이지(`guest-control.html`)와 어드민 모두 소스가
공개되므로, 클라이언트에서 버튼을 감추는 것은 아무것도 막지 못한다. 누구나 `fetch`로
`camera_credentials`를 직접 부를 수 있다.

`cameras`·`camera_state` 테이블은 RLS를 켜고 **정책을 하나도 두지 않는다** = anon 키로는 읽기도
쓰기도 불가. 접근은 Edge Function(service_role)과 합정 에이전트뿐이다. 카메라 목록이 새면
스트림 경로(`path`)가 새는 것이고, 그건 URL 추측의 출발점이 된다.

## 4. 자격증명 전달

| 규칙 | 구현 | 어기면 |
|---|---|---|
| 목록 응답에 자격증명을 담지 않는다 | `cameras` 응답은 `live_base`·`playback_base`·`retention_days`·`cameras[]`만. 계정은 별도 action | 목록은 15초마다 다시 받으므로 비밀이 필요 이상으로 자주 돌아다닌다 |
| 로그인 세션당 1회만 받는다 | `refreshCameras()`가 `!CAM.creds`일 때만 `camera_credentials`를 부른다. `lock()`이 `CAM.creds = null`로 버린다 | 위와 같음 |
| Authorization 헤더로만 쓴다 | `camAuthHeader()` → `Basic ` + base64(UTF-8 바이트). hls.js `xhrSetup`이 요청마다 붙인다 | 쿼리스트링은 MediaMTX가 막았고(v1.18.0 보안 결함), URL에 실리면 cloudflared·MediaMTX 접근 로그에 찍힌다 |
| 넷 중 하나라도 비면 미설정으로 본다 | `streamConfig()`가 `null` 반환 → `cameras_configured: false`, `camera_credentials`는 503 | 반쪽 설정으로 화면을 열면 '재생이 안 되는데 왜인지 모르는' 상태가 되고, 카메라 고장과 구분되지 않는다 |

주소(`live_base`)는 비밀이 아니다 — 자격증명 없이는 401이라 아무것도 못 본다. 화면 조립에
필요하므로 목록과 같이 준다.

> ⚠️ **`CAMERA_PLAYBACK_BASE` 시크릿을 지우면 실시간 영상까지 통째로 죽는다.** 되감기를 안 쓰게
> 됐다고 지우면 안 된다 — `streamConfig()`가 넷을 한꺼번에 요구하기 때문이다. 이 의존을 끊으려면
> 그 줄에서 `playbackBase`를 빼고 Edge Function을 다시 배포해야 한다.

`btoa`는 바이트 단위라 비ASCII가 섞이면 던진다. 자격증명은 우리가 만드는 값이지만 한글이 섞이는
순간 '재생이 안 되는데 왜인지 모르는' 상태가 되므로, `TextEncoder`로 UTF-8을 먼저 편 뒤 인코딩한다.

## 5. 페이지 구성

경로: `/admin` → 사이드바 `CCTV` 탭 (`#view-cctv`). SPA 뷰 전환이라 별도 URL이 없다.

```
┌──────────────────────────────────────────────────────┐
│ ☰  TYPE LOUNGE 어드민            [로그아웃]          │
├──────────────────────────────────────────────────────┤
│  실시간                                              │
│  ┌────────────────────────────────────────────────┐  │
│  │ camNotice — 미설정·목록 실패·debug 진단 문구    │  │  ← 평소엔 숨김
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ 카메라 카드 ──────────────────────────────────┐  │
│  │  현관                             [등록 해제]  │  │
│  │  ⚠ 오디오 트랙 감지 — 카메라 마이크를 끄세요   │  │  ← 있으면 최상단
│  │  영상 연결 실패 (fragLoadError · 재연결 중)    │  │  ← 재생 실패 시
│  │  연결됨 · 42초 전 · SD 보관 7일                │  │  ← 상태줄
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │                                          │  │  │
│  │  │        <video>  16:9  HLS 실시간         │  │  │
│  │  │                                          │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│  ┌─ 카메라 카드 ── 라운지(좌) ────────────────────┐  │
│  └────────────────────────────────────────────────┘  │
│  ┌─ 카메라 카드 ── 라운지(우) ────────────────────┐  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [ + 카메라 추가 ]                                   │
│                                                      │
│  ┌ 안내 ──────────────────────────────────────────┐  │
│  │ 영상은 저장하지 않고 지나갑니다 — 합정 맥에도  │  │
│  │ 서버에도 남지 않습니다. 지난 영상은 카메라     │  │
│  │ SD카드에서 Tapo 앱으로 꺼냅니다.               │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

카드 상태줄은 `·`로 이어 붙인 한 줄이고, **순서가 곧 중요도**다:
`오디오 경고 → 재생 실패 → (debug 진단) → 보고 상태 → 마지막 보고 시각 → SD 보관 일수`.
`cameraBad()`가 참이면 줄 전체가 경고색(`dev-warn`)이 된다.

## 6. 섹션별 상세

### 6-1. 카메라 카드

- **기능**: 카메라 한 대의 실시간 영상 + 상태 한 줄 + 등록 해제 버튼.
- **UI**: 이름(굵게) · `[등록 해제]` · 상태줄 · `<video muted playsinline autoplay>`
  (16:9, 배경 `#111`).
- **데이터**: `cameras[].name`·`id`·`path`, `cameras[].state.*`, `data.retention_days`.
- **빈 상태**: 등록된 카메라가 0대면 카드 없이 `camNotice`만 —
  설정됨이면 "등록된 카메라가 없어요. 합정 맥의 mediamtx.yml 에 선언한 이름 그대로 추가하세요.",
  미설정이면 "CCTV가 아직 설정되지 않았어요. 서버에 스트림 주소와 계정을 넣어야 영상이 나와요."
- **부분 설정**: `cameras_configured: false`인데 카메라는 있으면 목록·상태만 그리고
  "스트림 주소·계정이 서버에 없어서 영상은 안 나와요. 목록과 상태만 보여요."를 경고색으로 띄운다.

**카드를 다시 그리는 조건이 핵심이다.** 15초마다 목록을 다시 받지만, 카드 HTML은
`ids !== CAM.ids`(목록 구성 변경)일 때만 다시 만든다. 매번 다시 그리면 `<video>`가 새로 생겨
화면이 15초마다 깜빡이고 연결도 매번 새로 맺는다. 평소에는 `paintCameraMeta()`가 글자만 갈아낀다.

붙이기도 마찬가지로 **아직 안 붙은 카메라만** 붙인다(`if(!CAM.attached[c.id])`). 목록이 바뀔 때만
붙이면, 첫 자격증명 요청이 실패하고 15초 뒤 재시도가 성공한 경우 목록이 그대로라 재생이 영영
안 붙는다(검은 화면).

### 6-2. 카메라 등록 모달

- **기능**: 이름 + 스트림 이름(MediaMTX path)으로 카메라를 선언한다.
- **UI**: `이름`(예: 현관 / 라운지) · `스트림 이름`(예: entrance / lounge) · 안내 문구 ·
  `[카메라 추가]`. 성공하면 닫고 목록을 갱신, 실패하면 **열어둔 채** 모달 안에 사유를 남긴다.
- **데이터**: `camera_register { name, path }` → `cameras` 행 생성.
- **안내 문구**: "합정 맥의 `mediamtx.yml` 에 선언한 `paths` 이름과 **글자까지 같아야** 합니다
  (영소문자·숫자·`_`·`-`, 32자 이내). 다르면 카드는 뜨는데 영상만 안 나옵니다."

이 안내가 UI에 있는 이유: 실체(MediaMTX path)는 합정 맥에 있고 DB는 **선언**일 뿐이다. Tasmota
Topic 등록과 같은 계약이라 같은 함정을 갖는다 — 한 글자만 달라도 등록은 성공하고 카드도 뜨는데
영상만 안 나온다. 그래서 문법은 등록 시점에 막고, 정합성 안내는 화면에 둔다.

### 6-3. 등록 해제

- **기능**: 카드의 `[등록 해제]` → `confirm()` → `camera_delete`.
- **확인 문구**: "이 카메라의 등록을 해제할까요? 녹화 파일은 그대로 남아요."
- **데이터**: `cameras` 행 삭제 → `camera_state`는 `on delete cascade`로 같이 사라진다.
- **파일은 지우지 않는다.** 실수로 해제한 순간 증거가 사라지면 안 된다.

### 6-4. 화면 진입·이탈

| 시점 | 동작 |
|---|---|
| CCTV 탭 진입(`enterCctv`) | `?debug=1`이면 재생 환경 한 줄 표시 → `refreshCameras()` |
| 다른 탭으로 이동 / 로그아웃(`leaveCctv`·`lock`) | `destroyCamPlayers()` — 플레이어 파괴 → 타이머 정리 → `<video>` src 해제. `lock()`은 `CAM.creds`까지 버린다 |
| 15초 주기 | CCTV 탭을 보고 있을 때만 `refreshCameras()`. **영상은 재부착하지 않는다** |

`destroyCamPlayers()`는 **플레이어를 먼저 부순 뒤 타이머를 비운다.** 반대로 하면 파괴 도중 오류
핸들러가 타이머를 다시 무장할 여지가 생기고, 그러면 화면을 떠난 뒤에 되살아나 스트림이 다시 흐른다.

## 7. 재연결 상태머신

hls.js의 `fatal`은 '자체 재시도를 이미 다 썼다'는 뜻이지 '영구 장애'가 아니다. 예전에는 오류 문구만
칠하고 끝냈는데, `CAM.attached`가 true로 남아 목록 갱신이 다시 붙이지 않았다 — **순간 끊김 하나가
새로고침 전까지 검은 화면으로 굳었다.** "자꾸 끊긴다"의 정체가 이것이다(끊김이 잦은 게 아니라 한 번
끊기면 안 돌아왔다).

### 오류 분기 (`handleCamFatal`)

| 오류 | 처리 | 왜 |
|---|---|---|
| `MANIFEST_LOAD_ERROR`·`MANIFEST_LOAD_TIMEOUT`·`MANIFEST_PARSING_ERROR` | `reattachLive()` — 인스턴스 재생성 | hls.js에서 `MANIFEST_LOADING`을 트리거하는 건 `loadSource` 하나뿐이라 `startLoad`는 이 부류에 **no-op**이다. 하필 터널이 내려갔을 때 제일 먼저 나오는 오류다 |
| `MEDIA_ERROR` | `hls.recoverMediaError()` | 디코더만 어긋난 것이라 인스턴스를 안 버려도 된다. 던지면 `reattachLive()`로 폴백 |
| `NETWORK_ERROR`(매니페스트 외) | `hls.startLoad()` | 연결만 끊긴 것이라 재부착보다 훨씬 싸다. 던지면 `reattachLive()`로 폴백 |
| 그 밖 | `reattachLive()` | |

**셋 다 같은 회계를 탄다.** `MEDIA_ERROR`가 예전에 `camRetry`를 건너뛰어 지연 0으로 무한 반복하며
한도에도 안 닿았고, 사용자는 이유를 영영 못 봤다.

### 백오프와 소진

```
  fatal 발생
    │  CAM.lastFail[id] = now
    │  CAM.errors[id] = "<details> · 재연결 중"      ← 카드에 즉시 표시
    ▼
  camRetry(n = CAM.retries[id])
    ├─ n >= 6 (CAM_RETRY_MAX)
    │     CAM.errors[id] = "연결 실패 — 15초마다 다시 시도해요"
    │     플레이어 destroy → CAM.players/attached 삭제
    │     (retries는 한도에 남긴다 → 다음에도 즉시 이 자리)
    │     ▼
    │   15초 목록 갱신이 느린 재시도 역할을 한다 → attachLive
    └─ n < 6
          retries[id] = n + 1
          clearTimeout(직전 예약)             ← 중첩 금지
          setTimeout(fn, min(30s, 1s × 2^n))  ← 1s·2s·4s·8s·16s·30s
              └─ 실행 직전 카드 존재 확인 (등록 해제됐으면 안 되살린다)

  FRAG_BUFFERED 수신
    └─ camMarkAlive: now − lastFail > 30초(CAM_STABLE_MS) 일 때만 retries = 0
       그리고 errors 삭제 → 카드 다시 칠하기
```

두 가지 판단이 이 설계의 전부다.

- **소진했다고 부착 표시를 남기지 않는다.** 남기면 `renderCameras`가 걸러내 영영 안 붙고, 그게
  바로 없애려던 상태다. 지우면 15초 목록 갱신이 느린 재시도가 된다. `retries`는 한도에 남겨
  매번 즉시 이 자리로 돌아오므로 빠른 백오프로 되돌아가지 않는다(폭주하지 않는다).
- **조각 하나로는 살아난 게 아니다.** 끊김 사이에 조각이 하나씩만 들어오는 플래핑에서 매번 0으로
  되돌리면 백오프가 1초에 고정되고 한도에도 영영 안 닿는다 — 이미 버거운 업링크를 1초마다
  두드리게 되고 진단 문구도 안 뜬다.

> 이 판단들은 `06-applications/admin-retry.test.js`(17 케이스)가 CI에서 검증한다. `admin.html`은
> 빌드 단계가 없어 import할 모듈이 없으므로, 테스트가 **함수 본문을 이름으로 잘라내** 스텁 환경에서
> 돌린다. 잘라내기가 실패하면 조용히 통과하지 않고 즉시 죽는다 — 구조가 바뀌었는데 테스트만
> 초록으로 남는 게 제일 나쁘다. `handleCamFatal`·`camMarkAlive`를 굳이 이름 있는 함수로 뽑아둔 것도
> 이 파일 때문이다.

### hls.js 미지원 환경

`Hls.isSupported()`가 거짓이면 `CAM.errors[id] = '이 브라우저로는 실시간 재생 불가'`를 남기고
`attached`만 표시한다. 네이티브 HLS 재생은 요청을 가로채 헤더를 붙일 수 없고 MediaMTX는 헤더 외에
자격증명을 받는 경로가 없다 — **방법이 없으므로 이유를 숨기지 않는다.**

### `attachMedia` 지연

`hls.loadSource(url)` 직후가 아니라 `setTimeout(..., 0)`으로 다음 이벤트 루프에 붙인다. iPhone
사파리에는 일반 MediaSource가 없고 `ManagedMediaSource`만 있는데, hls.js는 그 경우
`media.disableRemotePlayback = true`를 세팅하고 사파리는 이 속성을 DOM 삽입 직후에 건드리면
`InvalidStateError`를 던진다(hls.js #6197).

> ⚠️ **이것이 2026-08-10 iPhone 장애의 원인이 아니다.** 그때 관측된 오류는 `manifestLoadError
> http=400` 하나뿐이고 `InvalidStateError`는 우리 환경에서 관측된 적이 없다. 알려진 함정을 미리
> 피해두는 것이고 비용이 한 틱뿐이라 남겨둔 것이다.

## 8. 상태 감시

### 8-1. 관측 (현장 에이전트)

`control-agent`가 30초마다(`REPORT_INTERVAL_MS`) MediaMTX API와 녹화 디렉터리를 관찰해
`camera_state`에 upsert한다. 카메라 목록은 5분마다 다시 읽는다(`RELOAD_INTERVAL_MS`).

| 관측값 | 방법 |
|---|---|
| `online` | `/v3/paths/list`의 `ready` |
| `has_audio` | 같은 응답의 `tracks`에서 **비디오 코덱 화이트리스트에 없는 트랙이 하나라도 있으면** true |
| `recording` | 녹화 디렉터리에서 가장 최근 파일의 mtime이 120초 이내인가 (**설정 플래그가 아니라 파일로 판정**) |
| `disk_free_gb` | `statfs(recordDir)`의 가용 블록 |

**API를 못 읽으면 아무것도 쓰지 않는다.** `online=false`로 덮으면 '카메라가 죽었다'와 '내가 못 봤다'가
구분되지 않는다. 안 쓰면 `updated_at`이 늙어 화면이 '보고 끊김'으로 표시한다 — 그게 실제로 일어난
일이다.

CCTV 설정(`MEDIAMTX_RECORD_DIR`)이 없으면 **조용히 아무것도 하지 않는다.** 조명과 냉난방은 CCTV
없이도 완결이라, 설정 누락을 치명적 오류로 다루면 카메라를 안 단 상태에서 에이전트 전체가 죽어
조명까지 멈춘다.

### 8-2. 3분법 — 합치면 안 되는 세 가지

| 표시 | 조건 | 뜻 | 합치면 |
|---|---|---|---|
| `아직 보고를 받은 적 없음` | `never_seen` = `updated_at === null` | 등록만 되고 관측이 한 번도 없음 | 방금 등록한 카메라가 장애처럼 보인다 |
| `보고 끊김` | `is_stale` = `updated_at`이 180초 초과 | 에이전트·네트워크가 죽었다. **화면의 값을 믿지 마라** | 값이 낡았다는 사실이 사라진다 |
| `연결 끊김` | `online === false` | MediaMTX가 소스를 못 물고 있다 | 진짜 장애가 왔을 때 아무도 경고를 믿지 않는다 |

`neverSeen`은 `isStale` 판정에서 먼저 빠진다 — **미수신은 '끊김'이 아니라 '모름'이다.**

`CAMERA_STALE_AFTER_SECONDS = 180`은 기기(600초)보다 짧다. 실패의 무게가 다르기 때문이다 —
조명은 눌러 보면 살았는지 알지만, 영상은 **분쟁이 나기 전까지 아무도 확인하지 않는다.**

> ⚠️ **`연결됨`은 에이전트가 살아 있다는 뜻이지 영상이 흐른다는 뜻이 아니다.** 3대가 모두 검은
> 화면인데 카드는 `연결됨`이면 ffmpeg 재발행 사망을 의심한다 — 2026-08-09에 셋 다 `Broken pipe`로
> 죽어 약 40시간 영상이 없었고, 그동안 카드는 멀쩡해 보였다. 판정 기준은
> `curl -s localhost:9997/v3/paths/list`의 `ready`다.

### 8-3. 오디오 감시

```javascript
const VIDEO_CODECS = new Set(["AV1", "VP9", "VP8", "H265", "H264", "M-JPEG", "MJPEG"]);
// 이 목록에 없는 트랙은 전부 오디오로 본다.
```

**반대로(오디오 목록을 나열) 하지 않는 이유는 틀렸을 때의 방향이다.** 모르는 코덱을 오디오로 보면
불필요한 경고가 뜨고, 비디오로 보면 위법 녹음이 조용히 지나간다. 전자가 낫다.

감지되면 두 곳에 남는다: 카드 상태줄 **최상단**(`⚠ 오디오 트랙 감지 — 카메라 마이크를 끄세요`),
그리고 에이전트 로그(`console.error`). 어드민을 안 보고 있어도 흔적이 있어야 한다.

이 감시가 **유일한 방어**인 이유: MediaMTX에는 오디오를 버리는 설정이 없다. 차단은 ffmpeg `-an`
재발행뿐인데, 재발행 구조가 무너지거나 카메라 펌웨어 업데이트로 마이크가 조용히 되살아나면 아무도
모른다.

### 8-4. 카드가 더 이상 보여주지 않는 것

2026-08-10 서버 녹화를 끄면서 `녹화 중/안 됨`과 `남은 용량`을 상태줄에서 뺐다. 둘 다 고정값이 돼서
장애 신호로 못 쓰고, 그 자리를 장애 신호로 쓰던 습관이 진짜 문제(오디오 감지·연결 끊김)를 가린다.

> ⚠️ `cameraBad()`에 `!s.recording`을 다시 넣지 말 것. 넣는 순간 **모든 카드가 항상 경고색**이 된다.

DB 컬럼과 에이전트 관측은 그대로 남아 있다 — 서버 녹화를 다시 켤 때 되살아난다.

## 9. 연결 끊김·복구 알림

`automate` 틱(pg_cron 1분)마다 `automation/connectivity.ts`가 **새로 관측하지 않고** 이미 쌓인
`camera_state`를 읽어 **전환**만 장부(`device_events`)에 남긴다. 그 장부가 Mattermost로 나간다.

| 이벤트 | 제목 | 본문(`value`) |
|---|---|---|
| `camera_offline` | `⚠️ CCTV 연결 끊김` | `MediaMTX 스트림이 연결되어 있지 않습니다` 또는 `상태 보고가 180초 이상 끊겼습니다(에이전트·네트워크 확인)` |
| `camera_recovered` | `CCTV 연결 복구` | `복구됨` |

판단은 순수 함수 `decideTransition()`에 있다(DB 없이 `connectivity.test.ts`가 검증).

```
  down = !online || is_stale           (never_seen은 게이트에서 먼저 제외)

  down 이고 장부에 없거나 직전이 '복구' → 새 끊김
      └─ 지난 60분 내 이 카메라 offline이 4건 이상? → none (플래핑)
                                          아니면    → offline (즉시)
  down 이고 직전이 '끊김'               → 60분 지났으면 offline, 아니면 none
  정상이고 직전이 '끊김'                → recovered
  그 외                                 → none
```

- **`never_seen`을 먼저 빼는 이유**: 한 번도 보고를 못 받은 카메라(등록만 됨)는 '끊김'이 아니라
  '모름'이고, 여기 섞으면 최초 등록 직후부터 경보가 뜬다.
- **집합이 아니라 전환을 보는 이유**: 끊김→복구→끊김이 짧은 창에서 반복되면 "최근에 이미 알렸나"를
  집합으로 물었을 때 두 kind 모두에 걸려 두 번째 끊김을 놓친다.
- **플래핑 상한(60분 창 4건)의 트레이드오프**: 상한에 걸린 뒤 진짜 장기 장애로 굳으면 옛 끊김이
  창에서 빠질 때까지 최대 60분 재알림이 늦는다. **첫 끊김 즉시성**을 지키는 대가로 받아들였다.

## 10. 데이터 모델

실제 SQL(`20260803170000_cameras.sql`)과 `supabase/functions/control/cameras.ts` 기준.

```typescript
/** 카메라 인벤토리 — '무엇이 있다고 선언했는가'. 실체는 합정 맥에 있다. */
interface Camera {
  id: string;      // uuid, gen_random_uuid()
  name: string;    // 사람이 부르는 이름 ('현관')
  /** MediaMTX path 이름. mediamtx.yml의 선언과 글자까지 같아야 한다. unique */
  path: string;    // check: ^[a-z0-9][a-z0-9_-]{0,31}$
  sort: number;    // 화면에 뜨는 순서. NULL이면 0으로 읽는다
}

/** 마지막 보고 상태 — '그게 지금 살아 있는가'. 합정 에이전트가 30초마다 upsert. */
interface CameraState {
  camera_id: string;            // cameras(id) FK, on delete cascade, primary key
  online: boolean;              // MediaMTX가 소스를 물고 있나 (/v3/paths/list의 ready)
  /** 최근 세그먼트가 실제로 디스크에 떨어졌나. 설정 플래그가 아니다.
   *  서버 녹화를 끈 지금은 항상 false이며 UI에 표시하지 않는다. */
  recording: boolean;
  disk_free_gb: number | null;  // 녹화 파티션 남은 용량(GB)
  /** ⚠️ true = 위법 녹음 진행 중(개인정보 보호법 §25⑤) */
  has_audio: boolean;
  /** null = 이 카메라에 대해 한 번도 보고를 받은 적 없음. 기본값을 now()로 주지 않는다. */
  updated_at: string | null;
}

/** 화면에 내려가는 파생 플래그 — DB 컬럼이 아니라 서버가 매 응답에 계산해 붙인다. */
interface CameraStateView extends CameraState {
  is_stale: boolean;   // updated_at이 180초 초과 (never_seen이면 false)
  never_seen: boolean; // updated_at === null
}

/** action: "cameras" 응답 */
interface CamerasResponse {
  cameras_configured: boolean;    // 시크릿 4개가 모두 있나
  live_base: string | null;       // 예: https://cam.nmwc.ai.kr (미설정이면 null)
  playback_base: string | null;   // 되감기 UI는 걷어냈지만 시크릿 의존은 남아 있다
  retention_days: number;         // 카드에 'SD 보관 N일'로 표시. 안내판과 대조하라고 띄운다
  cameras: Array<Camera & { state: CameraStateView }>;
}

/** action: "camera_credentials" 응답 (admin 전용, 로그인 세션당 1회) */
interface CameraCredentials {
  user: string;
  pass: string;
}
```

### 기본값·초기값 규칙

| 상황 | 값 | 이유 |
|---|---|---|
| `camera_state` 행이 없거나 `updated_at === null` | `online:false, recording:false, disk_free_gb:null, has_audio:false, updated_at:null` | `recording:false`를 '녹화가 멈췄다'로 읽으면 안 된다 — 모르는 것뿐이다. UI는 `never_seen`으로 문구를 다르게 쓴다 |
| `updated_at` 컬럼 기본값 | **없음**(NULL 허용) | `now()`를 주면 '방금 갱신됨'이라는 거짓말이 되고 화면이 '0초 전'으로 멀쩡해 보인다 |
| `sort`가 NULL | `0` | |
| `has_audio`가 NULL | `false` | |
| `CAMERA_RETENTION_DAYS` 미설정·비수치 | `7` (`DEFAULT_RETENTION_DAYS`) | `mediamtx.yml`의 `recordDeleteAfter` 기본값과 같은 숫자여야 한다 |
| `body.sort`가 수치가 아님 | `0` | |

### 브라우저 상태(`CAM`)

```typescript
interface CamRuntime {
  cfg: CamerasResponse | null;
  creds: CameraCredentials | null;
  players: Record<string, Hls>;      // hls.js 인스턴스 (재생 불가 브라우저에서는 비어 있다)
  attached: Record<string, boolean>; // 붙이기를 시도한 것. players와 달리 실패한 것도 포함
  errors: Record<string, string>;    // 카드에 표시할 재생 실패 문구
  ids: string;                       // 마지막으로 그린 카메라 id 목록 (재렌더 판단용)
  retries: Record<string, number>;   // 연속 재연결 횟수
  lastFail: Record<string, number>;  // 마지막 fatal 시각 (ms)
  timers: Record<string, number>;    // 예약된 재연결. destroyCamPlayers에서 반드시 함께 정리
  debug: boolean;                    // ?debug=1
  diag: Record<string, string>;      // debug일 때 hls.js가 준 실패 이유 원문
}
```

`errors`가 브라우저에만 있는 이유: 재생 실패는 **서버가 모르는 사실**이다(서버는 관측값만 안다).
여기 합쳐두지 않으면 15초 갱신이 오류 문구를 덮어써서, 계속 실패 중인 화면이 멀쩡해 보인다.

## 11. 데이터 저장 구조

```
public.cameras
  id uuid PK · name text · path text UNIQUE CHECK · sort int · created_at timestamptz
  └─ RLS 켬 / 정책 없음  = anon 접근 불가 (service_role·에이전트만)

public.camera_state
  camera_id uuid PK → cameras(id) ON DELETE CASCADE
  online bool · recording bool · disk_free_gb numeric · has_audio bool · updated_at timestamptz NULL
  └─ RLS 켬 / 정책 없음

public.device_events            (spec_space_control 소유. 여기서는 camera_id를 쓴다)
  camera_id uuid NULL          ← device_id와 배타적. 둘 다 null이면 '공간 전체 사건'
  kind: camera_offline | camera_recovered | ...
```

`device_state`와 달리 `camera_state`에는 `reported_at`이 없다. 기기 쪽은 '기기가 보고한 시각'과
'우리가 쓴 시각'이 실제로 다르지만(ThinQ는 전자가 아예 없다), 여기서는 에이전트가 곧 관측자라 늘
같은 값이다. **항상 같은 두 컬럼을 두면 나중에 누가 둘이 다른 줄 알고 잘못된 쪽을 읽는다.**

## 12. 기술 구현

### 서버 (Supabase Edge Function `control`)

```
supabase/functions/control/
  index.ts                     ← action 라우팅 (cameras / camera_credentials / camera_register / camera_delete)
  auth.ts                      ← 역할 판정. GUEST_ACTIONS·CLEANER_ACTIONS 어디에도 camera*가 없다
  cameras.ts                   ← cameras/camera_state 접근 계층
    ├── listCameras()          ← cameras + camera_state 조인. sort → created_at 순
    ├── getCamera() / createCamera() / deleteCamera()
    ├── isStale() / neverSeen()          ← CAMERA_STALE_AFTER_SECONDS = 180
    └── toState()              ← 행이 없거나 updated_at null이면 '모름' 기본값
  handlers/cameras.ts
    ├── streamConfig()         ← 시크릿 4개. 하나라도 비면 null
    ├── retentionDays()        ← 기본 7
    ├── cameras()              ← 목록 + 파생 플래그. 자격증명은 담지 않는다
    ├── cameraCredentials()    ← 미설정이면 503 (빈 값을 내려보내지 않는다)
    ├── registerCamera()       ← PATH_RE 검증 → createCamera. 23505/23514는 400으로
    └── removeCamera()         ← 존재 확인 → 삭제. 파일은 안 건드린다
  automation/connectivity.ts
    ├── decideTransition()     ← 순수 함수. 플래핑·재알림 판단
    ├── cameraCause()          ← 끊김 사유 문구
    └── checkConnectivity()    ← automate 틱마다 호출
  automation/events.ts         ← camera_offline / camera_recovered 기록·조회
  automation/message.ts        ← Mattermost 본문 조립
```

`PATH_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/`는 **DB check 제약과 같은 문법**이어야 한다. 어긋나면
등록이 23514로 튕긴다.

### 브라우저 (`06-applications/admin.html`)

```
admin.html  (빌드 없는 단일 파일)
  CAM (var)                    ← 런타임 상태
  enterCctv() / leaveCctv() / destroyCamPlayers()
  refreshCameras()             ← cameras → (필요 시) camera_credentials → renderCameras
  renderCameras()              ← 목록 구성이 바뀔 때만 카드 재생성, 평소엔 글자만
  cameraCardHtml() / cameraMetaText() / cameraBad() / paintCameraMeta() / cameraById()
  camAuthHeader()              ← Basic base64(UTF-8)
  camDebugEnv()                ← ?debug=1일 때 재생 경로 한 줄
  attachLive()                 ← hls.js 인스턴스 생성 + xhrSetup + 이벤트 등록
  handleCamFatal()             ← 오류 분기           ┐
  camRetry() / camRetryDelay() ← 백오프·소진          ├ admin-retry.test.js가 검증
  camMarkAlive() / reattachLive()                    ┘
  openCameraModal() / closeCameraModal() / registerCamera()
```

### 현장 에이전트 (`06-applications/control-agent/`)

```
src/cameras.js
  ├── startCameraReporter()    ← 30초 보고 + 5분 목록 재적재. 설정 없으면 조용히 스킵
  ├── reportOnce()             ← 관측 한 바퀴. API 실패면 아무것도 안 쓴다
  ├── readPaths()              ← /v3/paths/list → Map<path, {ready, hasAudio}>
  ├── hasAudioTrack()          ← 비디오 화이트리스트 밖 = 오디오
  ├── newestMtime()            ← 재귀 탐색. 세그먼트 회전 중 사라진 파일은 건너뛴다
  └── diskFreeGb()

camera-republish.sh            ← path 1개. ffmpeg -an -c:v copy → rtsp://127.0.0.1:8554/<path>
camera-relay-all.sh            ← 3대 병렬 기동 + 죽으면 5초 뒤 재기동. 중복 publisher 먼저 정리
install-camera-relay.sh        ← .app 빌드 → ad-hoc 서명 → LaunchAgent 등록 → 25초 뒤 확인
relay-launcher.c               ← camera-relay-all.sh를 exec 하는 것이 전부. TCC 권한 주체가 되려고 존재
mediamtx/mediamtx.yml          ← 템플릿. 스트림 계정·비밀번호 자리를 채워 실제 설정으로 복사
```

`camera-republish.sh`의 ffmpeg 플래그에는 각각 실측 근거가 있다:

| 플래그 | 이유 |
|---|---|
| `-an` | **지우면 위법이다.** 오디오를 버리는 유일 지점 |
| `-c:v copy` | 재인코딩 없음 — 맥 CPU를 태우지 않고 화질도 그대로 |
| `-rtsp_transport tcp` | UDP로 받으면 패킷 손실이 그대로 깨진 화면이 된다 |
| `-use_wallclock_as_timestamps 1` | 이 카메라는 타임스탬프를 안 실어 보낸다. 그대로 두면 Non-monotonic DTS 경고가 초당 수십 줄 쌓여 30시간에 115MB를 만들었다(실측) |
| `-nostats -loglevel error` | 진행률·경고 스팸을 끈다. `Broken pipe` 같은 진짜 실패는 error라 남는다 |

## 13. API 엔드포인트

전부 `POST /functions/v1/control`에 `{ "action": ... }` 형태. 4개 모두 **admin 전용**.

| action | 바디 | 응답 | 오류 |
|---|---|---|---|
| `cameras` | — | `CamerasResponse` | 조회 실패 시 500 |
| `camera_credentials` | — | `{ user, pass }` | 시크릿 미설정이면 **503** + 어떤 시크릿이 필요한지 명시 |
| `camera_register` | `{ name, path, sort? }` | `{ camera }` | 이름 없음 400 · path 문법 400 · 중복(23505) 400 · 문법(23514) 400 |
| `camera_delete` | `{ camera_id }` | `{ ok: true }` | 없는 id 404 |

등록 오류를 400으로 내리는 이유: 중복·문법은 **사용자가 고칠 수 있는 오류**다. 500으로 뭉뚱그리면
모달에 "카메라 등록 실패"만 뜨고 무엇을 고쳐야 하는지 알 수 없다.

## 14. 실행 스크립트·환경 변수

### Supabase 시크릿 (`supabase secrets set`)

| 이름 | 용도 | 비고 |
|---|---|---|
| `CAMERA_LIVE_BASE` | HLS 베이스 URL (예: `https://cam.nmwc.ai.kr`) | 끝 슬래시는 서버가 떼어낸다 |
| `CAMERA_PLAYBACK_BASE` | 되감기 베이스 URL | **UI는 걷어냈지만 지우면 실시간까지 죽는다** |
| `CAMERA_STREAM_USER` | MediaMTX 스트림 계정 | `mediamtx.yml`의 `authInternalUsers`와 **같아야 한다**. 회수는 양쪽 동시 |
| `CAMERA_STREAM_PASS` | 같은 계정의 비밀번호 | 값은 이 문서에 적지 않는다 |
| `CAMERA_RETENTION_DAYS` | 카드 표시용 보관 일수 | 미설정·비수치면 7. [확인 필요: 현재 프로젝트에 실제로 설정된 값] |

### 현장 에이전트 (`control-agent/.env`)

| 이름 | 기본값 | 비고 |
|---|---|---|
| `MEDIAMTX_API_URL` | `http://127.0.0.1:9997` | `mediamtx.yml`의 `apiAddress`와 같아야 한다 |
| `MEDIAMTX_RECORD_DIR` | (빈 값) | **비면 CCTV 상태 보고 전체를 조용히 건너뛴다.** 뿌리 디렉터리는 지우면 안 된다 — 디스크 여유 보고가 깨진다 |

카메라 RTSP 계정(`CAM_RTSP_USER`·`CAM_RTSP_PASS`)은 `mediamtx.yml`이 아니라
`control-agent/.env`에 있고, 카메라 IP는 `camera-relay-all.sh`의 `CAMERAS` 배열에 있다.
어느 값도 이 문서에 옮겨 적지 않는다.

### 현장 카메라 3대

| path | 위치 | LAN IP (공유기 DHCP 예약 고정) |
|---|---|---|
| `office` | 출입구 방향 — 분쟁 때 가장 자주 다시 보게 되는 쪽 | `192.168.200.148` |
| `lounge_left` | 실내 라운지(좌) | `192.168.200.193` |
| `lounge_right` | 실내 라운지(우) | `192.168.200.134` |

카메라를 늘릴 때 손대는 곳 셋: `mediamtx.yml`의 `paths` · `camera-relay-all.sh`의 `CAMERAS` ·
어드민 등록(같은 이름). 하나라도 빠지면 카드는 뜨는데 영상만 안 나오거나, 그 반대가 된다.

### launchd 등록 2종

| Label | 무엇 | 되살리는 법 |
|---|---|---|
| `kr.nmwc.typelounge.cloudflared-cam` | 터널 | `launchctl bootout gui/$(id -u)/<Label>` → `bootstrap` |
| `kr.nmwc.typelounge.camera-relay` | 재발행 `.app` | 같은 방식. 또는 `install-camera-relay.sh` 재실행(멱등) |

둘 다 **시스템 데몬이 아니라 사용자 LaunchAgent**다 — `sudo`가 필요 없고, 시스템 데몬으로 깔면
위 재기동 명령이 대상을 못 찾는다.

## 15. 법정 고지 — 「개인정보 보호법」 §25 · 시행령 §24

### 고지 (`06-applications/guest-guide.html` `#cctv`)

| 기재사항 | 현재 값 |
|---|---|
| 설치 목적 | 범죄 예방 및 시설 안전, **예약 운영 관리** (2026-08-17 추가 — 퇴실 독려가 목적 범위 안에 들어오게) |
| 설치 장소·촬영 범위 | 현관(출입구) 방향 · 실내 라운지 |
| 촬영 시간 | 24시간 연속 촬영·녹화 |
| 보관 기간 | 촬영일로부터 7일. 지나면 자동으로 파기 |
| 관리책임자 | 노모어워크컴퍼니(NMWC) 이준용 · 0504-0905-3291 |
| 추가 고지 | 화장실 등 사생활 침해 우려 장소 비촬영 · **소리는 녹음하지 않음** · 본인 영상 열람·존재확인 요청 안내 |

> ⚠️ **고지 문구와 실제가 어긋나 있다.** "24시간 연속 촬영·녹화"·"7일 자동 파기"를 집행하던 것은
> `mediamtx.yml`의 `recordDeleteAfter`인데, 2026-08-10에 서버 녹화를 끄면서 집행 주체가 사라졌다.
> 지금 영상을 보관하는 것은 **카메라 SD카드**이고, SD는 대개 용량이 차면 오래된 것부터 덮어쓰는
> 순환 녹화라 7일이 보장되는 값이 아니다. **SD 실보관 일수는 감사 범위 밖**이지만(오너 결정
> 2026-08-13 — 감사 경계는 '우리 서버'이고 서버는 아무것도 저장하지 않는다), 손님에게 한 약속과
> 어긋날 수 있다는 사실은 남아 있다. [확인 필요: 문구를 SD 순환 기록 기준으로 고칠지, Tapo 앱에서
> 실보관 일수를 실측해 숫자를 맞출지]

### 녹음 금지 (§25⑤)

고정형 영상정보처리기기의 녹음기능 사용은 **금지**다(과태료 대상). 카메라 3대 모두 앱에서 마이크를
껐는데도 RTSP에 `pcm_alaw` 트랙이 나오는 것이 실측됐고, MediaMTX에는 받은 트랙을 버리는 설정이
없다. 방어선 셋:

1. **ffmpeg `-an` 재발행이 유일 경로다.** `paths`는 전부 `source: publisher`, `rtspAddress`는
   `127.0.0.1` 한정 — 카메라를 직접 걸 수 없는 구조로 막았다.
2. **재발행은 launchd로 저절로 살아난다**(`.app` + `KeepAlive`) + 셸 루프가 5초 뒤 재기동.
   2026-08-09에 손으로 띄운 프로세스가 죽어 40시간 공백이 생긴 뒤 만든 방어다.
3. **오디오 트랙 감지 시 카드 최상단 경고 + 에이전트 로그.** 설정으로 못 막으니 감시가 마지막
   방어다.

### 보관기간 4곳 동기화 (지금은 휴면)

서버 녹화를 다시 켜는 순간(`record: yes`) 아래 4곳이 **같은 숫자**여야 한다는 조건이 되살아난다.

| # | 어디 | 무엇 |
|---|---|---|
| 1 | `06-applications/guest-guide.html` | `#cctv`의 `보관 기간` |
| 2 | 현장 안내판 | 인쇄물 |
| 3 | `control-agent/mediamtx/mediamtx.yml` | `recordDeleteAfter` — **파기를 집행하는 유일한 주체** |
| 4 | Supabase 시크릿 | `CAMERA_RETENTION_DAYS` (어드민 표시용) |

3번만 바꾸고 나머지를 안 고치면 조용히 거짓말이 된다. 짧으면 없는 영상을 약속한 것이고, 길면
지운다고 해놓고 갖고 있는 것이다.

[확인 필요: 현장 안내판 실제 부착 여부 — `cctv-setup.md` C-0 체크박스가 비어 있다]
[확인 필요: 스페이스클라우드 리스팅 유의사항에 CCTV 고지 추가 여부 — 게스트 가이드는 이미 예약한
사람만 본다. 예약 **전**에 알 수 있어야 한다]

## 16. 운영 인프라 — 알아야 고칠 수 있는 것들

### 16-1. 터널이 태평양을 두 번 건넌다 (2026-08-10 실측)

`cam.nmwc.ai.kr` 요청이 Cloudflare **LAX(로스앤젤레스)** 엣지로 들어간다. 서울 KT 회선에서 5회
연속 측정해 전부 `cf-ray: ...-LAX`였다. 영상 경로가 **합정 맥(서울) → LA → 보는 사람(서울)**이라
세그먼트마다 태평양을 왕복하고, 실측 왕복이 **0.73~0.94초**다(같은 회선 naver.com은 0.27초).

**Cloudflare Free 플랜의 성질이지 설정 문제가 아니다** — 한국 ISP 피어링 비용 때문에 국내 트래픽을
해외 엣지로 보낸다. 터널 설정을 고쳐서는 안 된다.

| 완화 수단 | 상태 |
|---|---|
| `hlsSegmentDuration` 1s → 4s (요청 수 1/4, 라이브 윈도우 7초→28초) | **2026-08-10 적용** |
| 동시에 보는 카메라 수 줄이기 | 운영 판단 |
| Tailscale로 전환(동일 망이면 LAN 직통) | 미채택 — 보는 기기마다 Tailscale이 필요해 외부인 폰에서 안 보인다 |
| Cloudflare 유료(Argo Smart Routing) | 미채택 — 돈으로 물러나는 경로. 위를 먼저 |
| 프리플라이트 미캐싱(MediaMTX가 `Access-Control-Max-Age`를 안 보내 매 요청 앞에 OPTIONS) | 미해결. [확인 필요: 서버 설정으로 가능한지] |

`hlsSegmentCount: 7`은 기본값 그대로 둔다. 3으로 줄이면 라이브 윈도우가 3초뿐이라 터널 지터 한 번에
플레이어가 윈도우 밖으로 밀려나 끊긴다. `lowLatency`도 켜지 않는다 — 왕복이 잦아 터널 뒤에서 오히려
자주 끊기고, 얻는 건 1~2초다. "지금 저기 사람 있나"에는 3초 지연이 문제가 안 된다.

### 16-2. iPhone만 400으로 죽는다 → Transform Rule로 푼다

PC 크롬 ✅ · **맥 사파리 ✅** · iPhone 사파리 ❌. 맥 사파리가 멀쩡한 게 결정적이었다 — WebKit도
리다이렉트도 원인이 아니라는 뜻이다. 원인은 MediaMTX가 **iOS User-Agent에만** 쿠키를 요구하는 것이다
(`internal/servers/hls/http_server.go`의 `isIOS(...)` 분기 → 400).

브라우저 쪽에서 풀 방법이 없다: hls.js의 XHR은 `withCredentials=false`가 기본이라 교차 사이트 쿠키를
주고받지 않고, 켜려 해도 MediaMTX는 `Access-Control-Allow-Credentials`를 어떤 경로에서도 보내지
않는다. 어드민(`typelounge.vercel.app`)과 스트림(`cam.nmwc.ai.kr`)이 다른 사이트인 한 클라이언트
코드로는 못 푼다.

그래서 **Cloudflare Transform Rule에서 UA를 덮어써** 검사 자체가 성립하지 않게 만들었다.

| 항목 | 값 |
|---|---|
| 위치 | Cloudflare → `nmwc.ai.kr` → Rules → Create rule → *Request Header Transform Rule* |
| 이름 | `cam: strip iOS UA` |
| 조건 | `Hostname` equals `cam.nmwc.ai.kr` |
| 동작 | **Set static** — Header `User-Agent` = `TypeLounge-Viewer/1.0` |

Free 플랜에 포함되고 Workers가 아니라 **요청 한도가 없다**(세그먼트 요청이 초당 여러 건이라
Workers 무료 한도 10만/일로는 아슬아슬하다).

> ⚠️ **이 규칙이 꺼지거나 지워지면 iPhone에서만 400으로 죽는다.** PC는 멀쩡해서 눈치채기 어렵다 —
> iPhone 제보가 오면 여기부터 본다. `?debug=1`로 열면 카드에 `http=400`이 보인다.
>
> ⚠️ **어드민 URL에 `?cookieCheck=1`을 붙이는 우회는 하지 마라.** 2026-08-10에 한 번 넣었다가
> 걷어냈다 — 302를 건너뛰게 만들어 **Set-Cookie를 받을 기회마저 없애서 오히려 나빠진다.**

### 16-3. macOS 26 TCC — ffmpeg를 launchd에 그냥 못 올린다

**macOS 26은 로컬 네트워크 접근을 바이너리 단위로 통제한다.** launchd가 띄운 Homebrew ffmpeg는
카메라 IP에 `No route to host`가 나고, **같은 스크립트를 터미널에서 돌리면 된다**(터미널의 권한을
자식이 물려받는다). 예전 설정이 손으로 띄운 프로세스였던 것도 그래서 우연히 작동했고, 그게 죽었을 때
아무도 못 살린 이유이기도 하다.

| 시도 | 결과 |
|---|---|
| LaunchAgent에서 `camera-republish.sh` 직접 실행 | ❌ `No route to host` |
| 시스템 설정 › 로컬 네트워크에서 허용 | ❌ **목록에 ffmpeg 항목 자체가 없다** |
| 셸 스크립트를 실행 파일로 둔 `.app` (launchd) | ❌ 같은 오류 |
| 같은 `.app`을 `open`으로 실행 | ❌ 같은 오류, 권한 프롬프트도 없음 |
| LaunchAgent → `osascript` → Terminal | ❌ 자동화 권한이라는 또 다른 벽 |
| **네이티브 바이너리를 실행 파일로 둔 `.app`** | ✅ **통과** |

마지막 줄이 지금 방식이다. 셸 스크립트를 실행 파일로 두면 프로세스가 `/bin/bash`로 잡혀 번들이
권한 주체로 인식되지 않는다. **`relay-launcher.c`는 오직 권한 주체가 되기 위해 존재한다** — 하는
일은 `camera-relay-all.sh`를 `exec` 하는 것뿐이다. `Info.plist`에 `NSLocalNetworkUsageDescription`을
넣고 ad-hoc 서명한다.

launchd 전체가 막힌 게 아니다. Apple 서명 도구인 `nc`는 launchd에서도 카메라 554에 붙는다 —
**ffmpeg 바이너리만** 막힌다.

## 17. 의존성·관련 스펙

| 스펙 | 관계 |
|---|---|
| `spec_admin_auth` | admin 비밀번호 판정(`auth.ts`)이 CCTV 4개 action의 유일한 관문. 이 비밀번호는 스트림 자격증명뿐 아니라 예약자 이름·연락처를 여는 `admin_*` RPC의 열쇠이기도 하다 |
| `spec_space_control` | `control` Edge Function·`control-agent` 프로세스·`device_events` 장부·`automate` 틱을 공유한다. 에이전트가 CCTV 설정 없이도 조명·냉난방을 계속 돌려야 하는 제약이 여기서 나온다 |
| `spec_reservation_automation` | `automate` 틱에 `checkConnectivity()`가 얹혀 있다. 전용 크론이 없다 |

## 파일(페이지) 구성

| 파일 | 경로 | 설명 |
|---|---|---|
| `20260803170000_cameras.sql` | `supabase/migrations/20260803170000_cameras.sql` | `cameras`·`camera_state` 테이블 + RLS |
| `cameras.ts` | `supabase/functions/control/cameras.ts` | 접근 계층 · `isStale`/`neverSeen` · 180초 상수 |
| `cameras.ts` | `supabase/functions/control/handlers/cameras.ts` | 4개 action 핸들러 · 시크릿 4개 게이트 · path 문법 |
| `index.ts` | `supabase/functions/control/index.ts` | action 라우팅 |
| `auth.ts` | `supabase/functions/control/auth.ts` | 역할 판정 — CCTV는 admin 전용 |
| `connectivity.ts` | `supabase/functions/control/automation/connectivity.ts` | 끊김·복구 전환 판단(`decideTransition`) |
| `connectivity.test.ts` | `supabase/functions/control/automation/connectivity.test.ts` | 위 순수 함수 검증 |
| `events.ts` | `supabase/functions/control/automation/events.ts` | `camera_offline`/`camera_recovered` 기록·조회 |
| `message.ts` | `supabase/functions/control/automation/message.ts` | Mattermost 본문 조립 |
| `admin.html` | `06-applications/admin.html` | CCTV 탭 — 카드·재연결 상태머신·등록 모달 (약 2260~2725행) |
| `admin-retry.test.js` | `06-applications/admin-retry.test.js` | 재연결 상태머신 검증(CI) |
| `guest-guide.html` | `06-applications/guest-guide.html` | 손님 고지 `#cctv` 섹션 |
| `cameras.js` | `06-applications/control-agent/src/cameras.js` | 30초 상태 보고 · 오디오 감시 |
| `config.js` | `06-applications/control-agent/src/config.js` | `MEDIAMTX_API_URL`·`MEDIAMTX_RECORD_DIR` |
| `mediamtx.yml` | `06-applications/control-agent/mediamtx/mediamtx.yml` | MediaMTX 설정 템플릿 (`record: no`) |
| `camera-republish.sh` | `06-applications/control-agent/camera-republish.sh` | ffmpeg `-an` 재발행 (path 1개) |
| `camera-relay-all.sh` | `06-applications/control-agent/camera-relay-all.sh` | 3대 병렬 기동 + 자동 재기동 |
| `install-camera-relay.sh` | `06-applications/control-agent/install-camera-relay.sh` | `.app` 빌드 · 서명 · LaunchAgent 등록 |
| `relay-launcher.c` | `06-applications/control-agent/relay-launcher.c` | TCC 권한 주체용 네이티브 런처 |
| `cctv-setup.md` | `06-applications/cctv-setup.md` | 현장 설치 절차 정본(C-0~C-9) + 증상별 진단표 |
| `control-setup.md` | `06-applications/control-setup.md` | 냉난방·조명 절차 정본 (같은 에이전트를 공유) |

## 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-14 | 최초 작성 — 라이브 구현(PR #10~#80)을 역기획으로 정리 |
