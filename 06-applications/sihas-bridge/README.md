# SiHAS SQM-300 ↔ MQTT 브리지

SQM-300 스위치는 로컬 UDP(포트 502) 커스텀 프로토콜만 안다 — MQTT도 클라우드도 모른다.
이 미들웨어가 현장 맥에서 상시 돌면서 UDP를 MQTT로 번역한다.

**설계 원칙: 백엔드는 SiHAS의 존재를 몰라도 된다.** 이 브리지는 Tasmota가 쓰는 것과
문자 하나 다르지 않은 토픽 계약을 흉내 낸다. 그래서 `admin.html`·`supabase/functions/control/`은
단 한 줄도 바뀌지 않는다 — DB에는 `devices.adapter = 'tasmota'` 그대로 등록한다.

| 토픽 | 방향 | payload |
|---|---|---|
| `cmnd/<address>/POWER` | 구독 | `ON`/`OFF` = 명령, **빈 값 = 상태 질의**(전원 불변) |
| `stat/<address>/POWER` | 발행 | `ON`/`OFF` = 실측 상태 |
| `tele/<address>/LWT` | 발행 | `Online`/`Offline`, retained (+ MQTT will) |

이 리포의 다른 코드를 import 하지 않는다. 서드파티 의존성은 **paho-mqtt 하나뿐**이다.

## 동작

- 로컬 mosquitto(`localhost:1883`, `control-setup.md` B-3에서 세팅한 그 브로커)에 인증 붙여
  접속한다.
- 명령을 받으면 UDP로 쏘고, **0.5초 뒤 실측**한다. 어긋나면 1.2초 더 기다려 한 번 더 읽는다.
  어긋난 중간값은 발행하지 않는다 — 릴레이가 붙기 전 옛값을 내보내면 UI 토글이 되돌아갔다
  다시 켜지는 것처럼 깜빡인다. 2회 후에도 불일치면 **실측값을 그대로 발행하고** `WARNING`을
  남긴다(낙관값을 진실인 척 내보내지 않는다).
- 명령과 무관하게 30초마다 폴링한다. 채널 설정 오류·기기 다운이 스스로 드러나게 하는 안전망.
- UDP 접근은 워커 스레드 하나로 직렬화한다(기기가 동시 요청을 잘 받지 못한다).
- mosquitto 연결이 끊기면 1~30초 backoff로 무한 재접속한다. 크래시하지 않는다.

## 설치

```bash
cd 06-applications/sihas-bridge

# 설정 채우기 — IP/MAC은 실배치 정보라 커밋되지 않는다(.gitignore)
cp config.example.json config.json
$EDITOR config.json   # mqtt_username/mqtt_password는 mosquitto_passwd로 만든 그 계정과 같아야 한다

# 의존성 (venv 권장). 콜백 API v2를 쓰므로 2.0 이상이어야 한다
python3 -m venv .venv && ./.venv/bin/pip install 'paho-mqtt>=2.0'

# 손으로 한 번 띄워 로그부터 확인 (launchd 등록은 그다음)
./.venv/bin/python -m sihas_bridge config.json
```

`-m`은 cwd 기준으로 패키지를 찾는다 — **반드시 이 폴더(`06-applications/sihas-bridge/`)에서**
실행한다.

로그가 정상이면 launchd에 올린다:

```bash
cp deploy/kr.nmwc.typelounge.sihas-bridge.plist.example \
   /tmp/kr.nmwc.typelounge.sihas-bridge.plist
$EDITOR /tmp/kr.nmwc.typelounge.sihas-bridge.plist   # <<<...>>> 전부 치환
sudo cp /tmp/kr.nmwc.typelounge.sihas-bridge.plist /Library/LaunchDaemons/kr.nmwc.typelounge.sihas-bridge.plist
sudo chown root:wheel /Library/LaunchDaemons/kr.nmwc.typelounge.sihas-bridge.plist
sudo chmod 644 /Library/LaunchDaemons/kr.nmwc.typelounge.sihas-bridge.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/kr.nmwc.typelounge.sihas-bridge.plist
```

LaunchDaemon 대신 LaunchAgent를 쓸지, 왜 LaunchDaemon을 기본으로 권하는지는
`deploy/kr.nmwc.typelounge.sihas-bridge.plist.example`의 주석 참조.

### config.json

```json
{
  "mqtt_host": "localhost",
  "mqtt_port": 1883,
  "poll_interval_s": 30,
  "mqtt_username": "nmwc",
  "mqtt_password": "<브로커비번>",
  "devices": [
    {"address": "sihas_...", "ip": "192.168.x.x", "mac": "aa:bb:cc:dd:ee:ff", "channel": 0}
  ]
}
```

`devices`는 배열이다 — 다채널·다기기로 늘 때 **코드 변경 없이 원소만 추가**하면 된다.
`address`(영숫자·`_`·`-` 1~32자) 문법은 기동 시점에 검증해 어긋나면 즉시 죽는다. 통과시켜봐야
명령이 에러 없이 조용히 사라질 뿐이다.

멀티갱(다채널) SQM-300은 채널마다 `devices` 원소 1개 + DB `devices` 행 1개가 필요하다
(예: `sihas_aabbcc_ch0`/`ch1`/`ch2`, `ip`·`mac`은 같고 `channel`만 다름).

기기 IP는 고정해야 한다(공유기 DHCP 예약, `control-setup.md` B-2와 동일한 이유). IP가
바뀌면 브리지는 응답 없음만 반복한다.

## admin.html 등록

SiHAS는 백엔드 입장에서 Tasmota와 구분되지 않는다. **"+ 조명 추가"**에 이 브리지가 쓰는
`address`(`config.json`의 값과 동일한 문자열)와 부를 이름을 그대로 넣으면 된다 —
`control-setup.md` B-6과 동일한 절차.

**주소는 두 곳에서 일치해야 한다: `config.json`의 `address` / admin.html에 등록한 기기 ID.**
브리지는 기동할 때 자기가 실제로 쓰는 토픽 문자열을 로그에 그대로 찍는다 — 등록한 주소와
눈으로 대조하라.

## 검증 절차 (현장에서 손으로)

실기기 E2E는 이 코드가 작성된 환경에 SQM-300이 없어 수행할 수 없었다. 배포 후 사람이
아래를 확인한다.

1. **기동 로그에서 토픽 3개 확인**: `bridge topics: ['cmnd/...', 'stat/...', 'tele/...']`.
2. **제어 페이지에서 토글** → **6초 내 상태 반영** 확인.
   반영이 안 되면 브로커에서 직접 들여다본다:
   ```bash
   mosquitto_sub -h localhost -u nmwc -P '<브로커비번>' -t 'stat/#' -t 'tele/#' -v
   mosquitto_pub -h localhost -u nmwc -P '<브로커비번>' -t 'cmnd/<address>/POWER' -m ON
   ```
   `cmnd`가 보이는데 `stat`이 안 나오면 → 기기/UDP 문제(브리지 로그의 "응답 없음" 확인).
   `cmnd` 자체가 안 보이면 → `config.json`의 address와 admin.html 등록 주소 불일치.
3. **채널 확인** — 토글했는데 `명령 후 재확인 불일치` 경고가 뜨면 `channel` 값이 틀렸거나
   기기가 로컬 제어를 거부(`로컬 제어 비활성`)하는 것이다.
4. **LAN 케이블 뽑고 10분** → UI가 stale/offline로 표시되는지 확인.
   브리지 프로세스를 강제 종료(`kill -9`)하면 브로커가 will로 `LWT Offline`을 대신 발행한다.

## 롤백

```bash
sudo launchctl bootout system /Library/LaunchDaemons/kr.nmwc.typelounge.sihas-bridge.plist
sudo rm /Library/LaunchDaemons/kr.nmwc.typelounge.sihas-bridge.plist
```

그다음 admin.html에서 해당 기기를 삭제한다. **행이 없으면 나머지는 무해하다** — 제어 UI에
아무것도 뜨지 않을 뿐이다.

## 테스트

```bash
cd 06-applications/sihas-bridge
../../.venv-test/bin/pytest tests/ -q   # 또는 pip install pytest 후 pytest tests/ -q
```

`protocol.py`의 바이트 단위 유닛 테스트다(실기기 불필요). 체크섬이나 오프셋이 한 칸
어긋나면 기기는 에러 없이 침묵하므로, 기대 바이트열을 손으로 적어 하드코딩해 고정했다.

## 출처

UDP 프로토콜은 [sihas-canary](https://github.com/cmsong-shina/sihas-canary)
(BSD-3-Clause, Copyright (c) 2021, cmsong-shina)를 참고해 최소 재구현했다.
원본 이식: [nmwc-ai/Space](https://github.com/nmwc-ai/Space) `middleware/sihas_bridge`
(`feat/sihas-sqm300-switch`) — 이 리포는 다중 테넌트가 아니라서 `space_id`(`spc_`+hex 12자)
분리 코드를 전부 제거하고 이식했다.
