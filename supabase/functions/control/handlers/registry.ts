/**
 * 기기 등록/해제 — 단일 책임: 인벤토리 변경.
 *
 * capabilities/constraints는 **프로파일에서 파생한다** — 클라이언트가 준 값을 쓰지 않는다.
 * 원본 스펙의 실측 결론이 근거다: 문서 예시와 실기기가 step·모드·풍량 세 군데에서 달랐다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as db from "../devices.ts";
import { parseProfile } from "../thinq/profile.ts";
import { validateDeviceId } from "../tasmota/topics.ts";
import { HandlerError, thinqClient } from "./shared.ts";

// address는 URL 경로(/devices/{id}/...)에 그대로 박히므로 '/'·'..'·공백을 등록에서 막는다.
// 실기기는 64자 hex지만 관대하게 영숫자·_·-만 허용한다.
const THINQ_ADDRESS_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * LG 계정에 등록된 ThinQ 기기 목록 — 등록 도우미.
 * deviceId는 사람이 알아볼 수 없는 값이라, 별칭과 함께 보여줘 고르게 한다.
 */
export async function thinqDevices() {
  const raw = await thinqClient().getDevices();
  return {
    devices: raw.map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const info = (o.deviceInfo ?? {}) as Record<string, unknown>;
      return {
        device_id: o.deviceId ?? null,
        alias: info.alias ?? null,
        type: info.deviceType ?? null,
        model: info.modelName ?? null,
      };
    }),
  };
}

export async function registerThinq(sb: SupabaseClient, body: Record<string, unknown>) {
  const address = String(body.address ?? "").trim();
  const name = String(body.name ?? "").trim();
  if (!name) throw new HandlerError(400, "이름이 필요합니다");
  if (!THINQ_ADDRESS_RE.test(address)) {
    throw new HandlerError(400, "ThinQ deviceId 형식이 올바르지 않습니다");
  }

  let capabilities: string[];
  let constraints;
  try {
    [capabilities, constraints] = parseProfile(await thinqClient().getProfile(address));
  } catch (e) {
    if (e instanceof HandlerError) throw e;
    // 벤더 원문을 클라이언트에 노출하지 않는다 — 서버 로그에만 남긴다.
    console.warn("thinq getProfile 실패", address, e);
    throw new HandlerError(502, "기기 프로파일을 불러오지 못했습니다");
  }

  if (!capabilities.length) {
    throw new HandlerError(400, "이 기기에서 제어 가능한 항목을 찾지 못했습니다");
  }

  const device = await db.createDevice(sb, {
    name,
    kind: "hvac",
    adapter: "thinq",
    address,
    capabilities,
    constraints,
  });
  return { device };
}

/** 매핑 해제. 기기 자체는 그대로다 — 우리 인벤토리에서만 빠진다. */
export async function remove(sb: SupabaseClient, body: Record<string, unknown>) {
  const id = String(body.device_id ?? "");
  if (!await db.getDevice(sb, id)) throw new HandlerError(404, "기기를 찾을 수 없습니다");
  await db.deleteDevice(sb, id);
  return { ok: true };
}


/**
 * 조명(Tasmota) 등록.
 *
 * ThinQ와 달리 프로파일을 읽지 않는다 — 읽을 곳이 없다. Tasmota 스위치는 on/off가 전부라
 * capabilities는 항상 ['power']이고 값 제약도 없다(constraints=null).
 *
 * address = Tasmota의 `Topic` 설정값이다. 등록 시점에 문법을 검증하는 게 가장 싸다 —
 * 와일드카드가 DB에 들어가면 나중에 조명 전체가 한꺼번에 켜지는 식으로 터진다.
 */
export async function registerLight(sb: SupabaseClient, body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  if (!name) throw new HandlerError(400, "이름이 필요합니다");
  let address: string;
  try {
    address = validateDeviceId(String(body.address ?? ""));
  } catch (e) {
    throw new HandlerError(400, e instanceof Error ? e.message : "기기 ID가 올바르지 않습니다");
  }

  const device = await db.createDevice(sb, {
    name,
    kind: "light",
    adapter: "tasmota",
    address,
    capabilities: ["power"],
    constraints: null,
  });
  return { device };
}
