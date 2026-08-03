/**
 * 합정 현장 상주 에이전트 — 로컬 mosquitto와 Supabase를 잇는다.
 *
 *   Tasmota ──평문 1883──> mosquitto ──> [이 프로세스] ──HTTPS/WSS──> Supabase
 *
 * 두 방향이 있다:
 *   하행(명령)  Supabase Realtime INSERT → mosquitto cmnd 발행
 *   상행(상태)  mosquitto stat/tele 구독 → device_state 저장
 *
 * 인바운드 포트를 열지 않는다. 둘 다 이 프로세스가 나가서 맺는 연결이다.
 */

import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import { DeviceRegistry } from "./devices.js";
import { connectMqtt, queryInitialState } from "./mqtt.js";
import { subscribeCommands } from "./commands.js";
import { mergeState, parsePayload, parseTopic } from "./state.js";

const RELOAD_INTERVAL_MS = 5 * 60_000; // 기기 등록/해제 반영 주기

const cfg = loadConfig();
const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: false },
  // Node 20에는 네이티브 WebSocket이 없어서 Realtime이 기동 즉시 죽는다(Node 22부터 내장).
  // ws를 명시적으로 물려 두 버전 모두에서 돌게 한다 — 현장 맥의 Node 버전을 가정하지 않는다.
  realtime: { transport: WebSocket },
});
const registry = new DeviceRegistry(sb);

/** 상행 메시지 1건을 device_state에 반영한다. 우리 것이 아니면 조용히 무시. */
async function handleMessage(topic, payload) {
  const parsed = parseTopic(topic);
  if (!parsed) return;

  const delta = parsePayload(parsed.suffix, payload);
  if (delta === null) return; // 전원과 무관한 텔레메트리(SENSOR 등)

  const device = registry.find(parsed.address);
  if (!device) {
    // 브로커엔 있는데 우리 DB엔 없는 기기 — 등록되지 않았을 뿐 오류가 아니다.
    return;
  }

  const current = await registry.currentState(device.id);
  await registry.saveState(device.id, mergeState(current, delta));
  console.log(`[state] ${device.name}(${parsed.address}) ← ${parsed.suffix}=${payload}`);
}

async function main() {
  if (!(await registry.reload())) {
    console.error("[agent] 기기 목록을 못 읽어 시작할 수 없습니다. 키와 네트워크를 확인하세요.");
    process.exit(1);
  }
  console.log(`[agent] 조명 기기 ${registry.addresses.length}대 로드`);

  const mqttClient = connectMqtt(cfg, {
    onMessage: (topic, payload) =>
      handleMessage(topic, payload).catch((e) => console.error("[state] 반영 실패:", e)),
    // 접속(재접속 포함)할 때마다 현재 상태를 다시 물어본다 — 끊긴 동안의 변화를 메운다.
    onConnect: (client) => queryInitialState(client, registry.addresses),
  });

  subscribeCommands(sb, { mqttClient, registry });

  setInterval(() => {
    registry.reload().then((ok) => {
      // 새로 등록된 기기는 아직 상태를 받은 적이 없으니 한 번 물어봐 준다.
      if (ok && mqttClient.connected) queryInitialState(mqttClient, registry.addresses);
    });
  }, RELOAD_INTERVAL_MS);

  const shutdown = () => {
    console.log("\n[agent] 종료합니다.");
    mqttClient.end(true, () => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[agent] 시작 실패:", e);
  process.exit(1);
});
