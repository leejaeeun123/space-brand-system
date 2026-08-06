/**
 * 역할 판정과 손님 권한 — 이 함수의 유일한 인증 정책.
 *
 * **비밀번호를 하나로 두면 안 되는 이유가 있다.** admin 비밀번호는 이 함수만 여는 열쇠가
 * 아니라 `reservations`의 `admin_*` RPC(예약자 이름·연락처·전화번호 전체)까지 여는 열쇠다 —
 * `admin.html`이 같은 값을 양쪽에 쓴다. 그 값이 손님용 공개 페이지에 들어가는 순간, 소스를
 * 본 사람이 anon 키만으로 예약자 개인정보를 통째로 조회할 수 있다. 조명이 꺼지는 것과는
 * 등급이 다른 사고다.
 *
 * 그래서 손님 페이지는 **별도 비밀번호(`GUEST_PASSWORD`)**를 쓰고, 그 역할로는 목록 조회와
 * 켜기/끄기·온도 조절만 할 수 있다. 이 판정이 **서버에 있어야 하는 이유**도 같다 — `guest-control.html`도
 * 소스가 그대로 공개되므로, 클라이언트에서 버튼을 감추는 것은 아무것도 막지 못한다.
 * 누구나 `fetch`로 `delete`·`camera_credentials`를 직접 부를 수 있다.
 */

import { HandlerError } from "./handlers/shared.ts";

export type Role = "admin" | "guest";

/** 손님이 부를 수 있는 action. 등록·해제·CCTV는 여기 없다. */
const GUEST_ACTIONS = new Set(["list", "command"]);

/**
 * 손님이 보낼 수 있는 명령. `command` action만 열어서는 부족하다 —
 * 같은 action이 `set_mode`·`set_wind`도 태우기 때문이다.
 *
 * **`set_temp`를 여는 것은 의도적이다.** 손님은 이미 물리 리모컨으로 같은 일을 할 수
 * 있어서 여기서 막아도 새로 막히는 게 없고, 값은 `thinq/commands.ts`가 **기기 프로파일의
 * min/max/step에 대고** 검증한다 — 임의의 숫자를 받아주는 게 아니다.
 *
 * 반면 `set_mode`·`set_wind`는 닫은 채로 둔다. 손님 화면이 안 쓰는 축이기도 하지만,
 * 난방 중인 기기를 냉방으로 되돌리는 것처럼 **다음 손님까지 남는 상태**를 만들기 때문이다.
 * 온도는 그에 비해 되돌리기 쉽고, 범위를 벗어나는 값은 서버가 이미 자른다.
 */
const GUEST_COMMANDS = new Set(["power_on", "power_off", "set_temp"]);

/**
 * 비밀번호 → 역할. 어느 것과도 맞지 않으면 `null`(=401).
 *
 * `ADMIN_PASSWORD` 미설정은 예전과 같이 **전면 거부**다(503). 무인증 제어로 열리는 것보다
 * 닫혀 있는 게 낫다. 반대로 `GUEST_PASSWORD` 미설정은 손님 경로만 닫는다 — 손님 페이지를
 * 아직 안 켠 상태일 뿐이고, 그것 때문에 어드민까지 멈추면 안 된다.
 */
export function resolveRole(supplied: string): Role | null {
  const admin = Deno.env.get("ADMIN_PASSWORD");
  if (!admin) {
    console.error("ADMIN_PASSWORD 미설정 — 모든 요청을 거부합니다");
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }
  if (supplied === admin) return "admin";

  const guest = Deno.env.get("GUEST_PASSWORD");
  if (!guest) return null;

  // 둘이 같은 값이면 손님 페이지가 admin 비밀번호를 들고 있다는 뜻이다 = 예약 개인정보가
  // 공개된 것과 같다. 설정 실수를 조용히 통과시키지 않고 손님 경로를 닫는다.
  if (guest === admin) {
    console.error("GUEST_PASSWORD가 ADMIN_PASSWORD와 같습니다 — 손님 경로를 닫습니다");
    return null;
  }
  if (supplied === guest) return "guest";
  return null;
}

/** 손님이 허용 범위를 벗어난 요청을 보내면 403. admin은 그대로 통과한다. */
export function assertAllowed(role: Role, action: string, body: Record<string, unknown>): void {
  if (role !== "guest") return;

  const denied = new HandlerError(403, "이 페이지에서는 켜기/끄기와 온도 조절만 할 수 있어요");
  if (!GUEST_ACTIONS.has(action)) throw denied;
  if (action === "command" && !GUEST_COMMANDS.has(String(body.command ?? ""))) throw denied;
}

/**
 * 손님에게는 기기 실체(`address`)를 내리지 않는다.
 *
 * ThinQ deviceId는 PAT 없이는 쓸 수 없고 Tasmota 토픽은 LAN 밖에서 쓸 수 없어 그 자체로
 * 위험하진 않다. 다만 손님 화면이 쓰지 않는 값이고, 안 내리면 안 새는 값이다.
 */
export function scrubDevices<T extends { devices?: unknown }>(role: Role, payload: T): T {
  if (role !== "guest" || !Array.isArray(payload.devices)) return payload;
  return {
    ...payload,
    devices: payload.devices.map((d) => {
      const { address: _address, ...rest } = d as Record<string, unknown>;
      return rest;
    }),
  };
}
