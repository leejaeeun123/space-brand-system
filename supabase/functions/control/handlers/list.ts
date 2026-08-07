/**
 * 기기 목록 조회 — 단일 책임: 캐시를 읽고, ThinQ만 필요 시 갱신해서 준다.
 *
 * 조명(push)과 ThinQ(pull)의 비대칭이 여기 드러난다. 조명은 브릿지가 상태를 밀어넣지만
 * ThinQ는 우리가 물어봐야 안다. 매 조회마다 물으면 벤더 부하 + 레이턴시라 TTL을 둔다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as db from "../devices.ts";
import { isStale, neverSeen, type Device, type DeviceState } from "../types.ts";
import { ThinQClient, ThinQError } from "../thinq/client.ts";
import { toDeviceState } from "../thinq/state.ts";
import { thinqClient, thinqConfigured } from "./shared.ts";

/** 기본 신선도. 사람이 화면을 보고 있는 조회의 기준이다. */
const THINQ_TTL_SECONDS = 30;

function fresh(s: DeviceState, maxAgeSeconds: number): boolean {
  if (s.updated_at === null) return false;
  return (Date.now() - Date.parse(s.updated_at)) / 1000 < maxAgeSeconds;
}

/**
 * 낡았으면 ThinQ에 물어 갱신한다.
 *
 * 조회에 실패하면 마지막으로 알던 값은 남기되 online=false로 둔다 — '지금은 모른다'는
 * 단서를 남기는 것이지 꺼졌다고 단정하는 게 아니다. 캐시 자체는 건드리지 않는다.
 */
async function refreshThinq(
  sb: SupabaseClient,
  d: Device,
  cur: DeviceState,
  client: ThinQClient,
  maxAgeSeconds: number,
): Promise<DeviceState> {
  if (fresh(cur, maxAgeSeconds)) return cur;
  try {
    const next = toDeviceState(d.id, await client.getState(d.address), true);
    await db.upsertState(sb, next);
    return next;
  } catch (e) {
    if (!(e instanceof ThinQError)) throw e;
    return { ...cur, online: false };
  }
}

/**
 * `thinqMaxAgeSeconds` — 이 나이를 넘은 ThinQ 상태만 다시 물어본다.
 *
 * 자동화 틱은 보는 사람이 없어 기본값(30초)보다 느슨해도 된다 — 예약 없는 시간엔
 * 10분을 넘겨 ThinQ 호출을 1/10로 줄인다. 조명(Tasmota)은 MQTT로 상태가 밀려 올라와
 * 이 값과 무관하게 항상 최신이다.
 */
export async function list(sb: SupabaseClient, thinqMaxAgeSeconds = THINQ_TTL_SECONDS) {
  let pairs = await db.listDevices(sb);
  const configured = thinqConfigured();

  if (configured && pairs.some(([d]) => d.adapter === "thinq")) {
    const client = thinqClient();
    const out: Array<[Device, DeviceState]> = [];
    for (const [d, s] of pairs) {
      out.push([
        d,
        d.adapter === "thinq" ? await refreshThinq(sb, d, s, client, thinqMaxAgeSeconds) : s,
      ]);
    }
    pairs = out;
  }

  return {
    thinq_configured: configured,
    devices: pairs.map(([d, s]) => ({
      ...d,
      // is_stale/never_seen은 파생값이라 DB에 없다 — UI가 '모름'과 '끊김'을 구분하려면 필요하다.
      state: { ...s, is_stale: isStale(s), never_seen: neverSeen(s) },
    })),
  };
}
