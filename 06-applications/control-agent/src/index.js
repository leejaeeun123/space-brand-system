/**
 * 합정 현장 상주 에이전트 — 로컬 mosquitto와 Supabase를 잇는다.
 *
 *   Tasmota ──LAN──> RPi mosquitto ──rpi-bridge(tailscale)──> 맥 mosquitto ──> [이 프로세스]
 *                          ↑                                       │                │
 *                          └──── AWS IoT Core ←── aws-iot-cmnd-bridge┘   Supabase <──┘
 *                                (Pi 자체 브릿지)                          HTTPS/WSS
 *
 * 기기가 붙는 브로커는 RPi고, 맥 브로커는 그걸 브릿지로 받아온다.
 *
 * 두 방향이 있다:
 *   하행(명령)  Supabase Realtime INSERT → mosquitto cmnd 발행 → 브릿지 → 기기
 *   상행(상태)  mosquitto stat/tele 구독 → device_state 저장
 *
 * 인바운드 포트를 열지 않는다. 둘 다 이 프로세스가 나가서 맺는 연결이다.
 *
 * **하행은 한 번 발행하면 경로가 둘로 갈라진다.** 맥 브로커가 같은 `cmnd/#`를 rpi-bridge와
 * aws-iot-cmnd-bridge로 **항상 병렬** 릴레이하고, Pi는 자체 AWS 브릿지로 후자를 직접 받는다.
 * tailscale이 끊겨도 명령이 기기까지 가는 길이 남는다는 뜻이다. 이 프로세스는 어느 쪽으로
 * 갔는지 모르고, 알 필요도 없다 — 기기가 `stat`으로 답하면 도착한 것이다.
 *
 * 그래도 답이 없으면 우회로가 하나 더 있다: 같은 LAN에 있는 기기에 HTTP로 직접
 * 말한다(tasmota-http.js).
 */

import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import { DeviceRegistry } from "./devices.js";
import { connectMqtt, queryInitialState } from "./mqtt.js";
import { subscribeCommands } from "./commands.js";
import { mergeState, parsePayload, parseTopic } from "./state.js";
import { startCameraReporter } from "./cameras.js";
import { noteDeviceReport } from "./delivery.js";
import { loadDeviceIps, rememberDeviceIp } from "./device-ips.js";

const RELOAD_INTERVAL_MS = 5 * 60_000; // 기기 등록/해제 반영 주기

const cfg = loadConfig();
const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: false },
  // Node 20에는 네이티브 WebSocket이 없어서 Realtime이 기동 즉시 죽는다(Node 22부터 내장).
  // ws를 명시적으로 물려 두 버전 모두에서 돌게 한다 — 현장 맥의 Node 버전을 가정하지 않는다.
  realtime: { transport: WebSocket },
});
const registry = new DeviceRegistry(sb);

/**
 * 델타 1건을 device_state에 반영한다. **상태를 쓰는 길은 여기 하나뿐이다** —
 * MQTT로 왔든 HTTP 우회로 읽었든 같은 `mergeState`를 지난다. 길을 둘로 만들면
 * '모름을 OFF로 합치지 않는다'는 규칙을 두 군데서 지켜야 하고, 언젠가 한 쪽이 어긋난다.
 */
async function applyState(address, delta) {
  const device = registry.find(address);
  if (!device) {
    // 브로커엔 있는데 우리 DB엔 없는 기기 — 등록되지 않았을 뿐 오류가 아니다.
    return;
  }
  const current = await registry.currentState(device.id);
  await registry.saveState(device.id, mergeState(current, delta));
  return device;
}

/** 상행 메시지 1건을 device_state에 반영한다. 우리 것이 아니면 조용히 무시. */
async function handleMessage(topic, payload) {
  const parsed = parseTopic(topic);
  if (!parsed) return;

  const delta = parsePayload(parsed.suffix, payload);
  if (delta === null) return; // 전원과 무관한 텔레메트리(SENSOR 등)

  // STATUS5에만 실려 오는 축. 상태로 저장하지 않고 HTTP 우회용 주소록에만 넣고 끝낸다.
  // **여기서 return하지 않으면 안 된다**: STATUS5는 power를 항상 null로 실어 오는데,
  // 재동기화 때 진짜 전원 응답(RESULT)과 거의 동시에 도착하면 둘 다 applyState에서
  // 각자 current를 읽어 쓰는 읽기-수정-쓰기라 경쟁이 붙는다. STATUS5 쪽이 나중에 쓰면
  // 방금 켜진 조명이 순간적으로 '모름'으로 되돌아간다 — 5분마다 재현 가능했다.
  if (delta.ip) {
    rememberDeviceIp(parsed.address, delta.ip);
    return;
  }

  // 기기가 전원을 실제로 보고했다 = 기다리던 명령이 도착했다는 증거다.
  noteDeviceReport(parsed.address, delta.power);

  const device = await applyState(parsed.address, delta);
  if (device) console.log(`[state] ${device.name}(${parsed.address}) ← ${parsed.suffix}=${payload}`);
}

async function main() {
  if (!(await registry.reload())) {
    console.error("[agent] 기기 목록을 못 읽어 시작할 수 없습니다. 키와 네트워크를 확인하세요.");
    process.exit(1);
  }
  console.log(`[agent] 조명 기기 ${registry.addresses.length}대 로드`);

  // 명령을 받기 **전에** 읽어야 의미가 있다. 로컬 브로커가 죽은 채로 부팅하면 STATUS5를
  // 받을 길이 없어서, 마지막으로 알던 IP가 우회의 유일한 출발점이다.
  await loadDeviceIps();

  const mqttClient = connectMqtt(cfg, {
    onMessage: (topic, payload) =>
      handleMessage(topic, payload).catch((e) => console.error("[state] 반영 실패:", e)),
    // 접속(재접속 포함)할 때마다 현재 상태를 다시 물어본다 — 끊긴 동안의 변화를 메운다.
    onConnect: (client) => queryInitialState(client, registry.addresses),
  });

  // applyState를 넘기는 이유: HTTP 우회로 읽은 상태도 위의 한 길로만 저장되게 하기 위해서다.
  subscribeCommands(sb, { mqttClient, registry, applyState });

  // CCTV 상태 보고. 설정이 없으면 조용히 건너뛴다 — 영상은 이 프로세스를 지나가지 않고,
  // 여기서는 "살아 있나·녹화가 진짜 돌고 있나"만 관찰해 어드민에 알린다.
  startCameraReporter(sb, cfg);

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
