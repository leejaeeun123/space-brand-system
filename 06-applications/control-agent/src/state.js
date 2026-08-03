/**
 * Tasmota 상행 메시지 파싱 — 단일 책임: 토픽·페이로드를 상태 델타로 바꾼다.
 *
 * Space(src/control/state_worker.py)의 parse_payload/apply_message를 옮긴 것이다.
 * 토픽 구조만 다르다: Space는 `stat/<space_id>/<device>/<suffix>`, 여기는 Tasmota 기본값인
 * `stat/<device>/<suffix>` (브로커가 전용이라 space 네임스페이스가 불필요 — topics.ts 주석 참조).
 */

export const UPSTREAM_PREFIXES = ["stat", "tele"];

/**
 * 상행 토픽 → {prefix, address, suffix}. 우리 문법이 아니면 null.
 *
 * null을 예외 대신 쓰는 이유: 브로커에 우리가 모르는 토픽이 흐를 수 있고,
 * 그건 오류가 아니라 '내 것이 아님'이므로 조용히 무시해야 한다.
 */
export function parseTopic(topic) {
  const parts = String(topic || "").split("/");
  if (parts.length < 3) return null;
  const [prefix, address, ...rest] = parts;
  if (!UPSTREAM_PREFIXES.includes(prefix)) return null;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(address)) return null;
  return { prefix, address, suffix: rest.join("/") };
}

/**
 * 서브토픽 + payload → {online, power} 델타. 우리가 쓰는 신호가 아니면 null.
 *
 * **이 메시지가 모르는 값은 null로 둔다** — 호출부가 현재값을 보존하게 하기 위해서다.
 * 예: LWT는 online만 안다. power를 null로 덮어쓰면 마지막 전원값이 사라진다.
 */
export function parsePayload(suffix, payload) {
  const p = String(payload ?? "").trim();
  const key = String(suffix || "").split("/")[0];

  if (key === "LWT") {
    if (p === "Online") return { online: true, power: null };
    if (p === "Offline") return { online: false, power: null };
    return null;
  }
  if (key === "POWER") {
    // stat/<device>/POWER → "ON" / "OFF"
    return p === "ON" || p === "OFF" ? { online: true, power: p } : null;
  }
  if (key === "RESULT" || key === "STATE") {
    let obj;
    try {
      obj = JSON.parse(p);
    } catch {
      return null;
    }
    const pw = obj && typeof obj === "object" ? obj.POWER : null;
    return pw === "ON" || pw === "OFF" ? { online: true, power: pw } : null;
    // SENSOR 등 전원이 아닌 텔레메트리는 여기서 걸러져 무시된다.
  }
  return null;
}

/**
 * 델타를 현재 상태에 병합한다. 델타가 모르는 축은 기존값을 유지한다.
 * 이걸 안 하면 LWT 하나가 마지막 전원값을 지워버린다.
 */
export function mergeState(current, delta) {
  return {
    online: delta.online !== null ? delta.online : (current?.online ?? false),
    power: delta.power !== null ? delta.power : (current?.power ?? null),
  };
}
