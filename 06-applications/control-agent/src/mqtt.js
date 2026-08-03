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
    const filters = UPSTREAM_PREFIXES.map((p) => `${p}/+/#`);
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
    try {
      onMessage(topic, payload.toString());
    } catch (e) {
      // 한 메시지의 오류가 루프를 죽이지 않게 한다.
      console.error("[mqtt] 메시지 처리 실패", topic, e);
    }
  });

  client.on("error", (e) => console.error("[mqtt] 오류:", e.message));
  client.on("reconnect", () => console.log("[mqtt] 재접속 시도..."));
  client.on("close", () => console.log("[mqtt] 연결 끊김"));

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
 */
export async function queryInitialState(client, addresses) {
  for (const address of addresses) {
    try {
      await publish(client, `cmnd/${address}/POWER`, "");
    } catch (e) {
      console.error(`[mqtt] 초기 상태 질의 실패 (${address}):`, e.message);
    }
  }
  if (addresses.length) console.log(`[mqtt] 초기 상태 질의 ${addresses.length}대`);
}
