/**
 * 연결 상태 감시 — 단일 책임: 조명·냉난방·CCTV의 연결 끊김/복구를 감지해 장부에 남긴다.
 *
 * 조명(Tasmota)은 MQTT LWT로 끊김을 즉시 알지만, 그게 `device_state.online`에 반영될 뿐
 * 아무도 그걸 채널로 옮기지 않았다. CCTV(MediaMTX)도 `camera_state.online`/`is_stale`이
 * 이미 쌓이고 있었지만 UI 표시용일 뿐이었다. 이 파일은 새로 관찰하지 않는다 — 이미 있는
 * 상태 캐시를 매 `automate` 틱마다 읽어 "끊겼다/복구됐다"는 **전환**만 장부에 남긴다.
 *
 * **전환**을 판단하는 이유(집합이 아니라): 끊김→복구→끊김이 짧은 창 안에서 반복되면(플래핑),
 * "최근에 이미 알렸나"를 집합으로만 물으면 두 kind 모두에 걸려 두 번째 끊김을 놓친다.
 * 대상별 **가장 최근 이벤트 하나**의 kind를 봐야 지금이 새 끊김인지 이어지는 중인지 안다
 * (`events.fetchLatestByTarget`).
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Camera, CameraState } from "../cameras.ts";
import { CAMERA_STALE_AFTER_SECONDS, isStale as cameraIsStale, neverSeen as cameraNeverSeen } from "../cameras.ts";
import { STALE_AFTER_SECONDS } from "../types.ts";
import { countRecentByTarget, type EventInput, type EventKind, fetchLatestByTarget, type LatestEvent, recordMany } from "./events.ts";

/** 관측 대상 하나 — devices.ts가 아니라 여기서 구조적 타입으로 받는다(순환 import 회피). */
export interface WatchedDevice {
  id: string;
  state: { online: boolean; is_stale: boolean; never_seen: boolean };
}

/**
 * 같은 끊김이 이어지는 동안 재알림하는 간격.
 *
 * "불안정하면 즉시"는 이 값이 아니라 **전환 판단**(`decideTransition`)이 지킨다 — 새 끊김은
 * 장부 상태와 무관하게 항상 즉시 알린다. 이 값은 오직 "같은 끊김이 계속될 때 얼마나 자주
 * 되풀이해 알릴까"만 정하므로, `enforce.ts`의 유휴 경보(`IDLE_ALERT_QUIET_MINUTES`)와 같은
 * 60분을 쓴다 — PAT 만료처럼 며칠 이어지는 끊김에서 15분은 주말 동안 250건, 60분은 60건이다.
 */
const REPEAT_MINUTES = 60;

/** "최근"을 얼마나 뒤져볼지. 자동화가 몇 시간 죽어 있던 것까지 감안한 여유값. */
const LOOKBACK_HOURS = 24;

/**
 * 플래핑 상한 — 한 대상이 이 창 안에 이미 이만큼 끊겼으면 새 끊김을 더 알리지 않는다.
 *
 * 끊김↔복구 반복(플래핑)은 사이클마다 알림 2건(끊김+복구)을 내 무한정 쌓인다. ThinQ는 폴링
 * 1회 실패로도 down이 되고(list.ts), 조명은 재연결 지연 이력이 있는 환경이라(공유기 신규 TCP
 * 블랙홀, 2026-08-09 판별) 이 반복이 실제로 일어난다. 진짜 장기 장애는 전환이 드물어(첫 끊김 +
 * REPEAT마다 1건) 이 수에 닿지 않으므로, 상한은 플래핑만 자른다 — **첫 끊김은 언제나 즉시**
 * 알린다. 60분 창은 REPEAT_MINUTES와 같은 값이라, 장기 장애의 60분 재알림은 창 안에서 항상
 * 1건 이하로 유지돼 상한을 건드리지 않는다.
 */
const FLAP_WINDOW_MINUTES = 60;
const FLAP_CAP = 4;

/**
 * 지금 상태(down)와 장부의 마지막 판정(latest)을 대조해 이번 틱에 무엇을 적을지 정한다.
 *
 * 순수 함수로 뺀 이유: 이 분기가 플래핑을 올바르게 다루는지가 이 기능 전체의 정확성이고,
 * DB 없이 검증되어야 한다(`connectivity.test.ts`).
 */
export function decideTransition(
  down: boolean,
  latest: LatestEvent | undefined,
  recentOfflineCount: number,
  offlineKind: EventKind,
  recoveredKind: EventKind,
  now: Date,
): "offline" | "recovered" | "none" {
  if (down) {
    // 처음 끊긴 것이거나(장부에 없음), 직전이 복구였다 = 이번이 새 끊김이다 → 즉시.
    if (!latest || latest.kind === recoveredKind) {
      // 단, 지난 FLAP_WINDOW 동안 이 대상이 이미 상한만큼 끊겼으면 플래핑이므로 이번 사이클은
      // 조용히 넘긴다(none). 그러면 장부의 마지막 판정이 '복구'로 남아 REPEAT 경로도 안 돌아
      // 조용해진다. 트레이드오프: 플래핑이 상한에 걸린 뒤 진짜 장기 장애로 굳으면, 옛 끊김이
      // 창에서 빠질 때까지(최대 FLAP_WINDOW) 재알림이 늦는다 — 첫 끊김 즉시성을 지키는 대가다.
      return recentOfflineCount >= FLAP_CAP ? "none" : "offline";
    }
    // 끊김이 이어지는 중 — backoff 창이 지났을 때만 다시 알린다.
    const ageMinutes = (now.getTime() - Date.parse(latest.at)) / 60_000;
    return ageMinutes >= REPEAT_MINUTES ? "offline" : "none";
  }
  // 지금은 정상 — 직전이 끊김이었을 때만 복구를 알린다. 원래 정상이었거나 이미 복구를
  // 알린 상태면 할 말이 없다.
  return latest?.kind === offlineKind ? "recovered" : "none";
}

/** 조명·냉난방 원인 문구. ThinQ는 `list.ts`가 넘겨준 원인이 있으면 그걸 우선한다. */
function deviceCause(state: WatchedDevice["state"], thinqError: string | undefined): string {
  if (thinqError) return thinqError;
  if (!state.online) return "오프라인으로 보고됨(연결 끊김 신호 수신)";
  if (state.is_stale) return `상태 갱신이 ${STALE_AFTER_SECONDS}초 이상 끊겼습니다`;
  return "연결 상태를 확인할 수 없습니다";
}

function cameraCause(state: CameraState): string {
  if (!state.online) return "MediaMTX 스트림이 연결되어 있지 않습니다";
  if (cameraIsStale(state)) return `상태 보고가 ${CAMERA_STALE_AFTER_SECONDS}초 이상 끊겼습니다(에이전트·네트워크 확인)`;
  return "연결 상태를 확인할 수 없습니다";
}

export interface ConnectivityResult {
  deviceAlerts: number;
  cameraAlerts: number;
}

/**
 * 매 틱 호출. **never_seen은 게이트에서 먼저 뺀다** — 한 번도 보고를 못 받은 기기(등록만 됨)는
 * '끊김'이 아니라 '모름'이고, 여기 섞으면 최초 등록 직후부터 경보가 뜬다.
 */
export async function checkConnectivity(
  sb: SupabaseClient,
  devices: WatchedDevice[],
  cameraPairs: Array<[Camera, CameraState]>,
  thinqErrors: Map<string, string>,
  now: Date,
): Promise<ConnectivityResult> {
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000);
  const flapSince = new Date(now.getTime() - FLAP_WINDOW_MINUTES * 60_000);
  const [deviceLatest, cameraLatest, deviceFlaps, cameraFlaps] = await Promise.all([
    fetchLatestByTarget(sb, ["device_offline", "device_recovered"], "device_id", since),
    fetchLatestByTarget(sb, ["camera_offline", "camera_recovered"], "camera_id", since),
    countRecentByTarget(sb, "device_offline", "device_id", flapSince),
    countRecentByTarget(sb, "camera_offline", "camera_id", flapSince),
  ]);

  const events: EventInput[] = [];

  for (const d of devices) {
    if (d.state.never_seen) continue;
    const down = !d.state.online || d.state.is_stale;
    const decision = decideTransition(down, deviceLatest.get(d.id), deviceFlaps.get(d.id) ?? 0, "device_offline", "device_recovered", now);
    if (decision === "offline") {
      events.push({
        device_id: d.id,
        camera_id: null,
        kind: "device_offline",
        action: "connectivity",
        status: "ok",
        value: deviceCause(d.state, thinqErrors.get(d.id)),
      });
    } else if (decision === "recovered") {
      events.push({
        device_id: d.id,
        camera_id: null,
        kind: "device_recovered",
        action: "connectivity",
        status: "ok",
        value: "복구됨",
      });
    }
  }

  for (const [cam, state] of cameraPairs) {
    if (cameraNeverSeen(state)) continue;
    const down = !state.online || cameraIsStale(state);
    const decision = decideTransition(down, cameraLatest.get(cam.id), cameraFlaps.get(cam.id) ?? 0, "camera_offline", "camera_recovered", now);
    if (decision === "offline") {
      events.push({
        device_id: null,
        camera_id: cam.id,
        kind: "camera_offline",
        action: "connectivity",
        status: "ok",
        value: cameraCause(state),
      });
    } else if (decision === "recovered") {
      events.push({
        device_id: null,
        camera_id: cam.id,
        kind: "camera_recovered",
        action: "connectivity",
        status: "ok",
        value: "복구됨",
      });
    }
  }

  if (events.length) await recordMany(sb, events);

  return {
    deviceAlerts: events.filter((e) => e.kind === "device_offline" || e.kind === "device_recovered").length,
    cameraAlerts: events.filter((e) => e.kind === "camera_offline" || e.kind === "camera_recovered").length,
  };
}
