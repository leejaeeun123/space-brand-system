/**
 * 명령 발행 — 단일 책임: 명령 1건을 검증해 어댑터로 보낸다.
 *
 * ThinQ는 HTTP 동기라 응답이 곧 결과다 → 한 호출에서 'acked'로 확정한다.
 * (MQTT였다면 발행 성공은 'sent'일 뿐이고 기기 반영은 비동기로 돌아온다.)
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as db from "../devices.ts";
import type { Command, Device } from "../types.ts";
import { ThinQAuthError, ThinQBadRequest } from "../thinq/client.ts";
import { buildControlBody, CommandValidationError } from "../thinq/commands.ts";
import { toDeviceState } from "../thinq/state.ts";
import { commandTopic } from "../tasmota/topics.ts";
import { HandlerError, thinqClient } from "./shared.ts";

/** 명령 → 그 명령이 요구하는 capability 축. capabilities에 없으면 기기가 못 하는 일이다. */
const AXIS: Record<Command, string> = {
  power_on: "power",
  power_off: "power",
  set_temp: "temp",
  set_mode: "mode",
  set_wind: "wind",
};

export async function command(sb: SupabaseClient, body: Record<string, unknown>) {
  const cmd = String(body.command ?? "") as Command;
  const device = await db.getDevice(sb, String(body.device_id ?? ""));
  if (!device) throw new HandlerError(404, "기기를 찾을 수 없습니다");

  const axis = AXIS[cmd];
  if (!axis) throw new HandlerError(400, `알 수 없는 명령입니다: ${cmd}`);
  if (!device.capabilities.includes(axis)) {
    throw new HandlerError(400, `'${device.name}'은 ${cmd} 명령을 지원하지 않습니다`);
  }
  if (device.adapter === "tasmota") return await sendTasmota(sb, device, cmd);

  const client = thinqClient();
  let controlBody: unknown;
  try {
    controlBody = buildControlBody(cmd, body.value, device.constraints);
  } catch (e) {
    if (e instanceof CommandValidationError) throw new HandlerError(400, e.message);
    throw e;
  }

  try {
    await client.control(device.address, controlBody);
  } catch (e) {
    if (e instanceof ThinQBadRequest) throw new HandlerError(400, "기기가 명령을 거부했습니다");
    // 401은 PAT 만료 — 재시도해도 소용없고, 사람이 갱신해야 한다.
    if (e instanceof ThinQAuthError) {
      throw new HandlerError(502, "ThinQ 인증 실패 — PAT 갱신이 필요합니다");
    }
    console.warn("thinq control 실패", device.id, e);
    throw new HandlerError(502, "기기 제어에 실패했습니다");
  }

  // 제어 직후 재조회해 캐시에 반영한다. 명령은 이미 성공했으므로 이 실패는 삼킨다 —
  // 상태 반영 실패가 성공한 명령을 실패로 보이게 하면 사용자가 같은 명령을 또 누른다.
  try {
    await db.upsertState(sb, toDeviceState(device.id, await client.getState(device.address), true));
  } catch { /* 무시 */ }

  return { device_id: device.id, command: cmd, status: "acked" };
}


/**
 * 조명 — 명령을 큐에 넣기만 한다. 합정 에이전트가 Realtime으로 받아 로컬 mosquitto에 발행한다.
 *
 * 그래서 응답은 'acked'가 아니라 **'sent'**다 — 아직 발행도 안 됐고, 나중에 발행되더라도
 * '기기가 실행했다'는 뜻은 아니다. 실제 반영은 기기가 stat 토픽으로 보고하고, 그걸
 * 에이전트가 device_state에 썼다. 이 차이를 흐리면 꺼진 줄 알았는데 켜져 있게 된다.
 *
 * ThinQ(HTTP 동기)가 한 호출에서 'acked'로 확정하는 것과 정반대다.
 */
async function sendTasmota(sb: SupabaseClient, device: Device, cmd: Command) {
  // 조명은 capabilities가 ['power']뿐이라 위의 검사가 이미 SET_*를 걸러냈다.
  const payload = cmd === "power_on" ? "ON" : "OFF";
  let topic: string;
  try {
    topic = commandTopic(device.address, "POWER");
  } catch (e) {
    // 등록 시 막았어야 할 값이 DB에 있다는 뜻 — 조용히 발행하지 않고 드러낸다.
    throw new HandlerError(500, `기기 주소가 올바르지 않습니다: ${e instanceof Error ? e.message : e}`);
  }
  const id = await db.enqueueCommand(sb, device.id, cmd, { topic, payload });
  return { device_id: device.id, command: cmd, status: "sent", command_id: id };
}
