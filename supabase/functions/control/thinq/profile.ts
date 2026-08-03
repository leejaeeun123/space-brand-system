/**
 * ThinQ 프로파일 → capabilities/constraints 파생 — 단일 책임: 프로파일 파싱.
 *
 * Space(src/control/thinq/profile.py)의 이식. 하드코딩 금지 원칙(D3)의 핵심이다.
 * 원본 스펙의 실측 결론: 문서 예시와 실기기가 step·모드·풍량 **세 군데에서 달랐다**(ss-4er).
 * 실기기 프로파일이 유일한 진실원이고, 등록 시 1회 읽어 캐시한다.
 *
 * **'w'가 있는 속성만 쓰기 가능하다.** ['r']뿐인 속성(currentTemperature 등)을 제어하려
 * 들면 400이다 — 파서가 이걸 강제한다(쓰기 가능한 축만 capabilities에 넣는다).
 */

import type { DeviceConstraints, TempRange } from "../types.ts";

// 프로파일 property 경로 → 우리 capability 축.
const POWER = ["operation", "airConOperationMode"] as const;
const TEMP = ["temperature", "targetTemperature"] as const;
const MODE = ["airConJobMode", "currentJobMode"] as const;
const WIND = ["airFlow", "windStrength"] as const;

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Dict : null;
}

/** property.{resource}.{key} 리프를 꺼낸다. 없으면 null. */
function leaf(prop: Dict, resource: string, key: string): Dict | null {
  const node = asDict(prop[resource]);
  return node ? asDict(node[key]) : null;
}

/**
 * 리프가 쓰기 가능하면 그 쓰기 제약(value.w)을 돌려준다 — 아니면 null.
 *
 * ThinQ 리프는 {"type":..., "mode":[...], "value":{"r":..., "w":...}} 꼴이다.
 * 쓰기 가능 = value에 'w' 키가 있음. 그 값이 곧 우리가 캐시할 제약이다.
 */
function writableValue(l: Dict | null): unknown {
  if (!l) return null;
  const value = asDict(l.value);
  if (value && "w" in value) return value.w;
  return null;
}

/** 온도 단위. value.w에 unit이 있으면 그것, 없으면 temperature.unit, 없으면 'C'. */
function tempUnit(prop: Dict, tempWrite: Dict): string {
  if (typeof tempWrite.unit === "string") return tempWrite.unit;
  const node = asDict(prop.temperature);
  if (node) {
    if (typeof node.unit === "string") return node.unit;
    // unit이 리프({value:{r:"C"}})로 오는 프로파일도 있다.
    const unitLeaf = asDict(node.unit);
    const val = unitLeaf ? asDict(unitLeaf.value) : null;
    if (val && typeof val.r === "string") return val.r;
  }
  return "C";
}

/**
 * 프로파일 → [capabilities, constraints]. 쓰기 가능한 축만 반영한다.
 * capabilities 순서는 power → temp → mode → wind로 고정(응답 안정성).
 */
export function parseProfile(profile: unknown): [string[], DeviceConstraints] {
  // 루트가 객체가 아니면(예상 못 한 200 body) 아래 접근이 터져 등록이 500난다. 방어한다.
  const root = asDict(profile) ?? {};
  const prop = asDict(root.property) ?? {};

  const capabilities: string[] = [];
  const constraints: DeviceConstraints = { temp: null, modes: [], wind: [] };

  if (writableValue(leaf(prop, ...POWER)) !== null) capabilities.push("power");

  const tempW = asDict(writableValue(leaf(prop, ...TEMP)));
  if (tempW && "min" in tempW && "max" in tempW) {
    const min = Number(tempW.min);
    const max = Number(tempW.max);
    const step = Number(tempW.step ?? 1);
    // min/max/step이 숫자가 아니면 NaN — 온도 축만 건너뛴다(등록 전체를 실패시키지 않는다).
    if (Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(step)) {
      const temp: TempRange = { min, max, step: step || 1, unit: tempUnit(prop, tempW) };
      capabilities.push("temp");
      constraints.temp = temp;
    }
  }

  const modeW = writableValue(leaf(prop, ...MODE));
  if (Array.isArray(modeW) && modeW.length > 0) {
    capabilities.push("mode");
    constraints.modes = modeW.map(String);
  }

  const windW = writableValue(leaf(prop, ...WIND));
  if (Array.isArray(windW) && windW.length > 0) {
    capabilities.push("wind");
    constraints.wind = windW.map(String);
  }

  return [capabilities, constraints];
}
