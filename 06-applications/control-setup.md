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

## 막혔을 때

| 증상 | 확인 |
|---|---|
| A-4에서 `thinq_configured:false` | 시크릿 3개가 다 들어갔나. 하나라도 비면 미설정으로 본다 |
| A-5에서 `ThinQ 인증 실패` | PAT 만료. **재시도해도 소용없다** — 재발급이 유일한 길이다 |
| B-4에서 `SUBSCRIBED`가 안 뜬다 | service_role 키, 인터넷. 이게 없으면 명령이 안 온다 |
| 조명 카드가 "아직 상태를 받은 적 없음" | 기기가 브로커에 못 붙음. Console에서 `MqttHost`·`MqttUser` 확인 |
| 눌러도 반응 없음 | `agent.log`에 `[cmd] 발행`이 있나 → 있으면 기기 쪽, 없으면 Realtime 쪽 |
| `[cmd] 만료 — 실행하지 않음` | **정상이다.** 60초 넘은 명령은 일부러 버린다 (아래) |
| 어제까지 되던 조명이 먹통 | B-2 DHCP 예약이 풀렸는지 |

## 알아둘 것

- **오래된 명령은 실행하지 않는다.** 맥이 꺼져 있던 동안 쌓인 명령을 재생하면 **새벽 3시에
  조명이 켜진다.** 60초가 지나면 `expired`로 버린다. 늦은 실행보다 미실행이 안전하다.
- **조명의 `sent`는 '기기가 실행했다'가 아니다.** 브로커에 발행했다는 뜻이다. 실제 반영은
  기기가 `stat`으로 보고하고 에이전트가 `device_state`에 쓴다. 냉난방(HTTP 동기)은 반대로
  한 호출에서 `acked`로 확정된다.
- **`모름`은 `꺼짐`이 아니다.** 연결이 끊겨도 마지막 전원값은 유지된다 — `LWT=Offline`은
  `online`만 바꾸고 `power`는 건드리지 않는다. 합치면 꺼진 줄 알았는데 켜져 있는 상황,
  즉 **냉난방이 밤새 도는 상황**이 조용히 숨는다.
- **키를 브라우저에 두지 않는다.** ThinQ PAT와 service_role 키는 Edge Function과 합정 맥에만
  있다. `admin.html`은 소스가 공개되므로 거기 들어가면 계정 전체가 노출된다.

## 아직 검증 안 된 것

**실기기로는 확인하지 못했다.** 냉난방은 PAT가 없어 ThinQ 왕복을 못 돌렸고, 조명은 가짜
Tasmota로 프로토콜만 확인했다. 실기기 펌웨어·실제 mosquitto 동작은 이 절차를 밟으면서
처음 확인된다. B-5에서 막히면 `Backlog` 대신 한 줄씩 넣어본다.
