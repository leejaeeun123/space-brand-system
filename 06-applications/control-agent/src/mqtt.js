/**
 * 로컬 mosquitto 연결 — 단일 책임: 상행 구독과 하행 발행.
 *
 * 재접속은 mqtt.js가 알아서 한다(기본 1초 백오프). 우리가 따로 루프를 돌리지 않는다.
 */

import mqtt from "mqtt";
import { UPSTREAM_PREFIXES } from "./state.js";

// AWS IoT는 QoS 2를 지원하지 않아 Space는 QoS 1로 고정했다. 여기 브로커는 mosquitto라
// QoS 2도 되지만, 굳이 다르게 갈 이유가 없어 1로 맞춘다(중복 수신은 멱등 upsert가 흡수).
const QOS = 1;

/**
 * mosquitto가 rpi-bridge 생사를 알려주는 토픽(retained). `"1"`=붙음, `"0"`=끊김.
 *
 * **`client.connected`와 다른 것을 본다.** 그건 맥이 자기 로컬 브로커에 붙었는지일 뿐이라
 * 맥이 켜져 있는 한 항상 참이다. 정작 기기까지 가는 구간은 브릿지고, `cmnd/# out`이
 * QoS 0이라 이 브릿지가 죽어 있으면 발행은 성공하는데 그 경로의 메시지는 버려진다.
 */
const BRIDGE_STATE_TOPIC = "$SYS/broker/connection/rpi-bridge/state";

/** true=붙음, false=끊김, **null=모름**(브릿지 없는 브로커거나 아직 안 받음). */
let bridgeUp = null;

/**
 * ⚠️ **이 값은 배달 경로 판정에 쓰지 않는다 — 관측용이다.**
 *
 * 예전에는 `decideDelivery`가 이걸 보고 "브릿지가 죽었으면 기다리지 말고 바로 HTTP"로
 * 갈랐다. 지금은 mosquitto가 같은 `cmnd/#`를 AWS IoT Core로도 항상 병렬로 내보내므로
 * (mosquitto.conf의 aws-iot-cmnd-bridge) 이 브릿지가 죽었다는 게 유실 확정이 아니고,
 * 그 상태에서 HTTP로 직행하면 AWS로 나간 사본이 확인될 기회를 뺏는다.
 *
 * **다시 `decideDelivery`에 연결하지 말 것.** 그러면 병렬 경로를 만든 이유가 사라진다.
 * 남겨둔 이유는 아래 상태 전이 로그다 — "조명이 왜 느리지"를 추적할 때 첫 단서가 된다.
 */
export function isBridgeUp() {
  return bridgeUp;
}

export function connectMqtt(cfg, { onMessage, onConnect }) {
  const client = mqtt.connect(cfg.mqttUrl, {
    username: cfg.mqttUser,
    password: cfg.mqttPassword,
    clientId: `typelounge-agent-${Math.random().toString(16).slice(2, 10)}`,
    // false = 브로커가 우리 구독을 기억하지 않는다. 재접속 때 우리가 다시 건다(아래 on connect).
    clean: true,
    reconnectPeriod: 2000,
  });

  client.on("connect", () => {
    const filters = [...UPSTREAM_PREFIXES.map((p) => `${p}/+/#`), BRIDGE_STATE_TOPIC];
    client.subscribe(filters, { qos: QOS }, (err) => {
      if (err) {
        console.error("[mqtt] 구독 실패:", err.message);
        return;
      }
      console.log(`[mqtt] 연결됨 — 구독: ${filters.join(", ")}`);
      onConnect?.(client);
    });
  });

  client.on("message", (topic, payload) => {
    if (topic === BRIDGE_STATE_TOPIC) {
      bridgeUp = payload.toString().trim() === "1";
      console.log(
        `[mqtt] rpi-bridge ${bridgeUp ? "연결됨" : "끊김 — 명령은 AWS 경로로 갑니다(확인 없으면 HTTP 우회)"}`,
      );
      return;
    }
    try {
      onMessage(topic, payload.toString());
    } catch (e) {
      // 한 메시지의 오류가 루프를 죽이지 않게 한다.
      console.error("[mqtt] 메시지 처리 실패", topic, e);
    }
  });

  client.on("error", (e) => console.error("[mqtt] 오류:", e.message));
  client.on("reconnect", () => console.log("[mqtt] 재접속 시도..."));
  client.on("close", () => {
    console.log("[mqtt] 연결 끊김");
    // 끊긴 동안 브릿지가 어떻게 됐는지 알 길이 없다. 마지막 값을 붙들고 있으면
    // 재접속 직후 낡은 정보로 판단하게 되므로 '모름'으로 되돌린다(retained라 곧 다시 온다).
    bridgeUp = null;
  });

  return client;
}

export function publish(client, topic, payload) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: QOS }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 접속 직후 등록된 기기 각각에 **빈 payload로 POWER를 발행**한다.
 *
 * Tasmota에서 빈 payload는 '설정'이 아니라 '질의'다 — 전원 상태를 바꾸지 않고 현재값만
 * 되돌려준다. 이게 없으면 기기가 스스로 보고할 때까지 화면이 '아직 상태를 받은 적 없음'으로
 * 남는다. (Space가 retained 재생 실패 후 채택한 것과 같은 방법 — 그쪽 D4)
 *
 * 같이 `Status 5`도 물어본다 — 응답(STATUS5)에 기기의 LAN IP가 들어 있다. 브릿지가 끊겨
 * MQTT가 막혔을 때 HTTP로 우회하려면 IP가 필요한데, DHCP라 미리 아는 값이 아니다.
 * 스캔으로 찾지 않는 이유는 실측이다 — 254개 병렬 요청에 ESP8266이 실제로 응답을 놓쳤다.
 */
export async function queryInitialState(client, addresses) {
  for (const address of addresses) {
    try {
      await publish(client, `cmnd/${address}/POWER`, "");
      await publish(client, `cmnd/${address}/Status`, "5");
    } catch (e) {
      console.error(`[mqtt] 초기 상태 질의 실패 (${address}):`, e.message);
    }
  }
  if (addresses.length) console.log(`[mqtt] 초기 상태 질의 ${addresses.length}대`);
}
