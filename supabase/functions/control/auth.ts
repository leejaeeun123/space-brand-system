/**
 * 역할 판정과 손님 권한 — 이 함수의 유일한 인증 정책.
 *
 * 손님 경로는 비밀번호가 없다 — 이 페이지가 지키던 현관 비밀번호는 어차피 사이트 루트
 * (`guest-guide.html`)에 평문으로 공개돼 있어 별도 장벽이 아니었다. 대신 손님(비밀번호
 * 미제출)이 부를 수 있는 action·command는 서버가 여전히 자른다 — 기기 목록 조회와
 * 조명·냉난방 조작만 할 수 있다. 기기 등록·해제와 CCTV는 못 부른다.
 *
 * admin 비밀번호는 이 함수만 여는 열쇠가 아니라 `reservations`의 `admin_*` RPC
 * (예약자 이름·연락처·전화번호 전체)까지 여는 열쇠다 — `admin.html`이 같은 값을 양쪽에
 * 쓴다. 그래서 admin만 비밀번호로 판정한다. `password`를 아예 안 보낸 요청만 guest —
 * **뭔가 보냈는데 admin과 안 맞으면 여전히 401이다.** 여기서 guest로 조용히 낮추면
 * admin.html의 오타가 "비밀번호가 맞지 않아요"가 아니라 알 수 없는 403으로 보인다.
 *
 * 이 판정이 **서버에 있어야 하는 이유**도 같다 — `guest-control.html`도 소스가 그대로
 * 공개되므로, 클라이언트에서 버튼을 감추는 것은 아무것도 막지 못한다.
 * 누구나 `fetch`로 `delete`·`camera_credentials`를 직접 부를 수 있다.
 */

import { HandlerError } from "./handlers/shared.ts";

export type Role = "admin" | "guest";

/** 손님이 부를 수 있는 action. 등록·해제·CCTV는 여기 없다.
 *
 *  `automate`는 pg_cron이 1분마다 찌르는 예약 자동화 트리거다(handlers/automation.ts).
 *  대상 예약을 호출자가 고르지 못하고 서버가 지금 시각으로 직접 계산하므로, 아무나 불러도
 *  '엉뚱한 예약을 실행시키는' 일은 없다. 그래서 pg_cron이 anon key만으로 부를 수 있게 둔다.
 *
 *  ⚠️ **다만 이 action은 guest가 `command`로는 못 하는 일도 한다** — 외부 웹훅 발송,
 *  `device_events`·`device_watch` 쓰기, 무조건적인 `list()` 호출. anon key는 소스에 공개돼
 *  있으므로 누구나 반복 호출할 수 있다. 실제 피해는 두 가지가 막는다:
 *    · ThinQ는 상태 TTL이 있어 호출을 늘려도 벤더 왕복이 비례해 늘지 않는다.
 *    · 알림은 보내기 전에 선점하므로(`events.claimPending`) 동시 호출해도 한 번만 간다.
 *  더 조이려면 이 목록에서 빼고 pg_cron에 전용 토큰을 심어야 하는데, 그러면 시크릿을
 *  마이그레이션 밖(Vault)에 둬야 한다 — 지금은 위 두 방어로 충분하다고 봤다
 *  (형운 결정, 2026-08-07). */
const GUEST_ACTIONS = new Set(["list", "command", "automate"]);

/**
 * 손님이 보낼 수 있는 명령. 지금은 냉난방 제어 다섯 가지가 전부 열려 있다 —
 * 손님은 이미 물리 리모컨으로 온도·모드·풍량을 다 바꿀 수 있어서, 여기서 막아도
 * 새로 막히는 게 없고 페이지만 반쪽짜리가 된다.
 *
 * 값은 `thinq/commands.ts`가 **기기 프로파일에 대고** 검증한다 — 온도는 min/max/step,
 * 모드·풍량은 프로파일이 준 enum 목록. 임의의 값을 받아주는 게 아니다.
 *
 * **그래도 목록은 목록으로 남겨둔다.** `command` action 전체를 열어버리면 다음에
 * 명령이 하나 추가될 때(기기 초기화 같은 것) 아무도 안 본 채 손님에게까지 열린다.
 * 여기에 적는 행이 그 결정을 한 번 거치게 하는 장치다.
 *
 * 손님에게 여전히 닫혀 있는 것은 명령이 아니라 **action**이다 — 기기 등록·해제와 CCTV.
 * 그쪽은 기기를 잡는 게 아니라 구성과 영상을 잡는 일이라 등급이 다르다.
 */
const GUEST_COMMANDS = new Set(["power_on", "power_off", "set_temp", "set_mode", "set_wind"]);

/**
 * 비밀번호 → 역할. admin과 맞으면 `admin`, 아예 안 보냈으면 `guest`,
 * 뭔가 보냈는데 admin과 안 맞으면 `null`(=401).
 *
 * `ADMIN_PASSWORD` 미설정은 예전과 같이 **전면 거부**다(503). 무인증 제어로 열리는 것보다
 * 닫혀 있는 게 낫다.
 */
export function resolveRole(supplied: string): Role | null {
  const admin = Deno.env.get("ADMIN_PASSWORD");
  if (!admin) {
    console.error("ADMIN_PASSWORD 미설정 — 모든 요청을 거부합니다");
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }
  if (supplied === admin) return "admin";
  if (supplied === "") return "guest";
  return null;
}

/** 손님이 허용 범위를 벗어난 요청을 보내면 403. admin은 그대로 통과한다. */
export function assertAllowed(role: Role, action: string, body: Record<string, unknown>): void {
  if (role !== "guest") return;

  const denied = new HandlerError(403, "이 페이지에서는 조명·냉난방 조작만 할 수 있어요");
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
