/**
 * 역할 판정과 손님 권한 — 이 함수의 유일한 인증 정책.
 *
 * 손님 경로는 비밀번호가 없다. 게이트를 뗀 근거(2026-08-04)는 "현관 비밀번호가 어차피 사이트
 * 루트에 평문 공개라 장벽이 아니었다"였는데, **그 전제는 2026-08-17에 사라졌다** — 이제 그 값도
 * 예약 시간에만 서버가 내려준다(`handlers/guide.ts`). 그래도 결론은 바뀌지 않는다: 손님을 가르는
 * 것은 비밀번호가 아니라 **예약 시간 창**이고(`reservation-window.ts`), 비밀번호를 되살리면
 * 손님에게 외울 것을 하나 더 주면서 서버 판정은 그대로 남는다.
 *
 * 손님(비밀번호 미제출)이 부를 수 있는 action·command는 서버가 여전히 자른다 — 기기 목록 조회와
 * 조명·냉난방 조작, 그리고 이용 안내 값(`guide`)만이다. 기기 등록·해제와 CCTV는 못 부른다.
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
 *
 * 세 번째 경로가 `cleaner`다 — 현장에 붙은 QR을 찍은 청소 담당자. **비밀번호가 아니라
 * 별도 시크릿(`CLEANING_TOKEN`)으로 판정한다.** admin 비밀번호를 QR에 넣으면 인쇄물 한 장이
 * 예약자 이름·연락처를 여는 열쇠가 되고, 그 인쇄물은 사진으로 찍히고 스캐너 앱 기록에 남는다.
 * 자격증명을 `password`에 겸용하지 않는 이유는 또 있다 — 그러면 "뭔가 보냈는데 admin과 안
 * 맞으면 401"이라는 위 규칙이 흐려진다.
 */

import { HandlerError } from "./handlers/shared.ts";
import { constantTimeEqual } from "../_shared/secret.ts";

export type Role = "admin" | "guest" | "cleaner";

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
/*
 *  `guide`는 이용 안내 페이지(사이트 루트)가 현관 비밀번호·와이파이를 받아 가는 action이다.
 *  손님 전용이라기보다 **손님에게 열려 있어야 하는** action이고, 시간 게이트가 제어보다 15분
 *  이르다(index.ts에서 `withinGuideWindow`로 분기). 값 자체는 handlers/guide.ts에 있다.
 */
const GUEST_ACTIONS = new Set(["list", "command", "automate", "guide"]);

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
 * QR을 찍은 청소 담당자가 부를 수 있는 action. 이 둘이 전부다.
 *
 * 돌려주는 것은 **날짜·시각·예약자 이름**까지다. 담당자가 "언제 누구 예약을 완료 처리하는가"를
 * 아침 다이제스트 문자와 대조할 수 있어야 하기 때문이고(형운 결정, 2026-08-09), 담당자는 이미
 * 그 문자로 이름·인원·용도를 받는 내부 인력이다(`cleaning/templates.ts`).
 *
 * **연락처·이메일·금액은 여전히 안 내린다.** 대조에 쓸모가 없고, 인쇄된 QR은 누구든 찍을 수
 * 있어 안 내리면 안 새는 값이다(`scrubDevices`와 같은 태도). 서버가 예약에서 읽는 컬럼도
 * 다섯으로 묶여 있다(`handlers/cleaning.ts`).
 */
const CLEANER_ACTIONS = new Set(["cleaning_pending", "cleaning_complete"]);

/**
 * 상수 시간 비교는 `_shared/secret.ts`에 있다 — claim·apply도 같은 비밀번호를 검증하므로
 * 구현이 세 군데로 갈라지면 한 곳만 고쳐지는 일이 생긴다.
 *
 * **이제 admin 비밀번호에도 쓴다.** 예전엔 안 썼고 근거도 명확했다 — 같은 값이 `admin_*`
 * SQL 함수에서 평문 `<>`로도 비교되니 여기 한 곳만 조여봐야 소용없다는 것이었다.
 * 그 전제는 `admin_check()` 해시 검증(마이그레이션 20260813110000)이 들어오면서 사라졌다.
 */

/**
 * 자격증명 → 역할. admin과 맞으면 `admin`, 청소 토큰과 맞으면 `cleaner`,
 * 아무것도 안 보냈으면 `guest`, 뭔가 보냈는데 안 맞으면 `null`(=401).
 *
 * **판정 순서가 곧 계약이다.** `password`를 먼저 끝까지 처리해서 "뭔가 보냈는데 admin과 안
 * 맞으면 401"을 그대로 남긴다. 토큰은 비밀번호를 아예 안 보낸 요청에서만 본다 — 둘을 섞으면
 * admin.html의 오타가 알 수 없는 403으로 보이기 시작한다.
 *
 * `CLEANING_TOKEN` 미설정이면 **어떤 토큰도 통과하지 못한다.** 빈 문자열끼리 맞아떨어져
 * 우연히 열리는 일이 없어야 한다 — 시크릿을 안 넣은 상태는 '누구나 청소 완료'가 아니라
 * '아직 안 씀'이다.
 *
 * `ADMIN_PASSWORD` 미설정은 예전과 같이 **전면 거부**다(503). 무인증 제어로 열리는 것보다
 * 닫혀 있는 게 낫다.
 */
export function resolveRole(supplied: string, token = ""): Role | null {
  const admin = Deno.env.get("ADMIN_PASSWORD");
  if (!admin) {
    console.error("ADMIN_PASSWORD 미설정 — 모든 요청을 거부합니다");
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }
  if (constantTimeEqual(supplied, admin)) return "admin";
  if (supplied !== "") return null;

  if (token !== "") {
    const expected = Deno.env.get("CLEANING_TOKEN") ?? "";
    if (expected === "") {
      console.error("CLEANING_TOKEN 미설정 — 청소 QR 요청을 거부합니다");
      return null;
    }
    return constantTimeEqual(token, expected) ? "cleaner" : null;
  }
  return "guest";
}

/** 허용 범위를 벗어난 요청은 403. admin은 그대로 통과한다. */
export function assertAllowed(role: Role, action: string, body: Record<string, unknown>): void {
  if (role === "admin") return;

  if (role === "cleaner") {
    if (!CLEANER_ACTIONS.has(action)) {
      throw new HandlerError(403, "이 QR로는 청소 완료 표시만 할 수 있어요");
    }
    return;
  }

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
