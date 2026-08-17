/**
 * rpi-bridge 관측 상태 — 단일 책임: "지금 상태를 HTTP로 대신 읽어야 하는가"의 판정.
 *
 * 관측은 mqtt.js가 넣고(브릿지 상태 토픽·연결 끊김), 판정은 index.js가 읽는다.
 * mqtt.js에 두지 않는 이유는 테스트다 — 이 판정은 순수 로직인데 mqtt.js를 import하면
 * mqtt 패키지가 딸려 와서, 의존성 설치 없이 도는 지금의 테스트 방식이 깨진다.
 *
 * ⚠️ **이 값은 명령 배달 경로 판정에 쓰지 않는다.** mosquitto가 같은 `cmnd/#`를 AWS IoT로도
 * 항상 병렬 릴레이하므로, 브릿지가 죽었다는 게 명령 유실 확정이 아니다 — 그때 HTTP로 직행하면
 * AWS로 나간 사본이 확인될 기회를 뺏는다(delivery.js·README 참조). 여기서 다루는 건 **상태를
 * 어디서 읽을지**뿐이다: stat이 못 오는 동안 화면이 얼어붙지 않게 HTTP로 대신 읽는 판정.
 */

/** true=붙음, false=끊김, **null=모름**(브릿지 없는 브로커거나 아직 안 받음). */
let bridgeUp = null;

/**
 * '모름'이 시작된 시각. 기동 직후부터 모름이므로 로드 시각으로 초기화한다.
 * bridgeUp이 true/false로 확정되면 의미가 없어진다(needsHttpResync가 안 본다).
 */
let unknownSince = Date.now();

/** 브릿지 상태 토픽이 확정값("1"/"0")을 줬을 때. */
export function noteBridgeState(up) {
  bridgeUp = up;
}

/**
 * 브로커 연결이 끊겨 브릿지 생사를 알 수 없게 됐을 때. 마지막 값을 붙들고 있으면
 * 재접속 직후 낡은 정보로 판단하게 되므로 '모름'으로 되돌린다(retained라 곧 다시 온다).
 */
export function noteBridgeUnknown(now = Date.now()) {
  bridgeUp = null;
  unknownSince = now;
}

/** 관측용. 상태 전이 로그와 재동기화 판정 밖에서는 쓰지 말 것(위 경고 참조). */
export function isBridgeUp() {
  return bridgeUp;
}

/**
 * '모름'을 얼마나 겪어야 재동기화로 넘어가는가.
 *
 * 브릿지 상태 토픽은 retained라 (재)접속 후 수초 안에 확정값이 온다 — 그보다 훨씬 긴 60초를
 * 모름인 채로 보냈다면 브로커 자체가 안 붙는 상황이고, 그동안 stat도 못 오므로 HTTP로 읽는 게
 * 맞다. 유예를 아예 없애면 재접속 직후의 수초짜리 모름 창에 5분 틱이 겹칠 때 불필요한 폴링
 * 한 바퀴가 나간다 — 해는 없지만, '모름'과 '끊김 확정'을 같게 취급하지 않는다는 선을 남긴다.
 */
const UNKNOWN_GRACE_MS = 60_000;

/**
 * 순수 판정 — 상태를 인자로 받아 테스트가 시각을 마음대로 움직일 수 있게 한다.
 *
 * `false`(끊김 확정)는 즉시 참: stat이 그 경로로 못 온다는 확정이다.
 * `null`(모름)은 유예를 넘겼을 때만 참: 브로커가 안 붙어 확정값 자체를 못 받는 상황 —
 * 이때도 stat은 안 오므로 안 읽으면 화면이 얼어붙는다(예전엔 `=== false`만 봐서 이 구간이
 * 사각지대였다). `true`는 거짓: MQTT stat이 실시간으로 오는데 같은 걸 HTTP로 또 물을 이유가 없다.
 */
export function shouldHttpPoll(up, unknownForMs, graceMs = UNKNOWN_GRACE_MS) {
  if (up === false) return true;
  return up === null && unknownForMs >= graceMs;
}

/** index.js의 주기 틱이 부르는 실제 판정. */
export function needsHttpResync(now = Date.now()) {
  return shouldHttpPoll(bridgeUp, now - unknownSince);
}
