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

> ⚠️ **`public/`(→ `typelounge.vercel.app`)은 main에 머지하면 자동 배포된다.** GitHub Actions의
> `deploy.yml`이 돌아 프로덕션에 올린다(2026-08-10 실증: 머지 1분 뒤 라이브 페이지에 반영됐고,
> `vercel inspect`의 배포 생성 시각이 Actions 실행 시각과 일치했다).
>
> **단 트리거 경로에 걸린 파일을 고쳤을 때만 돈다.** `public/*.html`은 `06-applications/`로의
> 심링크라, 대상 파일만 고치면 심링크는 그대로여서 `public/**`에 안 걸린다. 2026-08-09에
> "PR 4개를 머지했는데 사이트가 그대로"였던 건 배포가 수동이어서가 아니라 **당시 트리거가
> `cleaning-done.html`을 빠뜨렸기 때문**이다. 지금은 `06-applications/*.html` 글로브라 해소됐다.
>
> ⚠️ **`vercel inspect`에 git 커밋 메타데이터가 없는 건 자동 배포가 아니라는 증거가 아니다.**
> Actions는 Git 연동이 아니라 토큰으로 `vercel deploy`를 부르므로 메타데이터가 안 붙는다.
> 2026-08-09에 이걸 근거로 "수동 배포 프로젝트"라고 오진했다 — 반영 여부는 **라이브 페이지를
> 직접 보고** 판정한다.
>
> `supabase/functions/`(Edge Function)는 **여전히 자동이 아니다** — 따로 배포해야 한다.

```bash
# 반영됐는지 확인 (cleanUrls 때문에 .html은 308 → -L 필수)
curl -sL https://typelounge.vercel.app/admin | grep -c '<찾는 문자열>'

# Edge Function은 수동
supabase functions deploy control

# 배포가 안 걸렸거나 급할 때만 (평소엔 머지로 충분하다)
vercel --prod --yes
```

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
Tasmota ──평문 1883──> RPi mosquitto ──rpi-bridge(tailscale)──> 맥 mosquitto ──> [에이전트]
         (LAN)                                                    (합정 맥)         │
                                                                                    │ HTTPS/WSS
                                                                                    ▼
                                                                        Supabase ──> admin.html
```

기기가 붙는 브로커는 **RPi**고, 맥 브로커는 그걸 브릿지로 받아온다.

**인바운드 포트를 열지 않는다.** 두 방향 다 맥이 나가서 맺는 연결이라 포트포워딩·DDNS·터널이
전부 불필요하다.

> **명령은 맥 브로커에서 두 갈래로 나간다.** `rpi-bridge`(tailscale)의 `cmnd/# out` 이
> QoS 0 이라, 그 링크가 끊긴 순간의 명령은 큐에 쌓이지도 않고 사라진다. 그래서 맥 브로커는
> 같은 `cmnd/#` 를 `aws-iot-cmnd-bridge` 로 **항상 병렬로** 내보내고, RPi 는 자체 AWS 브릿지로
> 그걸 직접 구독한다 — tailscale 과 무관한 두 번째 길이다. **조건부가 아니라 항상**인 이유는
> mosquitto 에 "다른 브릿지가 죽었을 때만" 을 표현할 방법이 없어서고, 그래도 되는 이유는
> 우리가 보내는 명령이 전부 멱등(`POWER ON`/`POWER OFF`)이라 두 번 닿아도 결과가 같아서다.
>
> 그래도 기기가 4초 안에 `stat` 으로 답하지 않으면 에이전트가 기기 HTTP 로 한 번 더 보낸다.
> 기기가 맥과 같은 LAN(`192.168.200.0/24`)에 있어 가능한 우회다.
>
> ⚠️ **한 접두사를 두 브릿지가 반대 방향으로 실으면 무한 루프가 된다.** mosquitto 는 "들어온
> 브릿지로 되돌려 보내지 않기"만 하고 **다른 브릿지로 나가는 건 막지 않는다.** 그래서
> `tele`/`stat` 은 `aws-iot-bridge` 만 `out`, `cmnd` 는 `aws-iot-cmnd-bridge` 만 `out` 으로
> 갈라 뒀다. 토픽을 더할 때 이 불변식부터 확인한다 — AWS IoT 는 건당 과금이라 루프가 조용히
> 비싸다.

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
RPI_PW='<RPi브로커비번>'
sed -e "s|/opt/homebrew|$PREFIX|g" -e "s|__RPI_BRIDGE_PASSWORD__|$RPI_PW|" \
  mosquitto/mosquitto.conf > "$PREFIX/etc/mosquitto/mosquitto.conf"
mkdir -p "$PREFIX/var/lib/mosquitto" "$PREFIX/var/log/mosquitto" "$PREFIX/etc/mosquitto/certs"
brew services start mosquitto
```

**RPi 비밀번호와 AWS 인증서는 레포에 없다.** 설정 파일에는 자리표시자만 있고, 실제 값은 이
맥에만 존재한다 — mosquitto 에는 `remote_password_file` 이 없어서 값을 파일 밖으로 뺄 방법이
없기 때문이다. `RPI_PW` 를 안 바꾸면 **브릿지만 조용히 인증 실패한다**(브로커는 정상 기동하고
조명만 안 먹는다). 값은 RPi 의 `/etc/mosquitto/passwd` 를 만든 사람이 갖고 있다 — 모르면
`mosquitto_passwd` 로 RPi 에서 `nmwc` 계정을 다시 설정하고 양쪽을 같이 바꾼다.

AWS 브릿지는 **두 개**고, 인증서를 공유하지 않는다. `$PREFIX/etc/mosquitto/certs/` 에 놓는다
(개인키는 커밋 금지):

| 브릿지 | 인증서 | 하는 일 |
|---|---|---|
| `aws-iot-bridge` | `certificate.pem.crt` · `private.pem.key` | 상행 — `tele/*`·`stat/*` 를 AWS 로 올린다 |
| `aws-iot-cmnd-bridge` | `cmnd-bridge-certificate.pem.crt` · `cmnd-bridge-private.pem.key` | 하행 — `cmnd/*` 를 AWS 로 올려 Pi 가 받게 한다 |

`AmazonRootCA1.pem` 은 공개 루트 CA 라 둘이 같이 쓴다.

**신원을 왜 나눴나**: 필요한 IoT 정책이 서로 반대다. 상행 쪽은 `tele/*`·`stat/*` 에 발행
권한이, 하행 쪽은 `cmnd/*` 에 발행 권한이 필요하다. 한 인증서에 합치면 **상행 전용이어야 할
신원이 명령까지 쏠 수 있게 된다** — 그 인증서가 새면 조명이 남의 손에 들어간다.

`aws-iot-cmnd-bridge` 용 정책(새로 만들어야 한다 — 아직 없다, 아래 '아직 검증 안 된 것' 참조):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iot:Connect",
      "Resource": "arn:aws:iot:ap-northeast-2:<계정ID>:client/typelounge-cmnd-bridge"
    },
    {
      "Effect": "Allow",
      "Action": ["iot:Publish", "iot:RetainPublish"],
      "Resource": "arn:aws:iot:ap-northeast-2:<계정ID>:topic/cmnd/*"
    }
  ]
}
```

⚠️ **`iot:Publish` 와 `iot:RetainPublish` 는 별개 액션이다.** 하나만 주면 retain 플래그가
붙은 메시지에서만 연결이 끊기는데, MQTT 3.1.1 은 거부 사유를 못 실어 보내서 **원인이 안
보인다**(아래 '막혔을 때' 2026-08-12 항목에서 실제로 밟았다). 지금 우리가 내보내는 `cmnd` 는
retain 을 안 쓰지만, 나중에 켰을 때 같은 함정을 다시 밟지 않도록 같이 부여해 둔다.

`clientid` 는 `typelounge-cmnd-bridge` 다. 기존 두 신원(`mac-bridge-aws` = 맥 상행,
`typelounge-mosquitto-bridge` = Pi 자체 브릿지)과 **겹치면 안 된다** — AWS IoT Core 는 같은
clientId 로 두 번째가 붙으면 첫 번째를 끊어서, 두 브릿지가 서로를 무한히 밀어낸다.

**인증서가 없어도 브로커는 뜨고 조명은 그대로 돈다** (실측: mosquitto 2.1.2 는 설정 로드 때
죽지 않고 그 브릿지만 실패시킨 뒤 재시도한다). 다만 로그에 `Unable to load CA certificates`
가 계속 쌓이므로, 클라우드 릴레이를 안 쓸 현장이면 `connection aws-iot-bridge` 와
`connection aws-iot-cmnd-bridge` 블록을 **둘 다** 지운다.

브릿지가 실제로 붙었는지 확인한다. `1` 이 나와야 정상이다:

```bash
mosquitto_sub -h localhost -u typelounge -P '<브로커비번>' \
  -t '$SYS/broker/connection/rpi-bridge/state' -C 1 -W 3
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

**"언제" 열려 있는지도 서버가 정한다.** 예약 시간 밖이면 `list`·`command`가 전부
403(`outside_reservation_window`)으로 막힌다(`reservation-window.ts`) — 다음 손님이나
URL을 알게 된 아무나 지금 이용 중이 아닌 시간에 냉난방을 건드릴 수 없게 하는 게 목적이다.
페이지는 이 코드를 받으면 컨트롤을 숨기고 안내만 보이되 폴링은 계속 돈다 — 예약 시작
시각이 되면 손님이 새로고침하지 않아도 자동으로 열린다.

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
- [ ] 예약이 없는 날짜·시간에 위 `list`를 다시 호출하면 `outside_reservation_window` 403이
      온다 — 이게 안 되면 예약과 무관하게 항상 열려 있는 것이다

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

## J. 손님 안내 문자 (SOLAPI)

예약마다 자동발송을 켜면 안내 문자가 스스로 나간다. 문구 정본은
`supabase/functions/control/sms/templates.ts`이고, 사람이 읽는 시안은
[`_sms-templates.html`](./_sms-templates.html)이다 — **둘을 같이 고친다.**

| 언제 | 무엇을 | 누가 |
|---|---|---|
| 자동발송을 켠 즉시 | 보증금 예약이면 **청소 보증금 안내**, 아니면 **예약 확정 안내** | 어드민 클릭 |
| 보증금 입금 확인 시 | **예약 확정 안내** (보증금 예약만) | 어드민이 그 줄의 `보내기` |
| 입실 10분 전 (유예 30분) | **입실 안내** | pg_cron |
| 퇴실 15분 전 (유예 15분) | **퇴실 15분 전 안내** | pg_cron |
| 퇴실 시각 정각 (유예 60분) | **퇴실 시간 안내** | pg_cron |

"켠 즉시" 두 통이 cron이 아닌 이유는, 자동 스윕이 예약 전후 1일치만 훑기 때문이다
(`store.fetchRecent`). 다음 주 예약에 오늘 켜면 그 문자가 예약 당일에야 나간다.

### J-1. SOLAPI 준비 (사람이 하는 일 — 코드로 못 한다)

1. [solapi.com](https://solapi.com) 가입
2. **발신번호 등록** — 「전기통신사업법」 §84-2의 사전등록제라 우회할 수 없다.
   개인 명의 휴대폰은 **문자본인인증만으로** 되고 사업자등록증이 필요 없다(현재 `01048109142`).
   서류를 내는 경우 영업일 1~3일 걸린다.
3. **충전** — 후불이 아니라 선불 잔액이다. 떨어지면 발송이 거절된다.

문구가 전부 90바이트를 넘어 **LMS(45원/건)** 로 나간다. 예약 1건당 최대 225원.

### J-2. 시크릿

```bash
supabase secrets set SOLAPI_API_KEY='<API Key>' \
                     SOLAPI_API_SECRET='<API Secret>' \
                     SOLAPI_SENDER='01048109142'
```

알림은 I-1의 `MATTERMOST_WEBHOOK_URL`을 그대로 쓴다. 문자 알림이 기기 알림에 묻히면
`MATTERMOST_SMS_WEBHOOK_URL`만 새로 넣어 분리한다(코드는 안 고친다).

셋 중 하나라도 없으면 **자동 발송은 조용히 건너뛰고**(콘솔에만 남는다) 어드민에서 보내면
503으로 즉시 알려준다. 설정 누락은 예약의 문제가 아니라 서버의 문제라 예약별 장부에 적지 않는다.

### J-3. 배포

```bash
supabase db push               # 20260808100000 (reservation_sms + sms_auto/deposit_required)
supabase functions deploy control
```

### J-4. 확인

```bash
# 손님은 문자 action에 닿지 못한다 — 미리보기까지 전부 403이어야 한다
for a in sms_preview sms_send sms_mark_manual sms_auto; do
  curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
    -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
    -d "{\"action\":\"$a\"}"; echo
done
```

- [x] 손님 경로에서 문자 action 4종이 전부 403 (2026-08-08 확인)
- [x] 어드민에서 `보내기` → 실제 수신 + 장부에 `sent`와 SOLAPI groupId (2026-08-08)
- [x] 같은 것을 또 보내면 `already` — 중복이 안 나간다 (2026-08-08)
- [x] 자동발송을 켜면 그 클릭 안에서 첫 통이 나간다 (2026-08-08)
- [x] pg_cron이 입실 10분 전에 사람 없이 보낸다 (2026-08-08, 19:03:01 실측)
- [x] 연락처가 없으면 `no_phone` — 발송을 시도하지 않고 복사 경로로 넘어간다 (2026-08-08)
- [x] 취소된 예약은 어드민이 눌러도 400 (2026-08-08)
- [ ] **발송 실패 시 Mattermost에 ⚠️와 벤더 사유 원문이 뜬다** — 실패를 못 만들어봤다
- [ ] 유예 창을 넘겼을 때 `expired`로 남고 채널에 알림이 간다 — 실측 못 함
- [ ] 잔액 소진 시 어떤 에러 문구가 오는가 — 겪어봐야 안다

### ⚠️ 검증한다고 라이브 DB에 테스트 예약을 만들지 않는다

**같은 예약 행이 기기 자동화의 입력이기도 하다.** 문자만 볼 생각으로 곧 시작하는 예약을
만들면 냉난방·조명이 실제로 움직인다.

2026-08-08에 이걸 겪었다. 문자 cron을 보려고 11분 뒤 시작하는 예약을 만들었는데, 입실 준비는
**입실 15분 전**에 캐치업 창 10분으로 돌기 때문에 만든 즉시 창 안이었다 — 손님이 이미 이용
중이던 시간에 에어컨이 냉방 26도로, 조명이 프리셋 조합으로 **재설정됐다.** 손님이 맞춰둔
온도와 조명이 덮였다.

문자만 확인하려면 **이틀 이상 지난 날짜**로 만든다. '오늘 날짜에 지난 시각'은 안 된다 —
`store.fetchRecent`가 어제~내일을 훑으므로 여전히 잡혀서, 입실 준비·퇴실 종료가 `expired`로
기록되며 채널에 알림이 두 건 뜬다(자동발송까지 켜면 문자 미발송 알림 세 건이 더 붙는다).
±1일 밖으로 나가야 조회 자체에 안 들어온다.

시각 기반 발송의 창 경계는 `sms/schedule.test.ts`로 본다 — 거기서 전부 검증되므로
실제 예약으로 재현할 이유가 없다. 확인이 끝나면 테스트 예약은 **지운다**(장부도 같이 지워진다).

---

## K. 청소 안내 문자 (SOLAPI)

청소 담당자에게 매일 아침 당일 스케줄과 청소 가능 구간을 보내고, 그 뒤 스케줄이 바뀌면 변경
안내를 보낸다. 손님 문자(J절)와 **같은 SOLAPI 계정·발신번호를 쓰되 수신자만 다르다.**
설계 정본은 [`.specs/spec_cleaning_sms/spec.md`](../.specs/spec_cleaning_sms/spec.md),
문구 정본은 `supabase/functions/control/cleaning/templates.ts`다.

| 언제 | 무엇을 | 누가 |
|---|---|---|
| 매일 07:00 (늦어도 22:00까지) | **청소 안내** — 당일 예약 목록 + 청소 가능 구간. 예약 0건인 날도 보낸다 | pg_cron |
| 다이제스트 발송 후 ~22:00, 스케줄이 바뀔 때마다 | **예약 변경** — 추가·취소·시간변경 + 청소 구간 재계산 | pg_cron |
| 22:00 이후 변경 | 문자 없이 **Mattermost에만** | pg_cron |

**새 cron 잡을 만들지 않았다.** H절의 `reservation-automation`(1분)이 찌르는 `automate` 안에
스윕이 하나 더 얹혀 있다. 예약이 어디로 들어오든 전부 `reservations` 한 테이블로 모이므로,
틱마다 오늘 스케줄을 직전 스냅샷과 비교하는 것으로 변경이 잡힌다.

### K-1. 시크릿

```bash
supabase secrets set CLEANING_SMS_TO='<청소 담당자 휴대폰 번호>'
```

J-2의 `SOLAPI_*` 3종과 I-1의 `MATTERMOST_WEBHOOK_URL`을 그대로 쓴다. **번호는 레포 어디에도
적지 않는다** — 남의 개인 연락처라 ThinQ PAT·service_role 키와 같은 급으로 다룬다.
미설정이면 청소 안내만 조용히 건너뛰고 콘솔에만 남는다(손님 문자와 기기 제어는 정상).

### K-2. 배포

```bash
supabase db push               # 20260809000000 (cleaning_sms)
supabase functions deploy control
```

### K-3. 확인

**형운 번호를 먼저 넣고 하루 돌린 뒤 담당자 번호로 바꾼다.** 문구·시각·창 계산은 순수 함수
테스트(`deno test --allow-env cleaning/`)가 전부 잡으므로, 여기서 볼 것은 '실제로 도착하는가'뿐이다.

- [ ] 07:00에 다이제스트가 도착한다
- [ ] 같은 본문이 Mattermost에 코드 블록으로 올라온다
- [ ] 어드민에서 당일 예약 **시간을 고치면**(`admin_set_time`) 몇 분 안에 변경 안내가 온다
- [ ] 틱 응답의 `cleaning` 카운터가 움직인다 (`{"action":"automate"}` 직접 호출)
- [ ] 예약이 0건인 날에도 "오늘 예약이 없어요"가 온다
- [ ] 22시 이후 변경은 문자가 **안 오고** Mattermost에만 뜬다

### ⚠️ 확인한다고 라이브 DB에 테스트 예약을 만들지 않는다

J절의 경고가 그대로 적용된다 — **같은 예약 행이 기기 자동화의 입력이다.** 변경 안내를
보고 싶으면 **기존 예약의 시간을 고친다**(어드민의 이용 시간 수정). 새로 만들면 입실 준비
창에 걸려 손님이 이용 중인 공간의 냉난방·조명이 재설정된다.

### 재발송 (사람이 직접)

```sql
update cleaning_sms set status = 'superseded'
 where date = '2026-08-09' and kind = 'digest' and status <> 'superseded';
```

다음 틱이 새로 보낸다. **22:00 전에만 통한다.** 그 뒤에는 발송 판정이 `expired`라 문자가
안 나가므로, Mattermost에 남은 본문을 복사해 직접 보낸다.

**발송 실패는 자동으로 재시도하지 않는다.** 같은 본문이 Mattermost에 이미 올라가 정보가
유실되지 않는 반면, 재시도를 열면 잔액 소진처럼 다음 틱에도 똑같이 실패하는 사유에서
1분마다 알림이 쌓여 채널을 못 쓰게 된다.

---

## L. 청소 완료 QR

청소 담당자가 일을 마치고 **벽에 붙은 QR을 찍으면**, 찍은 시각 이전에 끝난 예약이 전부
청소 완료로 표시되고 Mattermost에 알림이 간다. 어드민에서 한 건씩 누르던 것과 같은
컬럼(`reservations.cleaning_done`)을 쓴다 — 완료 상태가 두 군데로 갈라지면 어느 쪽이 맞는지
아무도 모른다.

| 무엇 | 어디 |
|---|---|
| 담당자가 여는 페이지 | `https://typelounge.vercel.app/cleaning#t=<토큰>` (`cleaning-done.html`) |
| 자격증명 | `CLEANING_TOKEN` 시크릿 — **admin 비밀번호가 아니다** |
| 할 수 있는 일 | 건수 조회 + 완료 표시, 이 둘뿐 |

**QR을 찍는 것만으로는 아무것도 바뀌지 않는다.** 페이지가 먼저 "N건을 완료로 표시할까요?"를
보여주고, 사람이 버튼을 눌러야 기록된다. 스캐너 앱과 메신저가 링크를 미리 열어보는 일이
있어서고, 첫 스캔은 밀린 예약이 통째로 잡힐 수 있어 **누르기 전에** 숫자를 보여줘야 하기 때문이다.

### L-1. 토큰 만들고 넣기

```bash
# 32자 URL-safe 토큰. 이 값은 레포 어디에도 적지 않는다.
python3 -c "import secrets; print(secrets.token_urlsafe(24))"

supabase secrets set CLEANING_TOKEN='<위에서 나온 값>'
```

**admin 비밀번호를 쓰지 않는다.** 그 값은 예약자 이름·연락처를 여는 `admin_*` RPC의 열쇠이기도
한데, QR은 인쇄물이라 사진으로 찍히고 스캐너 앱 기록에 남는다.

시크릿을 안 넣으면 **어떤 토큰도 통과하지 못한다**(빈 값끼리 맞아떨어져 열리지 않는다).
손님 페이지와 기기 제어는 그대로 돈다.

### L-2. QR 만들기

```bash
npx -y qrcode -t png -w 1200 -e H -d 16130Fff -l ffffffff -o cleaning-qr.png \
  "https://typelounge.vercel.app/cleaning#t=<토큰>"
```

- **토큰은 `#` 뒤(프래그먼트)에 둔다.** `?t=`로 두면 Vercel 접속 로그와 리퍼러 헤더에 남는다.
- 오류 정정은 `H`. 현장 인쇄물은 긁히고 더러워진다.
- **생성한 PNG는 레포에 커밋하지 않는다.** QR 이미지는 토큰을 그림으로 인코딩한 것이라,
  커밋하면 시크릿을 커밋하는 것과 같다.

### L-3. 배포

```bash
supabase functions deploy control
vercel --prod --yes
```

**`git push`만으로는 페이지가 안 올라간다** — 위 안내 참조. 함수와 페이지 둘 다 돌린다.

### L-4. 확인

```bash
# 토큰 없이 부르면 403 (손님 취급)
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"action":"cleaning_pending"}'

# 틀린 토큰이면 401
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"action":"cleaning_pending","token":"틀린값"}'
```

- [ ] **담당자가 실제로 쓰는 앱으로 찍는다.** 토큰이 `#` 뒤에 있어서, 프래그먼트를 떼고 여는
      스캐너가 있으면 "주소가 올바르지 않아요"만 뜨고 아무것도 안 된다. iOS 카메라·Safari는
      프래그먼트를 살리지만 **카카오톡·네이버 인앱 브라우저는 확인된 바 없다** — 아무 스캐너나
      한 번 되는 걸로 넘기면 현장에서만 실패한다
- [ ] QR을 찍으면 건수·날짜 범위와 **예약 목록(날짜·시각·이름)** 이 뜬다 — 이 단계에서는
      아직 **아무것도 안 바뀐다**. 아침에 받은 다이제스트 문자와 나란히 놓고 대조할 수 있다
- [ ] 버튼을 누르면 "N건 청소 완료"가 뜨고, 어드민의 청소 체크가 실제로 켜져 있다
- [ ] Mattermost에 `🧹 청소 완료 QR · N건`이 올라온다
- [ ] 연달아 한 번 더 찍으면 "표시할 예약이 없어요"가 뜨고, **0건 알림도 채널에 올라온다**
      (안 올라오면 "QR이 고장났다"와 "할 게 없었다"가 채널에서 구분되지 않는다)
- [ ] 이용 중인 예약은 포함되지 않는다 — 진행 중 예약이 있는 시간에 찍어 확인
- [ ] 토큰 없이 `/cleaning`을 열면 "주소가 올바르지 않아요"가 뜬다

### 토큰이 샜을 때 (또는 담당자가 바뀔 때)

```bash
supabase secrets set CLEANING_TOKEN='<새 값>'   # 옛 QR은 그 즉시 401이 된다
```

QR을 새로 뽑아 현장 인쇄물을 교체한다. **옛 QR을 찍으면 401**이라 담당자가 "아무 일도 안
일어남"이 아니라 오류를 보게 되고, 그래야 교체가 안 된 걸 안다.

---

## M. 어드민 비밀번호 해시 전환 (2026-08-13)

어드민 비밀번호는 예약자 이름·연락처(`admin_*` RPC) · 주민번호 복호화(`claim`의 `reveal`) ·
CCTV 자격증명 · 기기 전원을 **전부** 여는 단일 열쇠다. 그런데 세 가지가 겹쳐 있었다:
평문으로 비교됐고(SQL 함수 본문), 시도 횟수 제한이 없었고, 값이 숫자 PIN이라 키스페이스가 좁았다.
세 개를 같이 고쳐야 의미가 있다 — 하나만 고치면 나머지로 그대로 들어온다.

> ⚠️ **순서를 지켜야 잠기지 않는다.** 가운데 단계(비밀번호 심기)를 건너뛰고 3번을 밀면
> 어드민이 통째로 잠긴다. 무인 공간에서 그건 현장 대응 불가를 뜻한다.
> 그래서 마이그레이션을 일부러 두 파일로 쪼개 두었다.

**1) 도구만 올린다** — 이 단계는 아무 동작도 바꾸지 않는다.

```bash
> ✅ **순서를 틀려도 잠기지 않는다 — 전환 파일 두 개에 게이트가 있다.** 비밀번호가 안 심긴
> 상태에서 밀면 예외를 던져 **마이그레이션 전체가 롤백**된다(잠긴 채 남는 것보다 아예 안
> 바뀌는 쪽이 낫다). 오류 문구가 다음에 뭘 해야 하는지 알려준다. 그러니 아래 임시 이동은
> **선택**이다 — 그냥 밀고 오류를 보고 2단계로 넘어가도 된다.
>
> ⚠️ **`supabase db push`에는 "여기까지만" 옵션이 없다.** 미적용분을 **전부** 민다
> (`--include-all`·`--dry-run`·`--db-url`뿐, `--to` 같은 건 없다). 그냥 밀면 전환
> 마이그레이션(`20260813111000`)까지 같이 올라가고, 그 시점 `admin_secret`은 비어 있어
> **열 개 `admin_*` 함수가 전부 실패한다.** 두 파일로 쪼갠 의미가 사라진다.
>
> 그래서 전환 파일을 **잠깐 디렉토리 밖으로 빼고** 민다(2026-08-13 실제로 이렇게 했다):
>
> ```bash
> mkdir -p /tmp/tl-hold
> mv supabase/migrations/20260813111000_admin_use_secret.sql /tmp/tl-hold/
> supabase db push --dry-run     # 목록에 111000 이 없는지 눈으로 확인
> supabase db push
> mv /tmp/tl-hold/20260813111000_admin_use_secret.sql supabase/migrations/
> ```
>
> `supabase migration list`로 `111000`만 원격 칸이 비어 있으면 성공이다.

```bash
supabase db push          # 20260813100000(시도 제한) · 110000(admin_secret + admin_check) 등
```

**2) 새 비밀번호를 심는다** — SQL 편집기에서 한 번만. **값은 레포에 적지 않는다.**

```sql
select public.admin_set_password('<새 비밀번호>');
```

16자 미만은 거부한다. 해싱(bcrypt cost 12)과 pgcrypto 스키마 위치를 함수가 알아서 처리하므로
`extensions.crypt(...)`를 손으로 적을 필요가 없다 — 그 스키마는 프로젝트마다 달라서
손으로 적으면 틀린 쪽에서 실패한다.

**반드시 새 값으로 바꾼다.** 기존 값은 마이그레이션 `20260803000000`에 평문으로 커밋돼 git
이력에 영구히 남아 있다 — 회전하지 않으면 이 작업의 절반이 무의미하다.
숫자 PIN을 쓰지 않는다(시도 제한이 있어도 좁은 키스페이스는 여전히 얇은 방어다).

**3) 같은 값을 나머지 두 자리에도 넣는다.** 비밀번호를 **보관**하는 자리는 셋이고, 회전할 때마다
셋이 같이 움직여야 한다. 하나만 뒤처지면 그 경로만 조용히 죽는다 — 나머지가 멀쩡해서 더 안 보인다.

| 자리 | 넣는 법 | 뒤처지면 |
|---|---|---|
| DB `admin_secret` (해시) | 위 2)단계 | 어드민·자동화 전부 잠긴다 (즉시 보인다) |
| Edge Function 시크릿 | 아래 명령 | 어드민 목록은 열리는데 **기기 제어만** 안 된다 |
| **Apps Script 스크립트 속성** | 아래 절차 | **예약 자동 등록만** 죽는다 — 어드민·기기·문자가 다 멀쩡해 며칠씩 안 보인다 |

```bash
supabase secrets set ADMIN_PASSWORD='<같은 값>'
```

Apps Script는 명령이 없다. https://script.google.com → `SpaceCloud Gmail Sync` 프로젝트 →
좌측 톱니바퀴(프로젝트 설정) → **스크립트 속성** → `ADMIN_PASSWORD`를 같은 값으로 고친다.

> **2026-08-14에 이 세 번째 자리를 빠뜨려 실제로 사고가 났다.** 회전 직후 어드민도 기기 제어도
> 정상이라 아무도 몰랐고, 그날 저녁 예약 2건(취소 1·신규 1)이 `invalid password`로 반려된 뒤에야
> Mattermost 알림으로 드러났다. 고친 뒤에는 **`reprocessMessages()`를 반드시 실행한다** — 3회
> 재시도를 소진한 메일은 포기 상태로 찍혀 있어, 비밀번호만 맞춰도 지난 건은 안 들어온다.
> 자세한 복구 절차는 `automation/README.md`.

`admin.html`과 `spacecloud-api-sync.js`는 이 목록에 없다. 둘 다 사람이 그때 입력하는 경로라
비밀번호를 들고 있지 않다 — 회전해도 다음 로그인부터 새 값을 넣으면 그만이다.

**4) 전환과 배포.**

```bash
supabase db push        # 20260813111000(전환) + 20260813111100(라이브 전용 5개 회수)
supabase functions deploy control apply claim   # 세 함수가 시도 제한을 공유한다
```

> ⚠️ **두 파일이 같이 올라가야 한다.** `111100`은 버전 관리 밖에 있던 함수 다섯
> (`admin_add_reservation`·`admin_delete_reservation`·`admin_set_checkin`·
> `admin_set_checkout`·`admin_set_cleaning`)을 회수해 같이 해시 검증으로 옮긴다.
> 이걸 빼고 회전하면 **두 방향으로 깨진다** — 어드민이 새 비밀번호를 보내면 그 다섯이
> 거부해 예약 추가·삭제·입퇴실·청소 표시가 안 되고, 옛 PIN 은 그 다섯을 계속 연다.
> (2026-08-13 라이브 스키마 덤프로 발견. `admin_*` 함수가 17개인데 다섯이 레포에 없었다.)

**5) 확인.** 어드민에서 새 비밀번호로 들어가지고, 예약 목록·기기·CCTV가 보이는지 본다.
**예약 추가·삭제, 입실·퇴실 표시, 청소 표시도 눌러본다** — 회수한 다섯 함수가 그 경로다.
틀린 비밀번호를 열 번 넣으면 열한 번째에 429가 떠야 한다(10분 창).

> **DB 편집기에서 함수를 직접 만들지 않는다.** 만들면 리뷰도 버전 관리도 못 받고, 나중에
> 인증 방식을 바꿀 때 통째로 빠진다. 2026-08-13 에 실제로 다섯 개가 그렇게 남아 있었고
> `admin_list_reservations` 도 같은 경로로 라이브에만 있었다. 확인법:
> `select proname from pg_proc where proname like 'admin\_%' and pronamespace='public'::regnamespace;`
> 또는 `supabase db dump --schema public`.

### 지금 어디까지 됐나 (2026-08-14 — 회전 완료)

**1~5단계 전부 적용 완료.** 2026-08-14 에 비밀번호를 회전하고 전환·회수 마이그레이션을 밀었다.

그래서 지금 상태는:
- 어드민은 **새 비밀번호**로만 들어간다. `admin_check`(bcrypt 해시 검증)가 실제 뿌리다 — 열 개 `admin_*` 함수가 전부 이것에 위임한다.
- **옛 평문 PIN 은 무효화됐다** — SQL 경로(`admin_check`)도 Edge 경로(control)도 옛 값을 401/`invalid password`로 거부한다(2026-08-14 실측). git 이력의 `20260803000000` 평문 PIN 은 이제 쓸모가 없다.
- 라이브 전용이던 `admin_*` 함수 다섯(`admin_add_reservation` 등)이 회수되어 **17개 전부 버전 관리 하**에 들어왔다.
- 게이트 로그인의 PostgREST RPC 경로도 이제 시도 제한 안이다 — `20260814150000`이 `admin_check` 안에 `fn='rpc'` 장부를 얹었고, 그것이 이번 회전으로 비로소 실효하게 됐다.
- 시도 제한·CSP·SRI·워치독 같은 방어는 이전부터 살아 있다.

> ⚠️ **새 비밀번호는 이 문서·레포 어디에도 적지 않는다.** Supabase 시크릿 `ADMIN_PASSWORD` 와 DB `admin_secret`(bcrypt 해시)에만 있다. 둘을 바꿀 땐 반드시 같은 값으로 함께 바꾼다(2~3단계).

### 알아둘 것

- **시도 제한의 키는 `cf-connecting-ip`다. `x-forwarded-for`가 아니다.**
  이 플랫폼은 클라이언트가 보낸 XFF를 **그대로 통과시킨다** — 값을 매 요청 바꾸면 바구니가
  매번 새로 생겨 제한이 통째로 뚫린다(2026-08-13 라이브 실측: 위조 헤더로 13회를 던져도
  안 막혔다). 첫 항목이든 마지막 항목이든 목록 전체가 호출자 손에 있어 소용없다.
  `cf-connecting-ip`는 앞단 Cloudflare가 붙이고, 클라이언트가 그 헤더를 보내면 **요청 자체가
  403(`error code: 1000`)으로 거부**돼 위조값이 함수까지 오지 못한다.
  ⚠️ 앞으로 이 앞단이 Cloudflare가 아니게 되면 이 전제가 깨진다 — 그때 키를 다시 정해야 한다.
- **시도 제한은 실패한 인증만 센다.** 비밀번호를 아예 안 보낸 요청(손님 페이지,
  pg_cron의 `automate`)은 카운터를 타지 않는다 — 세면 1분마다 오는 자동화가 스스로 문을
  잠근다. #44·#70에서 자동화 침묵이 두 번 일어난 뒤라 이 구분이 중요하다.
- **DB를 못 읽으면 막지 않는다(fail-open).** 판정 테이블 조회가 실패한 상태에서 잠그면
  DB 장애가 곧 '어드민 잠김 + 자동화 정지'가 된다. 대신 로그에 남는다.
- `20260813111000`이 `cannot change return type`으로 실패하면 라이브
  `admin_list_reservations`의 시그니처가 레포에 회수한 것과 다르다는 뜻이다. 그 경우
  **마이그레이션이 통째로 롤백되므로 아무것도 깨지지 않는다** — 파일 안 주석의 조회로 실제
  정의를 확인하고 맞춘 뒤 다시 민다.

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
| 문자가 안 나가는데 화면은 조용하다 | 자동발송이 켜져 있나, 연락처가 있나. 둘 다 맞는데 조용하면 SOLAPI 시크릿 3종을 확인한다 — 미설정이면 자동 경로는 콘솔에만 남는다 |
| 문자 상태가 `보내는 중…`에서 안 바뀐다 | 발송 도중 함수가 죽은 것. **문자는 이미 나갔을 수 있다** — 손님에게 확인하고 필요하면 `다시`로 재발송한다 |
| `연락처 없어 못 보냄` | 자동발송은 켜졌는데 번호가 없다. 번호를 넣고 그 줄의 `다시`를 누른다(번호만 넣으면 지난 건은 자동으로 안 나간다) |
| 발송이 `1030`류 코드로 실패 | SOLAPI 잔액이나 발신번호 등록 상태. 에러 원문이 채널과 장부에 그대로 실린다 |
| 청소 안내가 안 온다 | `CLEANING_SMS_TO`가 들어갔나. 없으면 콘솔에만 남고 손님 문자·기기 제어는 정상이라 티가 안 난다 |
| 청소 안내가 하루 종일 없었다 | 07:00~22:00 사이 틱이 한 번이라도 돌았나. 22시를 넘기면 `cleaning_sms`에 `expired`로 남는다 |
| 변경 안내만 안 온다 | 그날 다이제스트가 `sent`인지 본다 — 기준선이 없으면 '변경'을 잴 수가 없어 일부러 아무것도 안 한다 |
| 같은 변경 안내가 반복된다 | `cleaning_sms`의 최신 `sent`/`expired` 행에 `snapshot`이 비어 있는지 확인. 비면 기준선이 전진하지 않는다 |
| 문자 이력이 전부 `대기`로 보인다 | `admin_list_sms`가 실패한 것. 예약 카드 아래에 그 사실이 빨갛게 뜬다 — 상태를 믿지 말고 새로고침한다 |
| `[cmd] 만료 — 실행하지 않음` | **정상이다.** 60초 넘은 명령은 일부러 버린다 (아래) |
| 어제까지 되던 조명이 먹통 | B-2 DHCP 예약이 풀렸는지 |
| 자격증명은 맞는데 **특정 기기만 오래 오프라인** | 공유기가 **2.4GHz 기기 → 브로커 맥(예: `.100`) 방향의 신규 TCP 연결을 조용히 블랙홀**하는 경우다(2026-08-09 판별). `MqttHost`·`MqttUser`가 정상인데 기기만 안 붙으면 설정을 더 의심하지 말고, **공유기를 재부팅**하거나 **기기 전원을 뽑았다 꽂아** 신규 TCP를 다시 뚫는다 |
| 조명이 **전부** 한꺼번에 먹통 (기기·Wi-Fi는 멀쩡) | mosquitto 런타임이 죽었을 수 있다. `brew services restart mosquitto` 후 `agent.log`에 `[mqtt] 연결됨`과 재구독이 다시 뜨는지 본다 |
| 어드민은 **"연결됨"인데 조작이 안 된다** | `online`을 믿지 말고 브로커에 실제로 몇 대가 붙어 있는지 센다: `mosquitto_sub -u … -t '$SYS/broker/clients/connected' -C 1`. 에이전트+브리지 말고 기기가 안 세어지면 기기가 죽은 것이다. `tele/+/LWT`를 **`-R`(retained 제외)**로 구독해 아무것도 안 오면 `Online` 표시는 전부 과거값이다 (2026-08-11) |
| 조명 여러 대가 **같은 초에 한꺼번에** 갱신됐다 | 기기가 보고한 게 아니라 에이전트가 재접속하며 retained를 몰아 읽은 것이다. `updated_at`이 밀리초까지 붙어 있으면 이 경우 — 살아난 게 아니다 (2026-08-11) |
| 자동화가 **통째로 조용하다** (문자·준비·퇴실 전부) | `cron.job_run_details`는 `succeeded`로 나오니 보지 말고 **`net._http_response`**를 본다. `net.http_post`는 비동기라 HTTP 실패가 cron 쪽에 안 남는다. 이 테이블은 몇 시간 만에 만료되므로 **가장 먼저** 조회한다 (2026-08-11, #70) |
| 예약이 이용 중일 땐 자동화가 되는데 **입실 직전·퇴실 직후(다른 예약이 없는 순간)만 조용히 실패**한다 | Supabase 대시보드 **Logs → Edge Functions**에서 `control`의 `automate` 호출이 `403`으로 찍히는지 본다(`net._http_response`보다 안 만료돼 더 오래 볼 수 있다). 응답 본문이 `outside_reservation_window`면 `index.ts`의 `role === "guest" && action !== "automate" && ...` 예외가 배포본에서 빠진 것이다(#44/#70과 같은 증상). **머지 안 된 main을 기준으로 배포하면 이렇게 재발한다** — 배포 전에 `gh pr list`로 관련 PR이 머지됐는지 반드시 확인한다(2026-08-12, #70 재발 사고) |
| `automate` 응답은 오는데 기기가 안 움직인다 | 대상 예약의 `date`+`start_time`/`end_time`이 실제로 그 창 안인지, `cancelled`가 false인지 확인 |
| 퇴실 후 스윕이 도는데 손님이 아직 있다 | 예약의 `end_time`이 실제 퇴실보다 이른지 확인. 연장했으면 어드민에서 `end_time`을 먼저 고친다 |
| **예약 자동 등록만** `invalid password`로 실패한다 (어드민·기기 제어·문자는 전부 정상) | 어드민 비밀번호를 회전하고 **Apps Script 스크립트 속성을 안 고친 것**이다(M절 3단계). 세 자리 중 어디가 뒤처졌는지는 각각 찔러 확인한다 — RPC(`admin_list_reservations`)가 200이면 DB는 맞고, `control` 함수가 401이 아니면 시크릿도 맞다. 고친 뒤 **`reprocessMessages()`를 꼭 실행한다**(안 하면 반려된 건은 안 들어온다) (2026-08-14) |
| 연장한 예약의 **취소 메일만** `취소 대상 예약을 찾지 못했습니다`로 실패한다 | 취소 메일에는 예약번호가 없어 **(날짜+시작+종료)로** 대상을 찾는데, 연장으로 DB의 `end_time`이 스클 원본과 갈라져 후보가 0건이 된다. 즉 `admin_set_time`으로 연장한 예약은 **전부** 이 상태다. 연장은 **스클에서도 같이** 해두는 게 정석이고, 이 알림이 오면 어드민에서 직접 취소 표시한다 |
| 앞 손님이 퇴실하는 순간 **다음 손님용 준비가 통째로 꺼진다** | 다음 예약의 준비(입실 15분 전)가 앞 예약의 퇴실보다 **먼저** 돌아서, 뒤이은 퇴실 종료가 그걸 전원째 되돌린 것이다. 채널에 `자동 · 입실 준비`가 `자동 · 퇴실 종료`보다 **앞서** 찍혔는지로 확인한다. 지금은 `handsOverToNext`가 이 경우 퇴실 종료를 건너뛴다 — 건너뛰면 `공간 전체`에 "다음 예약의 입실 준비가 이미 시작돼…" 한 줄이 ❌ 없이 남는다 (2026-08-14) |
| 연달아 있는 예약인데 **입실 15분 전에 준비가 안 돈다** | 정상이다. 앞 손님이 아직 방에 있으면 준비를 **앞 예약 퇴실 시각까지 미룬다**(`prepDueState`) — 안 그러면 앞 손님의 마지막 15분에 에어컨이 26도로 바뀌고 SiHAS 조명이 꺼진다. 채널의 `자동 · 입실 준비`가 앞 예약 퇴실 시각에 찍혔으면 제대로 돈 것이다 (2026-08-14) |
| 붙어 있던 다음 예약을 **취소했더니 방이 계속 켜져 있다** | 정상 동작의 대가다. 인계로 퇴실 종료를 건너뛴 뒤 그 예약이 사라지면 스윕 창(10분)은 이미 닫혀 있어 아무도 끄지 않는다. **조용하지는 않다** — 유휴 경보가 `⚠️ 예약 없이 켜져 있음`으로 뜬다. 어드민에서 직접 끈다 |
| 우리가 켠 조명이 "현장 조작"으로 온다 | 대조 창(120초)보다 조명 반영이 느렸다는 뜻. `agent.log`에서 발행 지연을 본다 |
| 알림이 아예 안 온다 | `MATTERMOST_WEBHOOK_URL` 시크릿이 들어갔는지. 없으면 제어는 되고 알림만 건너뛴다 |
| 같은 알림이 두 번 온다 | 발송은 됐는데 발송 표시가 실패한 경우다. 유실보다 중복이 낫다고 보고 이 방향으로 뒀다 |
| 온도를 낮춰도 되돌려지지 않는다 | 이용 중(입실 15분 전~퇴실)에만 동작한다. 에어컨이 켜져 있어야 하고(꺼지면 시계 해제), 5분을 채워야 한다 |
| AWS IoT Core 브릿지가 `CONNACK`까지는 성공하는데 곧바로 끊긴다(`Broken pipe`/`connection closed by client`, 재연결을 반복) | mosquitto 기본값 `try_private true`가 원인이다 — 순수 mosquitto 확장이라 비-mosquitto 브로커(AWS IoT Core 포함)는 이 CONNECT 플래그를 모르고 끊는다. `try_private false`로 바꾼다. 로컬 mosquitto끼리 붙는 rpi-bridge에서는 문제없어서 처음엔 원인이 아닌 줄 알았다 (2026-08-12) |
| AWS IoT Core 브릿지가 retained·QoS1 메시지를 보낼 때만 끊긴다(QoS0나 retain 없는 QoS1은 정상) | IoT 정책에 `iot:Publish`만 있고 `iot:RetainPublish`가 없는 것이다. AWS IoT Core는 이 둘을 **별개 액션**으로 요구한다 — retain 플래그를 쓰는 토픽에 같이 부여해야 한다. MQTT 3.1.1은 거부 사유를 실어 보낼 방법이 없어 그냥 TCP 연결이 끊긴다(원인이 안 보인다) (2026-08-12) |
| AWS IoT 메시지 수가 **아무도 안 눌렀는데** 계속 올라간다 / 같은 `stat`·`cmnd` 가 로그에 끝없이 반복된다 | 두 브릿지가 같은 접두사를 **반대 방향으로** 싣고 있는 것이다(예: `aws-iot-bridge` 의 `stat/# out` + `aws-iot-cmnd-bridge` 의 `stat/# in`). mosquitto 는 들어온 브릿지로만 안 되돌리고 **다른 브릿지로 나가는 건 안 막아서** 맥 ↔ AWS 를 영원히 왕복한다. `mosquitto.conf` 에서 **같은 접두사가 한 블록 `out`·다른 블록 `in`** 으로 갈리지 않았는지 본다. `out` 개수를 세는 게 아니다 — `cmnd` 는 `rpi-bridge` 와 `aws-iot-cmnd-bridge` 양쪽에서 `out` 인 것이 정상이고(의도한 병렬 발행), 루프를 만드는 건 방향이 갈리는 경우다 — 건당 과금이라 조용히 비싸다 |
| 조명이 되는데 **AWS 경로만** 안 탄다(`rpi-bridge` 를 끊으면 먹통) | `aws-iot-cmnd-bridge` 인증서·정책이 아직 없을 수 있다(B-3). 그 신원에 `iot:Publish` on `topic/cmnd/*` 가 없으면 브릿지가 붙었다 끊기기를 반복한다. `clientid` 가 `mac-bridge-aws`·`typelounge-mosquitto-bridge` 와 겹쳐도 같은 증상이 난다(AWS 는 같은 clientId 의 이전 연결을 끊는다) |
| 같은 서브넷의 다른 기기는 다 ARP로 잡히는데 특정 IP만 `(incomplete)`로 안 잡힌다(기기는 켜져 있다고 확인됨) | 원인 미확정 — AP/클라이언트 격리, 메시 노드 분리 등이 후보지만 이 레포에서는 확인하지 못했다. tailscale처럼 L2에 안 기대는 경로로 우회하는 게 가장 빠른 해결책이었다 (2026-08-11) |

## 알아둘 것

- **오래된 명령은 실행하지 않는다.** 맥이 꺼져 있던 동안 쌓인 명령을 재생하면 **새벽 3시에
  조명이 켜진다.** 60초가 지나면 `expired`로 버린다. 늦은 실행보다 미실행이 안전하다.
- **조명의 `sent`는 '기기가 실행했다'가 아니다.** 브로커에 발행했다는 뜻이다. 실제 반영은
  기기가 `stat`으로 보고하고 에이전트가 `device_state`에 쓴다. 냉난방(HTTP 동기)은 반대로
  한 호출에서 `acked`로 확정된다.
- **`모름`은 `꺼짐`이 아니다.** 연결이 끊겨도 마지막 전원값은 유지된다 — `LWT=Offline`은
  `online`만 바꾸고 `power`는 건드리지 않는다. 합치면 꺼진 줄 알았는데 켜져 있는 상황,
  즉 **냉난방이 밤새 도는 상황**이 조용히 숨는다.
- **`online: true`는 아직 `모름`과 안 갈라져 있다.** 에이전트는 retained `LWT=Online`을
  '지금 접속 중'으로 읽는다(`src/state.js`). 그런데 브로커가 재시작되면 죽은 기기의
  `Offline`을 발행해 줄 주체가 사라져, 그 `Online`이 retained로 영원히 남는다. 그래서
  **브로커를 재시작하면 죽은 기기가 오히려 "연결됨"으로 되살아나 보인다** — 2026-08-11에
  실제로 이것 때문에 조명 4대가 멀쩡한 줄 알고 시간을 썼다. 살아 있는 기기는 초기 질의에
  실시간으로 답해 스스로 증명하므로(SiHAS가 그랬다), 판정은 retained가 아니라 그 응답이어야
  맞다. 아직 안 고쳤다.
- **브로커 재시작은 죽은 기기를 살리지 못한다.** 기기가 LAN에서 사라진 것이면 재시작은
  표시만 더 나쁘게 만든다(위). 먼저 `arp -a`나 ping sweep으로 기기가 네트워크에 있는지부터
  확인한다 — 없으면 전원·WiFi 문제라 소프트웨어로 할 일이 없다.
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
- **손님 페이지의 시간 게이트도 서버(`reservation-window.ts`)에 있다.** 예약 조회가 실패하면
  "열림"이 아니라 "닫힘"으로 떨어진다 — DB가 잠깐 불안정한 순간 예약 없는 사람에게까지
  제어가 열리는 것보다 손님이 한 번 더 새로고침하는 쪽이 낫다.

## 아직 검증 안 된 것

**기기 자동화 한 사이클 — 2026-08-13 04:01~04:22 실기기로 통과했다.**

`admin_add_reservation`으로 04:14–04:22 테스트 예약을 만들고 pg_cron이 스스로 도는 것만
지켜봤다(중간에 `automate`를 손으로 부르지 않았다). 확인된 것:

| 구간 | 결과 |
|---|---|
| 입실 준비 (입실 15분 전) | 기기 명령 8건 전부 `ok` — 조명 4대 켜기 + SiHAS 1대 끄기(나이트모드 조합), 에어컨 전원→`COOL`→26도 |
| ThinQ 실기기 왕복 | 성공. `list` 응답에 `power=ON mode=COOL target=26`이 실제로 반영됐다 |
| 퇴실 종료 (퇴실 시각) | 6대 전부 `power=OFF`로 확인. 04:07 기준선(에어컨+조명 4대 ON)과 04:22 판독을 대조해 확정 |
| 손님 문자 4종 | `confirm`(자동발송 켤 때) · `checkin`(입실 10분 전) · `checkout_soon`(퇴실 15분 전) · `checkout`(퇴실 시각) 전부 `sent`. 뒤의 셋은 **pg_cron이 시각을 보고 스스로 보냈다** |

그래서 "냉난방은 PAT가 없어 왕복을 못 돌렸다 · 조명은 가짜 Tasmota로 프로토콜만 봤다"는
2026-08-06 시점의 서술은 **더 이상 유효하지 않다.**

**여전히 확인 못 한 것**은 실패 경로다 — 문자 발송 실패 시 채널에 뜨는 ⚠️와 벤더 사유,
ThinQ 401, 유예 창을 넘긴 `expired`. 전부 일부러 실패를 만들어야 보이는 것들이라 이번
통과 사이클에서는 한 번도 안 밟혔다. **퇴실 후 스윕도 실측 아님** — 퇴실 종료가 6대를 다
껐고 스윕은 켜져 있는 기기에만 명령을 보내므로, 이번엔 할 일이 없어 아무 일도 안 했다.

> ⚠️ 이 테스트는 **라이브 DB에 예약을 만드는 것이라 기본적으로 금지**다(J·K절 경고).
> 이번에 한 이유와 안전 조건: 04시라 손님이 없고 다음 예약까지 13시간 비었으며, 청소
> 담당자 문자는 `updateAllowed()`가 07:00~22:00에만 열려 구조적으로 나갈 수 없었고,
> 손님 문자는 **형운 본인 번호**로 받았다. 그리고 **07:00 청소 다이제스트에 가짜 예약이
> 섞이기 전에 삭제**했다(04:23). 이 네 가지가 다 맞지 않으면 하지 않는다.
>
> 삭제 순서도 중요하다 — **퇴실 종료가 끝난 뒤에 지운다.** 기기가 켜져 있는 동안 예약 행을
> 지우면 끌 주체가 사라져 조명·냉난방이 밤새 켜진 채 남는다(`idle` 경보가 있는 바로 그 상황).

**AWS 병렬 명령 경로(`aws-iot-cmnd-bridge`)는 한 줄도 실증되지 않았다 (2026-08-14).**
설계 결정과 설정·코드만 레포에 들어갔고, 아래 둘이 남아 있다.

**(1) 자격증명이 아직 없다.** 이 브릿지는 새 AWS IoT 사물·인증서·정책을 요구하는데
(B-3 의 정책 JSON) **아무것도 만들지 않았다** — 발급은 별도 단계로 미뤘다. 그래서 지금
설정을 그대로 설치하면 **이 브릿지만 인증 실패로 재시도를 반복한다.** 브로커는 정상 기동하고
조명도 `rpi-bridge` 로 그대로 돌지만, 로그에 실패가 쌓이고 **병렬 경로의 이점은 0 이다.**
인증서를 놓기 전까지는 "AWS 경로가 있으니 tailscale 이 끊겨도 괜찮다"고 **믿으면 안 된다.**

**(2) 빈 공간에서 실물 리허설이 필요하다.** 구현 세션 동안 공간이 사용 중이라 아무것도 못
눌러봤다. 손님이 없는 시간에 아래를 밟는다:

- **`rpi-bridge` 를 실제로 끊고**(tailscale 다운 또는 RPi 주소 오설정) 조명 명령을 눌러,
  AWS 경로만으로 기기가 실제로 움직이는지 본다. 이게 이 변경의 **유일한 존재 이유**다
- **중복 `stat` 이 정말 무해한지** 확인한다. `rpi-bridge` 가 살아 있는 동안 Pi 는 같은
  `stat` 을 자체 AWS 브릿지로도 올리므로, 경로에 따라 같은 보고가 두 번 들어올 수 있다.
  코드상으로는 안전하지만(`noteDeviceReport` 는 확인된 대기자를 맵에서 지우고 `mergeState`
  는 순수 함수라 같은 값을 두 번 넣어도 결과가 같다) **실물로는 확인 안 됐다**
- **AWS 경로의 실제 확인 지연**을 잰다. 지금 `CONFIRM_TIMEOUT_MS` 는 4초인데, 이 값은
  LAN·tailscale 왕복을 기준으로 정한 것이다. AWS 왕복이 이보다 느리면 **성공한 명령마다
  HTTP 우회가 한 번씩 더 붙는다**(멱등이라 안 깨지지만 낭비다). 재면 그때 값을 다시 정한다
- **한 접두사가 두 브릿지에 반대 방향으로 실리지 않았는지** 설치 직후 확인한다. AWS IoT
  콘솔의 메시지 수가 아무 조작 없이 계속 오르면 루프다(위 '막혔을 때'). 다만 **0 이 정상은
  아니다** — 아래 초기 질의가 정상 트래픽으로 잡힌다. 루프는 "계속 오른다"로 판별하지
  "오른다"로 판별하지 않는다
- **초기 상태 질의가 이제 AWS 로도 나간다.** 에이전트는 접속·재접속할 때마다, 그리고 5분마다
  기기가 늘었으면 기기당 `cmnd/<addr>/POWER`(빈 payload = 질의)와 `cmnd/<addr>/Status` 를
  발행한다(`queryInitialState`). 전부 `cmnd/#` 라 새 브릿지로도 나간다 — 즉 **재접속 1회당
  기기수 × 2 건**이 과금 대상 경로에 실린다. Tasmota 쪽은 빈 payload 를 '설정' 이 아니라
  '질의' 로 다루므로 중복해서 받아도 전원이 안 바뀌지만, **건수는 실물로 재본 적이 없다.**
  재접속이 잦은 환경이면 이 값부터 본다

**`stat` 확인은 여전히 `rpi-bridge` 로만 돌아온다 — 의도한 비대칭이다.** 새 브릿지에
`topic stat/# in` 을 넣으면 기존 `aws-iot-bridge` 의 `stat/# out` 과 정확히 위 루프를 만든다.
그래서 일부러 뺐고, 결과적으로 **tailscale 이 끊긴 동안에는 명령이 AWS 로 나가 기기에 닿아도
맥은 확인을 못 받는다** — 4초 뒤 HTTP 로 한 번 더 보낸다(멱등이라 무해하다). 이걸 없애려면
`aws-iot-bridge` 에서 `stat/# out` 을 빼고 상행을 Pi 의 자체 브릿지에 일임해야 하는데, **Pi
브릿지가 실제로 `stat` 을 올리도록 설정돼 있는지는 이 레포에서 확인할 수 없다**(정책이
허용한다는 것과 설정돼 있다는 것은 다르다). 확인되면 그때 정리한다.

**같은 변경에서 `aws-iot-bridge` 의 `topic cmnd/# in 1` 을 지웠다.** 새 브릿지의
`cmnd/# out` 과 루프를 만들기 때문이고, 없어도 되는 이유는 (a) AWS 의 `cmnd/*` 로 발행하는
코드가 이 레포에 없고(유일한 명령 생산자는 Supabase Realtime 을 받는 control-agent 이고 그건
로컬 발행이다) (b) Pi 자체 브릿지가 이미 `cmnd/*` 를 직접 구독하기 때문이다. **레포 밖에서
AWS 의 `cmnd/*` 로 직접 쏘는 도구가 있다면 그건 이제 맥을 안 거친다** — Pi 가 받으므로 기기엔
그대로 닿지만, 맥 로그에는 안 남는다. 그런 도구가 있는지는 확인 못 했다.

**손님 페이지(G)는 서버까지만 확인됐다.** 2026-08-06 배포 후 G-3의 세 가지는 실제 함수에
대고 통과했다 — 현관 비밀번호로 `list` 200(기기 6개, `address` 없음) · `delete` 403 ·
틀린 비번 401. 하지만 **`/control`에서 켠 것이 실기기에 반영되는지는 확인하지 못했다.**
조명의 `sent`는 브로커에 발행했다는 뜻일 뿐이라(위 '알아둘 것') 응답이 성공이어도 실제로
켜졌다는 증거가 아니다. 현장 맥과 실기기 앞에서 G-3의 마지막 체크박스를 직접 밟아야 한다.

그때까지 **현장 안내판(`_notice-control.html`) QR은 인쇄하지 않는다.** 붙인 안내판을
되돌리려면 사람이 현장에 다시 가야 한다.

**청소 완료 QR(L) — 폰으로 찍어 실제로 완료 처리까지 확인했다.**

2026-08-09, 형운이 QR을 찍어 **1건을 완료로 표시했다.** 스캔 → 페이지 열림 → 버튼 → 일괄 갱신
전 구간이 돌았고, 직후 `cleaning_pending`이 `count: 0`으로 떨어지는 것으로 갱신이 실제로
반영됐음을 확인했다. **스캐너 앱이 URL 프래그먼트를 살린다는 것도 이때 함께 확인됐다** —
이게 안 됐으면 페이지가 "주소가 올바르지 않아요"에서 멈췄다.

같은 날 배포 후 실제 함수에 대고 확인한 것:

| 요청 | 결과 |
|---|---|
| 토큰 없이 `cleaning_pending` | `403` — 손님으로 판정돼 거부 |
| 틀린 토큰 | `401` |
| 맞는 토큰 | `200` · `{"count":1,"from":"2026-08-09","to":"2026-08-09"}` |
| `https://typelounge.vercel.app/cleaning` | `200` |

밀린 예약이 1건뿐이라 **첫 스캔이 대량으로 잡히는 상황은 이번엔 없었다.** 다음에 오래 쉬었다
돌아오면 다시 커질 수 있으므로, 숫자가 예상보다 크면 **누르지 말고** 어드민에서 먼저 본다 —
되돌리려면 한 건씩 꺼야 한다.

아직 확인 못 한 것 넷:

- **예약 목록 화면.** 날짜·시각·이름을 보여주는 것은 위 스캔 **이후**에 들어간 변경이라, 그날
  찍은 화면에는 건수만 있었다. 목록은 **다음 예약이 끝난 뒤에야** 눈으로 확인된다 — 대상이
  0건이면 "표시할 예약이 없어요"만 뜬다
- **로고.** 같은 변경에 들어갔다. 마크업 해시가 `guest-control.html`과 일치하는 것까지만
  확인했고 렌더는 못 봤다(브라우저가 로컬 서버에 못 붙었다)
- **어드민 화면의 청소 체크에 보이는가.** 같은 컬럼이라 보여야 하지만 눈으로 대조하진 않았다
- **알림이 Mattermost에 도착하는가** — **0건 알림 포함.** 안 올라오면 "QR 고장"과
  "할 게 없었음"이 채널에서 구분되지 않는다

**담당자가 쓰는 앱이 다르면 프래그먼트 확인을 다시 한다.** 위에서 확인된 것은 형운이 쓴 앱
하나이고, 인앱 브라우저(카카오톡·네이버)는 동작이 다를 수 있다. 안 살아나면 페이지가
"주소가 올바르지 않아요"에서 멈춰 **현장에서만** 실패한다 — 그때는 토큰 전달 방식을 다시
정해야 한다(경로 세그먼트 등).

**연결 끊김·시스템 오류 알림(2026-08-12 추가)도 실기기로는 확인하지 못했다.** 로직은
`deno test`(플래핑·backoff·복구 전환)와 `deno check`만 통과했다 — 조명 브로커를 실제로
끊어 LWT Offline이 device_offline 알림으로 이어지는지, CCTV 스트림을 실제로 죽여
camera_offline이 뜨는지, ThinQ PAT를 만료시켜 원인 문구("PAT 만료/무효")가 그대로
채널에 찍히는지는 전부 다음 현장 방문에서 확인해야 한다. 확인 순서:

1. 조명 하나의 전원을 뽑아 Tasmota가 LWT Offline을 보내는지 → 다음 `automate` 틱(최대
   1분) 안에 "⚠️ 기기 연결 끊김" 알림이 오는지, 다시 꽂으면 "기기 연결 복구"가 오는지
2. 현장 맥에서 `control-agent`를 잠깐 죽여 CCTV 보고가 끊기게 한 뒤(`is_stale`, 180초
   이상) camera_offline이 뜨는지
3. 1시간 이상 끊긴 채로 둬서 backoff 재알림이 실제로 60분 간격으로 오는지(스팸처럼 매분
   오면 backoff 로직이 죽은 것). 마이그레이션(`20260812130000_device_events_connectivity.sql`)이
   함수 배포보다 먼저 적용됐는지도 이때 같이 확인한다 — 안 됐으면 알림이 전혀 안 가면서
   `automate`는 평소처럼 200을 반환해 겉으로 멀쩡해 보인다

이 셋을 밟기 전엔 **이 알림에 의존해 "지금 CCTV 살아있다"고 판단하지 않는다** — 어드민
화면(실측된 상태 캐시)이 여전히 1차 확인 수단이다.

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

**조작 알림(I) — 발송 경로는 실증됐다.** 2026-08-07 실기기로 확인:

- 원격 명령 → 장부 → 묶기 → 웹훅 → 채널 전 구간 도달(`notified` 증가로 확인)
- **선점이 중복 발송을 막는다** — 같은 틱을 두 번 불러도 두 번째는 `notified:0`
- **우리 명령은 현장 조작으로 오탐되지 않는다** — 조명·에어컨을 API로 조작한 직후 `onsite:0`

### 현장 조작 판별 — 2026-08-08 관측 기록 (확정 아님)

**이 절은 판정이 아니라 증거를 적는 곳이다.** 장부의 `onsite`는 관측이 아니라
**설명할 명령이 없어서 남은 잔여 범주**다. 그걸 근거로 "현장 조작이 맞다"고 적으면
시스템의 출력으로 시스템을 검증하는 것이 된다 — 그래서 장부 분류와 **독립 근거**를
갈라 적는다.

| 사건 | 장부 분류 | 독립 근거 | 판정 |
|---|---|---|---|
| `08:45:01` SiHAS 천장 조명 "켜짐 → 꺼짐" | onsite | 그 시간대에 현장 직원이 있었음 | 정황상 유력 |
| `08:47:01` 에어컨 "꺼짐 → 켜짐" | onsite | 같은 사유 | 정황상 유력 |
| `11:34:00` 바닥 조명 2대 "꺼짐 → 켜짐" | onsite | 전원·기기 문제로 끊겨 있었음 | **오탐 확정** |

앞의 두 건은 그 조작 자체를 기억으로 확인한 것이 아니라 **"그 시간에 사람이 있었으니
현장일 것"이라는 추론**이다(2026-08-08 형운). 유력하지만 확정은 아니다 —
**현장 조작 판별이 진짜를 잡는다는 것은 아직 독립적으로 확인되지 않았다.**

> 확정하려면 **시각과 기기를 먼저 정해두고** 벽 스위치를 눌러야 한다. 그러면 장부를
> 보기 전에 정답이 있어 순환이 안 된다. 반대로 11:34 건은 장부 밖의 사실(단절)이
> 독립 근거가 돼 오탐이 확정됐다 — 그게 증거의 모양이다.

그래도 이 기록이 쓸모가 있는 것은 **지연**만은 장부만으로 확인되기 때문이다. 08:47 건은
예약이 없어 ThinQ를 600초에 한 번만 물어보므로(`IDLE_THINQ_MAX_AGE_SECONDS`) **08:47은
조작 시각이 아니라 우리가 알아챈 시각**이다 — 최대 10분 늦다. 이걸 시각 하나로 찍었더니
조작 시각처럼 읽혀 방향이 뒤집힌 것 아니냐는 의심을 받았고, 그래서 알림이 이제 관측
구간을 찍는다(`08:37~08:47 사이`).

### 그래서 남는 질문 — 대조 창을 넓힌 게 맞는가

오늘 기록을 그대로 읽으면 이렇게 된다:

| | 관측된 횟수 |
|---|---|
| 진짜 현장 조작으로 **보이는** 것 | **2건**(08:45 조명 · 08:47 에어컨) — 정황뿐, 확정 아님 |
| 재연결을 조작으로 오탐한 것 | **2건**(11:34 바닥 조명 두 대) |
| 우리 명령을 조작으로 오탐한 것 | **0건** |

마지막 줄이 중요하다. #32·#34에서 대조 창을 넓힌 것은 "우리 명령이 현장 조작으로
둔갑하는 것"을 막기 위해서였는데, **그 사건은 아직 한 번도 관측되지 않았다**
(다만 판별 자체가 미검증이라 '없었다'와 '못 봤다'를 가를 수 없다). 상수가
서로 안 맞았던 것(120초 창 vs 600초 폴링)은 사실이니 예방으로는 정당하다. 다만 대가가 있다:

> 대조 창 안에서 일어난 **진짜 현장 조작은 우리 것으로 흡수돼 안 알린다.**
> 예전엔 그 창이 120초였는데, 지금은 빈 시간에 **최대 10분**이다.

즉 한 번도 안 본 오탐을 막으려고, 오늘만 두 번 본 종류의 사건을 더 많이 삼키게 됐다.
하필 어드민 페이지로 조작한 직후에 현장에서 손으로 만지는 일이 잦다 — 오늘 아침이 그러했다.

선택지는 셋이고, 아직 고르지 않았다:

1. **그대로 둔다** — "없는 일을 알리는 것보다 낫다"는 기존 원칙 그대로. 대신 빈 시간의
   현장 조작은 우리가 뭔가 조작한 직후면 종종 놓친다.
2. **창에 상한을 둔다** — 예: 최대 3분. 그보다 넘으면 설명될 수 있어도 알린다.
3. **빈 시간 폴링을 좁혀 애매함 자체를 줄인다** — 600초 → 120초면 두 문제가 동시에
   작아진다. 대가는 ThinQ 호출 5배(하루 144회 → 720회)이고, PAT 인증이 약하다는
   이유로 600초를 고른 경위가 있다(형운 결정, 2026-08-07).

**대조 창은 이제 고정 120초가 아니다**(#32·#34). 기기별로 "마지막 판독값 이후", 최소
120초다. 2026-08-07~08 실측에서 조명 반영은 **12~31초**였으나, 에이전트가 밀렸을 때의
최악 경로(큐 TTL 60초를 거의 다 쓰는 경우)는 재현하지 못했다.


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

**그리고 같은 날 한 번 더 배포했다(PR #34, 11:55).** 위 배포 직후 프로덕션 장부를 읽어
검증했는데 세 가지가 나왔고, 그중 하나는 **#32의 대조 창 수정이 사실상 무용지물이었다**는
것이었다 — `seen_at`에 틱 시각을 넣고 있어 창이 항상 1분짜리로 좁았다(6대의 `seen_at`이
전부 `11:42:00`으로 같았다).

재배포 뒤 확인됨:

```
device_watch.seen_at   에어컨 11:57:52 · SiHAS 11:57:33 · 좌측벽면 11:56:23
                       벽조명 11:55:07 · 우측바닥 11:55:00 · 좌측바닥 11:55:00
```

기기마다 값이 다르다 = 틱 시각이 아니라 **각 판독값의 출처 시각**을 담고 있다. 대조 창이
처음으로 제 역할을 한다. 재배포 이후 오탐 0건.

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
