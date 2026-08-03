/**
 * Tasmota MQTT 토픽 문법 — 단일 책임: 토픽을 만들고 기기 ID를 검증한다.
 *
 * 구조는 **Tasmota 기본값** `%prefix%/%topic%/` 을 그대로 쓴다:
 *
 *     cmnd / light_main / POWER
 *      1        2           3
 *
 *   1: prefix — cmnd(하행) / stat(상행 결과) / tele(상행 텔레메트리·LWT)
 *   2: 기기 ID = Tasmota의 `Topic` 설정값. devices.address에 저장된다.
 *   3: 서브토픽 (POWER / RESULT / LWT / STATE …)
 *
 * Space는 여기에 space_id 세그먼트를 하나 더 끼워 `cmnd/spc_xxx/light_main/POWER` 로 썼다.
 * 그건 **AWS IoT라는 공용 브로커**를 여러 공간·프로젝트가 나눠 쓰기 때문이었다(정책으로
 * 격리를 강제하는 유일한 지점). 여기 브로커는 합정 맥 위의 전용 로컬 브로커라 나눠 쓸
 * 상대가 없다 — 세그먼트를 하나 줄여 Tasmota 기본 설정 그대로 쓴다(설정 실수 여지 감소).
 */

export const PREFIX_CMND = "cmnd";
export const PREFIX_STAT = "stat";
export const PREFIX_TELE = "tele";

export class TopicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicError";
  }
}

// 와일드카드(+ #)와 구분자(/)는 반드시 배제한다.
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Tasmota `Topic`으로 쓸 기기 ID 검증. devices.address에 저장되는 값이다.
 *
 * 와일드카드를 막는 게 핵심이다. address가 '+'나 '#'이면
 *   - 구독이 남의 기기 토픽까지 빨아들이고,
 *   - 발행에는 와일드카드를 쓸 수 없어 브로커가 거부하거나 **의도치 않은 다수 기기에
 *     명령이 간다**(조명 전체가 한꺼번에 켜지는 식).
 * '/'를 막는 이유는 기기 ID가 세그먼트 **하나**여야 파싱이 성립하기 때문이다.
 *
 * 등록 시점이 이걸 막을 수 있는 가장 싼 지점이다 — 런타임에 터지면 원인을 찾기 어렵다.
 */
export function validateDeviceId(deviceId: string): string {
  const v = (deviceId ?? "").trim();
  if (!v) throw new TopicError("기기 ID가 비어 있습니다");
  if (v.includes("+") || v.includes("#")) {
    throw new TopicError(`기기 ID에 MQTT 와일드카드(+, #)를 쓸 수 없습니다: ${deviceId}`);
  }
  if (v.includes("/")) {
    throw new TopicError(`기기 ID는 단일 세그먼트여야 합니다 (/ 불가): ${deviceId}`);
  }
  if (!DEVICE_ID_RE.test(v)) {
    throw new TopicError(`기기 ID는 영숫자·_·- 1~32자만 허용합니다: ${deviceId}`);
  }
  return v;
}

/** 하행 명령 토픽. 예: cmnd/light_main/POWER */
export function commandTopic(deviceId: string, suffix: string): string {
  return `${PREFIX_CMND}/${validateDeviceId(deviceId)}/${suffix}`;
}
