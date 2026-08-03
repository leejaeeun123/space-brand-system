/**
 * Command → ThinQ 제어 본문 매핑 + constraints 검증 — 단일 책임: 명령 직렬화.
 *
 * Space(src/control/thinq/commands.py)의 이식. 여기서 범위/enum을 막으면 400 왕복이 없다.
 * constraints가 없으면(=프로파일 미파생) 값 검증을 할 수 없으므로 **거부한다** —
 * 잘못 보내면 400이거나, 더 나쁘게 조용히 무시되기 때문이다.
 */

import type { Command, DeviceConstraints, TempRange } from "../types.ts";

/** 명령/값이 기기 제약을 벗어남. 호출측이 400으로 변환한다(사용자 입력 탓). */
export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}

/**
 * 범위/step 밖 값을 보내면 ThinQ가 400을 주거나 — 더 나쁘게 — 조용히 무시한다.
 * 보내기 전에 우리가 막는다.
 */
function validateTarget(range: TempRange, value: number): number {
  if (!(range.min <= value && value <= range.max)) {
    throw new CommandValidationError(
      `목표온도는 ${range.min}~${range.max}${range.unit} 범위여야 합니다: ${value}`,
    );
  }
  if (range.step) {
    const offset = (value - range.min) / range.step;
    if (Math.abs(offset - Math.round(offset)) > 1e-9) {
      throw new CommandValidationError(
        `목표온도는 ${range.min}부터 ${range.step}${range.unit} 단위여야 합니다: ${value}`,
      );
    }
  }
  return value;
}

function requireTemp(value: unknown, constraints: DeviceConstraints | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommandValidationError("목표온도 값(숫자)이 필요합니다");
  }
  if (!constraints?.temp) {
    throw new CommandValidationError("이 기기의 온도 제약을 알 수 없어 설정할 수 없습니다");
  }
  return validateTarget(constraints.temp, value);
}

function requireEnum(value: unknown, allowed: string[], label: string): string {
  if (typeof value !== "string" || !value) {
    throw new CommandValidationError(`${label} 값(문자열)이 필요합니다`);
  }
  if (!allowed.length) {
    throw new CommandValidationError(`이 기기의 ${label} 제약을 알 수 없어 설정할 수 없습니다`);
  }
  if (!allowed.includes(value)) {
    throw new CommandValidationError(`${label}은 ${allowed.join(", ")} 중 하나여야 합니다: ${value}`);
  }
  return value;
}

/**
 * Command(+값)을 ThinQ /control 본문으로.
 *
 * SET_TEMP는 targetTemperature(rw)로 보낸다 — 원본이 실기기 프로파일에서 rw를 확인하고
 * 쓰기 왕복(18→반영→원복)까지 검증한 키다(ss-vcr, 2026-07-19).
 * heat/coolTargetTemperature(w 전용)도 실기기에 있으나 targetTemperature가 모드와 무관한
 * 대표 목표온도라 단일 키로 충분하다.
 */
export function buildControlBody(
  command: Command,
  value: unknown,
  constraints: DeviceConstraints | null,
): unknown {
  switch (command) {
    case "power_on":
      return { operation: { airConOperationMode: "POWER_ON" } };
    case "power_off":
      return { operation: { airConOperationMode: "POWER_OFF" } };
    case "set_temp":
      return { temperature: { targetTemperature: requireTemp(value, constraints) } };
    case "set_mode":
      return {
        airConJobMode: { currentJobMode: requireEnum(value, constraints?.modes ?? [], "모드") },
      };
    case "set_wind":
      return { airFlow: { windStrength: requireEnum(value, constraints?.wind ?? [], "풍량") } };
    default:
      throw new CommandValidationError(`ThinQ가 지원하지 않는 명령입니다: ${command}`);
  }
}
