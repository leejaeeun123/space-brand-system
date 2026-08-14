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
 * Tasmota JSON 본문에서 전원값만 뽑는다. 없으면 null('모름').
 *
 * `{"POWER":"ON"}`(RESULT·HTTP /cm 응답), `{"POWER1":"ON"}`(다채널),
 * `{"StatusSTS":{"POWER":"ON"}}`(Status 0) 세 모양이 전부 여기로 들어온다.
 * **한 군데로 모은 이유**: '모르면 null, 절대 OFF 아님' 규칙을 여러 벌 만들면
 * 언젠가 한 벌이 어긋나고, 그 순간 켜진 조명이 꺼진 걸로 보고된다.
 */
export function extractPower(obj) {
  if (!obj || typeof obj !== "object") return null;
  const sts = obj.StatusSTS && typeof obj.StatusSTS === "object" ? obj.StatusSTS : obj;
  const pw = sts.POWER ?? sts.POWER1;
  return pw === "ON" || pw === "OFF" ? pw : null;
}

/**
 * 서브토픽 + payload → {online, power} 델타. 우리가 쓰는 신호가 아니면 null.
 *
 * **이 메시지가 모르는 값은 null로 둔다** — 호출부가 현재값을 보존하게 하기 위해서다.
 * 예: LWT는 online만 안다. power를 null로 덮어쓰면 마지막 전원값이 사라진다.
 *
 * STATUS5는 전원과 무관한 응답이지만(네트워크 정보) 예외적으로 인식한다 — `ip` 축을 실어
 * 보내기 위해서다. mergeState는 online·power만 보므로 ip는 상태 저장에 섞이지 않는다.
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
    const pw = extractPower(obj);
    return pw !== null ? { online: true, power: pw } : null;
    // SENSOR 등 전원이 아닌 텔레메트리는 여기서 걸러져 무시된다.
  }
  if (key === "STATUS5") {
    // `cmnd/<addr>/Status 5` 의 응답. 기기 LAN IP를 여기서만 알 수 있다 —
    // DHCP라 IP가 미리 정해져 있지 않고, 스캔은 ESP8266이 동시 요청에 약해 못 쓴다.
    let obj;
    try {
      obj = JSON.parse(p);
    } catch {
      return null;
    }
    const ip = obj?.StatusNET?.IPAddress;
    if (typeof ip !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
    // power를 모르는 응답이라 null이다. 이걸 'OFF'로 바꾸면 안 된다.
    return { online: true, power: null, ip };
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
