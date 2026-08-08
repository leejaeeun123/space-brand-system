# 공간 제어 설치 체크리스트

> **합정 맥에서 처음부터 세팅하는 중이라면 [`onsite-handoff.md`](./onsite-handoff.md)를 먼저 읽는다.**
> 뭐가 이미 끝났고 오늘 어디까지 하는지가 거기 있다.
>
> **이 문서가 절차의 유일한 출처다.** 설계 배경과 문제 해결은 각 README에 있다:
> 냉난방 → [`supabase/functions/control/README.md`](../supabase/functions/control/README.md) ·
> 조명 → [`control-agent/README.md`](./control-agent/README.md)

두 갈래가 서로 독립이다. **A만 해도 냉난방은 돌아간다.** B가 막혀도 A는 영향 없다.

| | 어디서 | 걸리는 시간 | 맥이 필요한가 |
|---|---|---|---|
| **A. 냉난방 (LG ThinQ)** | 어디서나 | ~5분 | ❌ |
| **B. 조명 (Tasmota)** | 합정 현장 | ~40분 | ✅ 상주 |
| **G. 손님 제어 페이지** | 어디서나 | ~2분 | ❌ |

> **G는 A나 B가 끝난 뒤에 한다.** 켤 기기가 없으면 손님 화면에 빈 목록만 뜬다.

> **CCTV(C)는 [`cctv-setup.md`](./cctv-setup.md)에 따로 있다.** 같은 맥을 쓰지만 여기와 독립이라
> 절차를 섞지 않았다 — 영상은 서버를 지나가지 않아서 경로가 통째로 다르고, 무엇보다 카메라는
> **법·고지가 선행**이라 순서가 뒤엉키면 안 된다.

---

## A. 냉난방

### A-1. LG ThinQ 앱에 에어컨 등록

합정 에어컨을 **형운 LG 계정**에 등록한다.

> Space 스펙에 기기 별칭이 `타입라운지-1호점`으로 실측 기록돼 있지만 그건 **유재형 계정** 기준이다.
> 같은 기기라도 계정이 다르면 새로 등록해야 한다.

### A-2. 개발자 키 3종 발급

https://smartsolution.developer.lge.com

- [ ] `PAT` (Personal Access Token)
- [ ] `client-id` — **한 번 만들어 고정한다.** 요청마다 새로 만들지 않는다.
- [ ] `api-key`

### A-3. 서버에 넣기

```bash
cd <이 레포>
supabase secrets set THINQ_PAT=<PAT> THINQ_CLIENT_ID=<client-id> THINQ_API_KEY=<api-key>
```

**재배포는 필요 없다.** 다음 호출부터 적용된다.

기본값이 있어 안 넣어도 되는 것: `THINQ_COUNTRY`(KR) · `THINQ_BASE_URL`(`api-kic.lgthinq.com`) ·
`THINQ_TIMEOUT_MS`(10000).

### A-4. 확인

```bash
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
  -d '{"action":"list","password":"<admin 비밀번호>"}'
```

`"thinq_configured":true` 가 나오면 키가 제대로 들어간 것이다.

### A-5. 기기 등록

`admin.html` → **공간 제어** → `ThinQ 기기 불러오기` → 에어컨의 `등록` → 이름 입력.

등록 시 **기기 프로파일을 1회 읽어 온도범위·모드·풍량을 파생해 저장한다.** 하드코딩하지 않는
이유는 Space의 실측 결론이다 — 문서 예시와 실기기가 step·모드·풍량 **세 군데에서 달랐다**(ss-4er).

- [ ] 카드가 뜨고 전원·온도·모드·풍량이 보인다
- [ ] 켜기/끄기가 실제 에어컨에 반영된다

---

## B. 조명

```
Tasmota ──평문 1883──> mosquitto ──> [에이전트] ──HTTPS/WSS──> Supabase ──> admin.html
         (LAN)          (합정 맥)                  (아웃바운드만)
```

**인바운드 포트를 열지 않는다.** 두 방향 다 맥이 나가서 맺는 연결이라 포트포워딩·DDNS·터널이
전부 불필요하다.

> **왜 맥이 필요한가**: Tasmota 기기가 LAN 평문 MQTT로만 붙게 돼 있다(ESP8266은 TLS가 버겁다).
> 그래서 같은 LAN 안에 브로커가 있어야 한다. 냉난방은 클라우드 API라 맥과 무관하다 —
> **맥이 꺼지면 조명만 멈춘다.**

### B-1. 맥이 잠들지 않게

에이전트가 자면 조명이 죽는다. 노트북이면 **덮개를 닫아도 안 자게** 해야 한다.

```bash
sudo pmset -a sleep 0 disablesleep 1
pmset -g | grep -E 'sleep|disablesleep'
```

- [ ] 전원 어댑터 연결 상태로 둔다

### B-2. 맥 IP 고정

Tasmota가 이 IP로 붙는다. DHCP로 바뀌면 **조명이 조용히 먹통**이 된다.

```bash
ipconfig getifaddr en0    # 무선. 유선이면 en1 등
```

- [ ] 공유기에서 이 맥의 MAC 주소에 **DHCP 예약**을 건다
- [ ] IP를 적어둔다 → `<맥IP>`

### B-3. mosquitto

```bash
brew install mosquitto
```

**비밀번호를 먼저 만든다.** 설정 파일이 이 파일을 요구하므로, 없으면 mosquitto가 시작에
실패한다 — 조용히 열린 채로 뜨는 것보다 낫다.

```bash
mosquitto_passwd -c "$(brew --prefix)/etc/mosquitto/passwd" typelounge
```

- [ ] 비밀번호를 적어둔다 → `<브로커비번>`

설정 적용 + 시작 (Intel 맥이면 `sed`가 `/usr/local`로 바꿔준다):

```bash
cd 06-applications/control-agent
PREFIX="$(brew --prefix)"
sed "s|/opt/homebrew|$PREFIX|g" mosquitto/mosquitto.conf > "$PREFIX/etc/mosquitto/mosquitto.conf"
mkdir -p "$PREFIX/var/lib/mosquitto" "$PREFIX/var/log/mosquitto"
brew services start mosquitto
```

확인 — **인증 없이는 거부되고, 계정으로는 붙어야** 정상이다:

```bash
mosquitto_sub -h localhost -t 'test/#' -C 1 -W 3                                  # 거부돼야 정상
mosquitto_sub -h localhost -u typelounge -P '<브로커비번>' -t 'test/#' -C 1 -W 3   # 붙어야 정상
```

### B-4. 에이전트

```bash
cd 06-applications/control-agent
npm install
cp .env.example .env
```

`.env` 채우기:

| 키 | 값 |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | 대시보드 → Project Settings → API → **service_role** |
| `MQTT_USER` | `typelounge` |
| `MQTT_PASSWORD` | `<브로커비번>` |

> ⚠️ service_role 키는 DB 전체 권한이다. **이 맥이 곧 신뢰 경계**다 — 분실하면 대시보드에서
> 키를 회전시켜야 한다. `.env`는 커밋되지 않는다.

포그라운드로 먼저 띄운다:

```bash
npm start
```

- [ ] `[agent] 조명 기기 N대 로드`
- [ ] `[mqtt] 연결됨 — 구독: stat/+/#, tele/+/#`
- [ ] **`[realtime] SUBSCRIBED`** ← 이게 안 뜨면 여기서 멈춘다. 명령이 안 온다.

### B-5. Tasmota 기기 (기기마다 반복)

공유기 접속기기 목록에서 `tasmota_XXXXXX` 를 찾아 웹UI에 들어간다. **Console** 탭:

```
Backlog MqttHost <맥IP>; MqttPort 1883; MqttUser typelounge; MqttPassword <브로커비번>; PowerRetain 1
```

기기 이름을 정한다. 이게 admin에 등록할 **기기 ID**다 (영숫자·`_`·`-`, 32자 이내):

```
Topic light_main
```

토픽 구조 확인:

```
FullTopic
```

- [ ] `%prefix%/%topic%/` 이어야 한다. 다르면 `FullTopic %prefix%/%topic%/` 로 되돌린다.
- [ ] 에이전트 로그에 `[state] ... ← LWT=Online` 이 뜬다

> Space는 여기에 space_id 세그먼트를 더 끼웠지만(`%prefix%/spc_xxx/%topic%/`), 그건 AWS IoT라는
> **공용 브로커**를 여러 공간이 나눠 쓰기 때문이었다. 이 브로커는 전용이라 나눌 상대가 없어
> 기본값을 그대로 쓴다 — 설정 실수 여지가 하나 줄어든다.

### B-6. admin 등록

`admin.html` → **공간 제어** → 조명 등록에 `light_main` + 부를 이름.

- [ ] 카드가 뜬다
- [ ] 켜기/끄기가 실제 조명에 반영된다

### B-7. 자동 시작 (B-6 확인 끝난 뒤에)

```bash
cd 06-applications/control-agent
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/kr.nmwc.typelounge.control-agent.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>kr.nmwc.typelounge.control-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>--env-file=$(pwd)/.env</string>
    <string>$(pwd)/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(pwd)/agent.log</string>
  <key>StandardErrorPath</key><string>$(pwd)/agent.err.log</string>
</dict></plist>
PLIST
launchctl load ~/Library/LaunchAgents/kr.nmwc.typelounge.control-agent.plist
tail -f agent.log
```

`--env-file`은 Node 20.6+ 에서 된다. launchd는 `.env`를 자동으로 읽지 않으므로 이게 필요하다.

- [ ] 맥을 재부팅해도 `agent.log`에 `SUBSCRIBED`가 다시 뜬다

---

## G. 손님 제어 페이지

손님이 `/control`에서 조명·냉난방을 조작할 수 있는 페이지다(`guest-control.html`).
비밀번호 게이트는 없다 — 현관 비밀번호가 사이트 루트(`guest-guide.html`)에 이미 평문 공개돼
있어 별도 장벽이 아니었다. 대신 등록·해제·CCTV는 서버(`auth.ts`)가 여전히 잘라낸다:
손님(비밀번호 미제출)이 부를 수 있는 건 목록 조회와 조명·냉난방 조작뿐이다.

### G-1. 확인

```bash
# 비밀번호 없이 list는 되고
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
  -d '{"action":"list"}'

# 등록 해제는 403이어야 한다
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
  -d '{"action":"delete","device_id":"아무거나"}'
```

- [ ] `list`는 기기 목록이 온다 (`address` 필드는 없는 게 정상이다 — 손님에겐 안 내린다)
- [ ] `delete`는 `"이 페이지에서는 조명·냉난방 조작만 할 수 있어요"` 403
- [ ] `/control`에서 켜기/끄기·온도·모드·풍량이 실제 기기에 반영된다

### G-2. 손님에게 알리기

- `guest-guide.html`의 **조명 · 냉난방** 항목에 `/control` 링크가 이미 들어 있다
- 현장 안내판은 `_notice-control.html`(QR 시안)을 인쇄한다. QR은 열 때 만들어지므로
  주소를 바꾸려면 파일 안 `CONTROL_URL` 한 줄만 고친다

## H. 예약 자동화

예약에 맞춰 냉난방·조명을 자동으로 움직인다. A·G가 끝난 뒤에 의미가 있다 — 켤 기기가
없으면 아무 일도 안 일어난다. 네 가지를 한다:

| 언제 | 무엇을 |
|---|---|
| 입실 15분 전 | 냉난방 전원→**냉방**→26도, 조명은 나이트모드 조합 |
| 퇴실 시각 | 전원 가능한 기기 전부 끄기 |
| 퇴실 후 10분 | 켜지는 기기를 매 분 다시 끄기(**다음 예약이 바로 붙어 있으면 안 돈다**) |
| 이용 중 | 목표온도가 24도 미만으로 5분 넘게 가동하면 24도로 되돌리기 |

### H-1. 배포 확인

```bash
supabase db push   # 20260807000000(pg_cron 잡) + 20260807010000(온도 하한 감시 테이블)
```

Supabase 대시보드 → **Database → Cron Jobs**에서 `reservation-automation`이 매분 도는지 확인한다.

### H-2. 수동 트리거로 확인

```bash
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
  -d '{"action":"automate"}'
```

- [ ] `{"prep_fired":0,"shutdown_fired":0,"swept":0,"temp_corrected":0,"reservations":N}` 같은 응답이 온다
- [ ] 입실 15분 전인 예약이 있을 때 냉난방이 **냉방** 26도로 켜지고 조명이 나이트모드 조합으로 바뀐다
- [ ] 퇴실 시각인 예약이 있을 때 모든 기기가 꺼진다
- [ ] 퇴실 직후 10분 안에 조명을 손으로 켜보면 다음 분에 다시 꺼진다
- [ ] 다음 예약이 바로 붙은 경우엔 스윕이 돌지 **않는다**(다음 손님 준비가 살아있어야 한다)
- [ ] 냉난방을 22도로 내리고 5분을 기다리면 24도로 되돌아온다(그 전에는 22도 그대로 둔다)

---

## I. 조작 알림 (Mattermost)

기기가 움직이면 채널로 알린다. 자동/원격(어드민·손님)/현장을 구분한다.

### I-1. 웹훅 넣기

예약 알림과 같은 채널을 쓴다. 같은 웹훅 URL을 Edge Function 시크릿으로도 넣는다:

```bash
supabase secrets set MATTERMOST_WEBHOOK_URL='<예약 알림에 쓰는 그 URL>'
```

**재배포는 필요 없다.** 다음 호출부터 적용된다. 안 넣으면 알림만 조용히 건너뛴다(제어는 정상).

> 기기 알림이 잦아 예약 알림을 덮으면, 채널을 새로 파고
> `supabase secrets set MATTERMOST_DEVICE_WEBHOOK_URL='<새 URL>'` 만 하면 분리된다.
> 코드는 고치지 않는다.

### I-2. 확인

- [ ] 어드민이나 `/control`에서 조명을 켜면 1분 안에 **원격 조작** 알림이 온다
- [ ] 현장에서 벽 스위치로 조명을 켜면 1분 안에 **현장 조작** 알림이 온다
- [ ] 입실 준비가 돌면 기기별 한 줄짜리 표가 **한 건**으로 온다(명령마다 따로 오지 않는다)
- [ ] 손님이 온도를 여러 번 눌러도 한 줄로 합쳐 최종값만 온다

---

## 막혔을 때

| 증상 | 확인 |
|---|---|
| A-4에서 `thinq_configured:false` | 시크릿 3개가 다 들어갔나. 하나라도 비면 미설정으로 본다 |
| `/control`이 404 | `public/control.html` 심링크와 배포 워크플로 경로(`deploy.yml`) |
| A-5에서 `ThinQ 인증 실패` | PAT 만료. **재시도해도 소용없다** — 재발급이 유일한 길이다 |
| B-4에서 `SUBSCRIBED`가 안 뜬다 | service_role 키, 인터넷. 이게 없으면 명령이 안 온다 |
| 조명 카드가 "아직 상태를 받은 적 없음" | 기기가 브로커에 못 붙음. Console에서 `MqttHost`·`MqttUser` 확인 |
| 눌러도 반응 없음 | `agent.log`에 `[cmd] 발행`이 있나 → 있으면 기기 쪽, 없으면 Realtime 쪽 |
| `[cmd] 만료 — 실행하지 않음` | **정상이다.** 60초 넘은 명령은 일부러 버린다 (아래) |
| 어제까지 되던 조명이 먹통 | B-2 DHCP 예약이 풀렸는지 |
| `automate` 응답은 오는데 기기가 안 움직인다 | 대상 예약의 `date`+`start_time`/`end_time`이 실제로 그 창 안인지, `cancelled`가 false인지 확인 |
| 퇴실 후 스윕이 도는데 손님이 아직 있다 | 예약의 `end_time`이 실제 퇴실보다 이른지 확인. 연장했으면 어드민에서 `end_time`을 먼저 고친다 |
| 우리가 켠 조명이 "현장 조작"으로 온다 | 대조 창(120초)보다 조명 반영이 느렸다는 뜻. `agent.log`에서 발행 지연을 본다 |
| 알림이 아예 안 온다 | `MATTERMOST_WEBHOOK_URL` 시크릿이 들어갔는지. 없으면 제어는 되고 알림만 건너뛴다 |
| 같은 알림이 두 번 온다 | 발송은 됐는데 발송 표시가 실패한 경우다. 유실보다 중복이 낫다고 보고 이 방향으로 뒀다 |
| 온도를 낮춰도 되돌려지지 않는다 | 이용 중(입실 15분 전~퇴실)에만 동작한다. 에어컨이 켜져 있어야 하고(꺼지면 시계 해제), 5분을 채워야 한다 |

## 알아둘 것

- **오래된 명령은 실행하지 않는다.** 맥이 꺼져 있던 동안 쌓인 명령을 재생하면 **새벽 3시에
  조명이 켜진다.** 60초가 지나면 `expired`로 버린다. 늦은 실행보다 미실행이 안전하다.
- **조명의 `sent`는 '기기가 실행했다'가 아니다.** 브로커에 발행했다는 뜻이다. 실제 반영은
  기기가 `stat`으로 보고하고 에이전트가 `device_state`에 쓴다. 냉난방(HTTP 동기)은 반대로
  한 호출에서 `acked`로 확정된다.
- **`모름`은 `꺼짐`이 아니다.** 연결이 끊겨도 마지막 전원값은 유지된다 — `LWT=Offline`은
  `online`만 바꾸고 `power`는 건드리지 않는다. 합치면 꺼진 줄 알았는데 켜져 있는 상황,
  즉 **냉난방이 밤새 도는 상황**이 조용히 숨는다.
- **예약 자동화의 창도 10분이다.** 스케줄러가 10분 넘게 밀리면 그 예약은 자동화를 건너뛴다(조명의
  60초 TTL과 같은 철학) — `checkin_automation_at`/`checkout_automation_at`은 채워져 있는데 기기가
  안 움직였다면 이 경우일 수 있다.
- **퇴실 후 스윕은 `켜짐`으로 보고된 기기만 끈다.** `모름`은 건드리지 않는다 — 상태를 한 번도
  못 받은 기기까지 끄려들면 10분 내내 매 분 명령이 나가 조명 큐만 쌓인다.
- **다음 예약이 붙으면 스윕이 멈춘다.** 다음 예약의 준비 시각(입실 15분 전)이 이미 지났으면
  그건 다음 손님을 위해 켠 것이라 끄면 안 된다. 퇴실했는데도 불이 안 꺼졌다면 먼저 이걸 의심한다.
- **현장 조작은 추론이지 관측이 아니다.** 벽 스위치·리모컨은 서버를 거치지 않아 볼 방법이 없다.
  "상태가 바뀌었는데 우리가 시킨 적 없음"으로 역산하므로, 우리 명령이 장부에 안 남으면 그게
  현장 조작으로 둔갑한다.
- **예약 시각은 KST로 읽는다.** Edge Function 런타임은 UTC라 오프셋을 명시하지 않으면 자동화가
  **9시간 어긋난 채로** 돌아간다(실제로 한 번 이렇게 틀렸다). 자동화가 엉뚱한 시각에 돈다면
  이걸 의심한다.
- **키를 브라우저에 두지 않는다.** ThinQ PAT와 service_role 키는 Edge Function과 합정 맥에만
  있다. `admin.html`은 소스가 공개되므로 거기 들어가면 계정 전체가 노출된다.
- **손님이 할 수 있는 일은 서버가 자른다.** `guest-control.html`에서 버튼을 감추는 건 방어가
  아니다 — 소스가 공개되므로 누구나 `fetch`로 `delete`를 부를 수 있다. 실제로 막는 곳은
  `auth.ts` 한 군데다.

## 아직 검증 안 된 것

**실기기로는 확인하지 못했다.** 냉난방은 PAT가 없어 ThinQ 왕복을 못 돌렸고, 조명은 가짜
Tasmota로 프로토콜만 확인했다. 실기기 펌웨어·실제 mosquitto 동작은 이 절차를 밟으면서
처음 확인된다. B-5에서 막히면 `Backlog` 대신 한 줄씩 넣어본다.

**손님 페이지(G)는 서버까지만 확인됐다.** 2026-08-06 배포 후 G-3의 세 가지는 실제 함수에
대고 통과했다 — 현관 비밀번호로 `list` 200(기기 6개, `address` 없음) · `delete` 403 ·
틀린 비번 401. 하지만 **`/control`에서 켠 것이 실기기에 반영되는지는 확인하지 못했다.**
조명의 `sent`는 브로커에 발행했다는 뜻일 뿐이라(위 '알아둘 것') 응답이 성공이어도 실제로
켜졌다는 증거가 아니다. 현장 맥과 실기기 앞에서 G-3의 마지막 체크박스를 직접 밟아야 한다.

그때까지 **현장 안내판(`_notice-control.html`) QR은 인쇄하지 않는다.** 붙인 안내판을
되돌리려면 사람이 현장에 다시 가야 한다.

**예약 자동화(H)는 전부 실증됐다.** 2026-08-08 00:05~00:31, 실제 예약(임시 생성 후 삭제)을
창에 통과시켜 **`automate`를 한 번도 수동 호출하지 않고** pg_cron이 스스로 띄우는 것까지 확인:

| 시각 | 확인된 것 |
|---|---|
| 00:05:03 | 입실 준비 자동 실행 — 냉방 26도 + **SiHAS만 OFF, 나머지 조명 4개 ON**(나이트모드 조합) |
| 00:13:15 | 온도 하한 — 22도로 내린 것을 5분 뒤 24도로 복귀. **끄지 않고 온도만 되돌린다** |
| 00:30:10 | 퇴실 종료 — 전 기기 OFF |
| 00:31:12 | 퇴실 후 스윕 — 창 안에서 켠 조명을 31초 만에 다시 끔 |

함께 확인된 기기 사실:

- 에어컨 프로파일에 `COOL` 있음, `temp {min:18, max:30, step:0.5}` → 26·24 모두 격자에 맞음
- **전원→모드→온도 순서가 목표온도를 지킨다**(모드 변경이 온도를 되돌리는 기종이 아니었다.
  그래도 순서는 유지한다 — 기기가 바뀌면 다시 문제가 된다)
- 조명은 큐→에이전트→기기→`stat` 보고 전 구간 동작. **손님 페이지(G)의 마지막 체크박스도
  이걸로 함께 확인됐다**

> 검증용 예약은 `admin_add_reservation`으로 만들고 끝난 뒤 `admin_delete_reservation`으로
> 지웠다. 스윕·온도 하한은 `isOccupied`가 참일 때만 돌므로, 이 방식 말고는 검증할 길이 없다 —
> 다음에 같은 걸 확인할 때도 임시 예약을 만들었다 지우는 편이 빠르다.

**조작 알림(I) — 발송 경로는 실증됐고, 현장 조작 판별만 남았다.** 2026-08-07 실기기로 확인:

- 원격 명령 → 장부 → 묶기 → 웹훅 → 채널 전 구간 도달(`notified` 증가로 확인)
- **선점이 중복 발송을 막는다** — 같은 틱을 두 번 불러도 두 번째는 `notified:0`
- **우리 명령은 현장 조작으로 오탐되지 않는다** — 조명·에어컨을 API로 조작한 직후 `onsite:0`

아직 못 본 것은 **진짜 현장 조작이 잡히는지** 하나뿐이다. 벽 스위치를 눌러봐야 알 수 있고,
이건 현장에 사람이 있어야 한다. 함께 확인할 것: 대조 창 120초가 실제 조명 반영 지연보다
넉넉한지 — 짧으면 우리가 켠 조명이 매번 현장 조작으로 알려져 알림 전체를 믿을 수 없게 된다.
2026-08-07~08 실측에서 조명 반영은 **12~31초**에 끝났으므로 여유는 커 보이나, 에이전트가
밀렸을 때의 최악 경로(큐 TTL 60초를 거의 다 쓰는 경우)는 재현하지 못했다.


### 2026-08-08 보강분 — 배포됨, 다만 확인된 건 절반이다

리뷰에서 나온 결함을 고친 묶음(PR #32). **2026-08-08 11:30 KST에 마이그레이션과 함수를
둘 다 올렸다.**

올린 순서(다음에 같은 걸 할 때도 이 순서다):

```bash
supabase db push                      # 20260808000000_device_events_idle.sql
supabase functions deploy control
```

마이그레이션이 먼저다 — 새 코드가 `kind='idle'`과 `device_id=null`을 쓰는데, 제약이 안 풀린
상태로 함수만 올라가면 그 insert가 조용히 실패한다(`record`는 던지지 않고 로그만 남긴다).

**배포 직후 확인된 것**(pg_cron과 똑같은 호출로):

```
{"prep_fired":0,"shutdown_fired":0,"swept":0,"temp_corrected":0,
  "onsite":0,"idle":0,"notified":0,"reservations":4}   HTTP 200
```

- 함수가 살아있고 새 `idle` 카운터가 응답에 있다 = 새 코드가 돌고 있다
- `reservations: 4` — 조회 범위를 어제~**내일**로 넓힌 것이 동작한다
- 그 시각 전 기기가 OFF였으므로 `idle: 0`이 맞는 값이다 — **경보가 뜨는 걸 본 건 아니다**

아직 확인 안 된 것 — 전부 사람이 현장에서거나 시간을 들여야 볼 수 있다:

| 무엇 | 어떻게 | 왜 봐야 하나 |
|---|---|---|
| 유휴 경보 | **벽 스위치를 손으로 켜고** 1분 기다린다 | 새로 도는 유일한 규칙이다. 안 뜨면 `device_events`에 `kind='idle'` 행이 있는지부터 본다(있으면 알림, 없으면 제약) |
| 사람 면제 | 어드민에서 켠 직후엔 경보가 **안 떠야** 한다 | 이게 안 되면 청소·예열 때마다 채널이 울린다 |
| 전환 만료 알림 | 재현이 어렵다 — 지난 시각으로 임시 예약을 만들면 첫 틱에 `expired`로 뜬다 | '공간 전체' 한 줄이 ⚠️로 뜨는지, `device_id=null` insert가 실제로 되는지 |
| 현장 조작 대조 창 | 빈 시간(예약 없음)에 어드민으로 조명을 켜고 10분 관망 | **이번 변경의 핵심**이다. 상수상 예전엔 여기서 우리 명령이 '현장 조작'으로 뜨게 돼 있었다(실제로 본 건 아니다). 안 떠야 맞다 |
| 관측 구간 표기 | 현장 조작 알림이 뜨면 `(08:37~08:47 사이)` 꼴인지 | 시각 하나로 찍혀 조작 시각처럼 읽히던 것을 고친 부분 |

> **어드민에서 켜서는 유휴 경보를 못 테스트한다.** 그러면 `remote_admin` 이벤트가 남고,
> 경보는 최근 1시간 안에 사람이 만진 기기를 면제하므로 안 뜬다 — 그건 고장이 아니라 설계다
> (윗줄의 '사람 면제'가 바로 그걸 보는 항목이다). 손으로 켜거나, 어드민으로 켜둔 뒤
> 1시간을 기다려야 한다.

> **되돌리는 법**: 코드는 이전 커밋으로 되돌리면 되지만 마이그레이션은 아니다. 되돌릴 일이
> 생기면 `kind` 제약만 원래대로 좁히고 `device_id`의 not null은 **그대로 둔다** — 이미
> null 행이 들어갔다면 not null을 되살릴 수 없다.

아래 둘은 로직상 확실하지만 실행으로 확인된 것은 아니다:

- **자정 직후(00:00~00:05) 시작 예약의 입실 준비 누락** — 조회 범위를 하루 늘려 고쳤다.
  실제로 그 시간대 예약이 잡힌 적이 없어 사고로 드러난 적은 없다.
- **알림 순서** — `claimPending`의 반환 순서가 보장되지 않던 것을 정렬로 확정했다. 지금까지
  맞아 보인 건 갓 넣은 행의 물리 순서가 우연히 id 순서와 같았기 때문이고, 30일 정리 크론이
  페이지를 회수하기 시작하면 깨진다.
