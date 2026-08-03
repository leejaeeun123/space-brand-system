/**
 * ThinQ state JSON → DeviceState 매핑 — 단일 책임: 상태 파싱.
 *
 * Space(src/control/thinq/state.py)의 이식.
 *
 * `online`의 의미가 조명과 다르다: ThinQ엔 LWT가 없어 online = '마지막 state 조회 성공 여부'다.
 * 조회에 성공해 이 파서에 닿았다면 online=true가 기본이다.
 *
 * power=null('모름')을 절대 'OFF'로 합치지 않는다 — 냉난방 무한 가동이 조용히 숨는다.
 * operation 값이 없거나 낯설면 null로 남긴다.
 */

import type { DeviceState } from "../types.ts";

// ThinQ operation.airConOperationMode → 우리 power. 그 외/부재는 null('모름').
const POWER_MAP: Record<string, "ON" | "OFF"> = {
  POWER_ON: "ON",
  POWER_OFF: "OFF",
};

type Dict = Record<string, unknown>;

function get(payload: Dict, resource: string, key: string): unknown {
  const node = payload[resource];
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    return (node as Dict)[key];
  }
  return undefined;
}

/** null/undefined가 아닌 값만 담는다 — 없는 필드를 굳이 키로 남기지 않는다. */
function put(attrs: Dict, key: string, value: unknown): void {
  if (value !== null && value !== undefined) attrs[key] = value;
}

export function toDeviceState(
  deviceId: string,
  payload: unknown,
  online = true,
  updatedAt?: Date,
): DeviceState {
  // 루트가 객체가 아니면(예상 못 한 응답) 한 기기의 이상 응답이 화면 전체를 깨뜨린다. 방어한다.
  const p: Dict = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Dict
    : {};

  const rawPower = get(p, "operation", "airConOperationMode");
  const power = typeof rawPower === "string" ? (POWER_MAP[rawPower] ?? null) : null;

  const attrs: Dict = {};
  put(attrs, "mode", get(p, "airConJobMode", "currentJobMode"));
  put(attrs, "target_temp", get(p, "temperature", "targetTemperature"));
  put(attrs, "current_temp", get(p, "temperature", "currentTemperature"));
  put(attrs, "unit", get(p, "temperature", "unit"));
  put(attrs, "wind", get(p, "airFlow", "windStrength"));

  return {
    device_id: deviceId,
    online,
    power,
    attrs,
    reported_at: null, // ThinQ state엔 기기 보고 시각이 없다 — 캐시 기록 시각만 안다.
    updated_at: (updatedAt ?? new Date()).toISOString(),
  };
}
