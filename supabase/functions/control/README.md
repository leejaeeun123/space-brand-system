# 공간 제어 (냉난방)

`admin.html`의 **공간 제어** 탭이 쓰는 Edge Function. 지금은 **LG ThinQ 냉난방만** 연결돼 있다.

Space(`nmwc-ai/Space`, 유재형)의 `src/control/thinq` 를 이식한 것이다. 그쪽 AWS 인프라는
쓰지 않는다 — 접근 권한이 없다. ThinQ는 순수 HTTPS REST라 인프라 없이 그대로 옮겨진다.

## 왜 Edge Function인가 (편의가 아니라 필수)

`admin.html`은 소스가 그대로 공개된다. ThinQ PAT가 거기 들어가면 **LG 계정 전체**가 노출된다.
그래서 비밀을 들고 있는 층이 서버에 하나 필요하고, 그게 이 함수다.

같은 이유로 `devices`·`device_state` 테이블은 RLS를 켜되 **정책을 만들지 않았다** — anon 키로는
읽기도 쓰기도 불가능하고, 이 함수(service_role)만이 유일한 접근 경로다. 예약(`reservations`)과
다르게 간 이유는 위험의 등급이 다르기 때문이다: 예약은 읽혀도 정보가 새는 정도지만, 기기 제어는
소스만 본 사람이 **손님 이용 중에 냉난방을 끌 수 있다**.

## 설치 절차

**→ [`06-applications/control-setup.md`](../../../06-applications/control-setup.md) 의 A 단계를 따른다.**

절차를 그쪽 한 군데에만 둔 이유: 냉난방과 조명 절차를 나눠두면 한쪽만 고쳐졌을 때 조용히 어긋난다.
이 문서는 **왜 그렇게 만들었는지**와 구조를 다룬다.

한 가지만 여기 남긴다 — 등록 시 capabilities/constraints를 **기기 프로파일에서 파생한다.**
클라이언트가 준 값을 쓰지 않는다. 근거는 원본의 실측이다 — 문서 예시와 실기기가
**step·모드·풍량 세 군데에서 달랐다**(ss-4er). 실기기 프로파일이 유일한 진실원이다.

## 확인

```bash
# 비밀번호 틀리면 401
curl -s -X POST "https://sewqusncgznypjigmfde.supabase.co/functions/v1/control" \
  -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
  -d '{"action":"list","password":"<비밀번호>"}'
```

`{"thinq_configured":true, ...}` 가 나오면 시크릿이 제대로 들어간 것이다.
로그는 Supabase 대시보드 → Edge Functions → control → Logs.

## 구조

| 파일 | 책임 |
|---|---|
| `index.ts` | HTTP 표면 — CORS·비밀번호 검증·라우팅 |
| `handlers/list.ts` | 목록 조회 + ThinQ 상태 갱신(TTL 30초) |
| `handlers/command.ts` | 명령 1건 검증·발행 |
| `handlers/registry.ts` | 기기 등록/해제, ThinQ 계정 기기 목록 |
| `thinq/client.ts` | HTTP 클라이언트 + 에러 매핑 |
| `thinq/commands.ts` | Command → 제어 본문 + 범위/enum 검증 |
| `thinq/profile.ts` | 프로파일 → capabilities/constraints 파생 |
| `thinq/state.ts` | state 응답 → DeviceState |
| `devices.ts` | Postgres 접근 (service_role) |
| `tasmota/topics.ts` | 조명 MQTT 토픽 문법 + 기기 ID 검증 |

action은 6개: `list` · `thinq_devices` · `register` · `register_light` · `command` · `delete`.

## 절대 되돌리면 안 되는 것

- **`power = null`('모름')을 `'OFF'`로 합치지 말 것.** 합치면 꺼진 줄 알았는데 실제로는 켜져 있는
  상황 — 즉 **냉난방이 밤새 돌아가는 상황** — 이 조용히 숨는다. UI도 이 둘을 구분해 표시한다.
- **`updated_at`의 기본값을 `now()`로 주지 말 것.** 한 번도 상태를 못 받은 기기가 '방금 갱신됨'으로
  보여 화면에 '0초 전'이라 표시된다. 수신 이력이 없으면 `null`이다.
- **PAT 401은 재시도하지 말 것.** 자동 재발급 경로가 없다 — 만료되면 사람이 갱신하는 수밖에 없고,
  재시도는 계정 잠금 위험만 만든다.
- **capabilities를 클라이언트가 주는 값으로 쓰지 말 것.** ThinQ는 프로파일에서만 파생한다.

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
