/**
 * 제어 도메인 타입 — Space(src/models.py)의 Pydantic 모델을 TS로 옮긴 것.
 *
 * 원본과 다른 점: account_id/space_id 없음(단일 공간), CommandStatus에서 pending/timeout 제거.
 * 원본도 그 둘을 세팅하는 코드가 없었다(PROGRESS.md GAP-4) — 안 쓰는 상태를 옮겨오지 않는다.
 */

export type DeviceKind = "light" | "hvac";
export type AdapterName = "tasmota" | "thinq";

export type Command =
  | "power_on"
  | "power_off"
  | "set_temp" // hvac 전용
  | "set_mode" // hvac 전용
  | "set_wind"; // hvac 전용

/** sent = 벤더/브로커가 받음(기기 실행은 미확인) · acked = 기기 반영 확인 */
export type CommandStatus = "sent" | "acked";

/** 목표온도가 받을 수 있는 범위. ThinQ 프로파일의 targetTemperature.value.w에서 파생. */
export interface TempRange {
  min: number;
  max: number;
  step: number;
  unit: string;
}

/**
 * 기기가 받아들이는 값의 경계. UI 렌더의 근거이기도 하다.
 * null/빈 배열 = 그 축을 쓰기 못함.
 */
export interface DeviceConstraints {
  temp?: TempRange | null;
  modes?: string[];
  wind?: string[];
}

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  adapter: AdapterName;
  address: string;
  capabilities: string[];
  constraints: DeviceConstraints | null;
}

/**
 * 마지막 알려진 상태.
 *
 * power=null은 '모름'이며 'OFF'와 다르다. 둘을 합치면 꺼진 줄 알았는데 실제로는 켜져 있는
 * 상황(= 냉난방 무한 가동)이 조용히 숨는다 — UI가 반드시 구분해 표시한다.
 */
export interface DeviceState {
  device_id: string;
  online: boolean;
  power: "ON" | "OFF" | null;
  attrs: Record<string, unknown>;
  reported_at: string | null;
  /** null = 이 기기로부터 한 번도 상태를 받은 적 없음(등록만 됨). */
  updated_at: string | null;
}

/** 갱신이 끊긴 지 이 시간을 넘으면 캐시를 믿지 말라는 신호(원본 STALE_AFTER_SECONDS). */
export const STALE_AFTER_SECONDS = 600;

/**
 * 수신 이력이 없으면 stale이 아니라 '모름'이다 — 둘을 섞으면 한 번도 못 들은 기기가
 * '갱신 끊김'으로 보여 마치 예전엔 정상이었던 것처럼 읽힌다.
 */
export function isStale(state: DeviceState): boolean {
  if (state.updated_at === null) return false;
  const age = (Date.now() - Date.parse(state.updated_at)) / 1000;
  return age > STALE_AFTER_SECONDS;
}

export function neverSeen(state: DeviceState): boolean {
  return state.updated_at === null;
}
