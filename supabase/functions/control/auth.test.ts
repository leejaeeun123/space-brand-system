/**
 * `auth.ts` 테스트 — 이 레포에서 유일하게 테스트를 붙인 파일이다.
 *
 * 이유: 여기가 틀리면 손님 페이지가 예약자 개인정보를 여는 열쇠를 들게 되거나(역할 판정 실수),
 * 손님이 기기를 등록 해제할 수 있게 된다(허용 목록 실수). 나머지 핸들러의 실수는 기능이
 * 안 되는 정도지만, 이 파일의 실수는 조용히 열린 채로 잘 돌아간다.
 *
 * 실행: `deno test --allow-env supabase/functions/control/auth.test.ts`
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertAllowed, resolveRole, scrubDevices } from "./auth.ts";
import { HandlerError } from "./handlers/shared.ts";

function withEnv(vars: Record<string, string | null>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) prev.set(key, Deno.env.get(key));
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === null) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("ADMIN_PASSWORD 미설정이면 전면 거부(503)", () => {
  withEnv({ ADMIN_PASSWORD: null }, () => {
    // 빈 값(=손님 경로)이 와도 열리면 안 된다 — 서버가 반쯤 설정된 상태다.
    assertThrows(() => resolveRole(""), HandlerError, "서버 설정");
  });
});

Deno.test("비밀번호를 안 보내면 guest다", () => {
  withEnv({ ADMIN_PASSWORD: "adminpw" }, () => {
    assertEquals(resolveRole(""), "guest");
  });
});

Deno.test("역할 판정", () => {
  withEnv({ ADMIN_PASSWORD: "adminpw" }, () => {
    assertEquals(resolveRole("adminpw"), "admin");
    assertEquals(resolveRole(""), "guest");
    // 뭔가 보냈는데 admin과 안 맞으면 여전히 401이다 — guest로 조용히 낮추면
    // admin.html의 오타가 "비밀번호가 맞지 않아요" 대신 알 수 없는 403으로 보인다.
    assertEquals(resolveRole("틀린값"), null);
  });
});

Deno.test("청소 토큰이 맞으면 cleaner다", () => {
  withEnv({ ADMIN_PASSWORD: "adminpw", CLEANING_TOKEN: "qrtoken" }, () => {
    assertEquals(resolveRole("", "qrtoken"), "cleaner");
    // 틀린 토큰은 guest로 낮추지 않는다 — 담당자가 옛 QR을 찍었을 때 "아무 일도 안
    // 일어남"이 아니라 401로 보여야 QR을 다시 뽑아야 한다는 걸 안다.
    assertEquals(resolveRole("", "틀린토큰"), null);
  });
});

Deno.test("CLEANING_TOKEN 미설정이면 어떤 토큰도 통과하지 못한다", () => {
  withEnv({ ADMIN_PASSWORD: "adminpw", CLEANING_TOKEN: null }, () => {
    // 빈 문자열끼리 맞아떨어져 우연히 열리면, 시크릿을 안 넣은 상태가
    // '아직 안 씀'이 아니라 '누구나 청소 완료'가 된다.
    assertEquals(resolveRole("", "아무거나"), null);
    // 토큰을 안 보낸 요청은 여전히 손님이다 — 손님 페이지가 같이 죽으면 안 된다.
    assertEquals(resolveRole(""), "guest");
  });
});

Deno.test("비밀번호 계약은 토큰이 생겨도 그대로다", () => {
  withEnv({ ADMIN_PASSWORD: "adminpw", CLEANING_TOKEN: "qrtoken" }, () => {
    // 비밀번호를 보낸 요청은 토큰을 보든 말든 비밀번호로 판정이 끝난다.
    // 안 그러면 admin.html의 오타가 다른 역할로 새어 나갈 길이 생긴다.
    assertEquals(resolveRole("틀린값", "qrtoken"), null);
    assertEquals(resolveRole("adminpw", "틀린토큰"), "admin");
  });
});

Deno.test("청소 담당자는 청소 완료 표시만 할 수 있다", () => {
  assertAllowed("cleaner", "cleaning_pending", {});
  assertAllowed("cleaner", "cleaning_complete", {});

  // QR은 인쇄물이라 누구든 찍을 수 있다. 기기 제어도, 예약 정보도, CCTV도 열리면 안 된다.
  for (
    const action of [
      "list",
      "command",
      "automate",
      "delete",
      "register",
      "cameras",
      "camera_credentials",
      "sms_preview",
      "sms_send",
    ]
  ) {
    assertThrows(() => assertAllowed("cleaner", action, {}), HandlerError, "청소 완료 표시만");
  }
});

Deno.test("손님은 청소 완료를 표시할 수 없다", () => {
  for (const action of ["cleaning_pending", "cleaning_complete"]) {
    assertThrows(() => assertAllowed("guest", action, {}), HandlerError, "조명·냉난방");
  }
});

Deno.test("손님은 목록 조회와 냉난방 제어 다섯 가지를 할 수 있다", () => {
  assertAllowed("guest", "list", {});
  for (const command of ["power_on", "power_off", "set_temp", "set_mode", "set_wind"]) {
    assertAllowed("guest", "command", { command });
  }
});

Deno.test("손님은 등록·해제·CCTV를 부를 수 없다", () => {
  for (
    const action of [
      "delete",
      "register",
      "register_light",
      "thinq_devices",
      "cameras",
      "camera_credentials",
      "camera_register",
      "camera_delete",
    ]
  ) {
    assertThrows(() => assertAllowed("guest", action, {}), HandlerError, "조명·냉난방");
  }
});

Deno.test("손님은 문자 action을 부를 수 없다 — 미리보기까지", () => {
  // 발송은 물론이고 `sms_preview`도 막는다. 문구에 예약 일시가 들어가고, 그건 곧
  // '언제 이 공간이 비는가'라는 정보다. 지금은 GUEST_ACTIONS에 없어서 자동으로 막히는데,
  // 나중에 누가 편의로 하나만 열어도 여기서 먼저 깨지게 못을 박아둔다.
  for (const action of ["sms_preview", "sms_send", "sms_mark_manual", "sms_auto"]) {
    assertThrows(() => assertAllowed("guest", action, {}), HandlerError, "조명·냉난방");
  }
});

Deno.test("명령 목록은 여전히 목록이다 — 모르는 명령은 거부한다", () => {
  // 냉난방 다섯 가지를 전부 열었다고 `command` action을 통째로 열어둔 게 아니다.
  // 다음에 명령이 하나 추가되면(기기 초기화 같은 것) 기본값은 '손님은 못 한다'여야 한다.
  for (const command of ["", "power_toggle", "factory_reset", "set_schedule"]) {
    assertThrows(() => assertAllowed("guest", "command", { command }), HandlerError);
  }
});

Deno.test("명령을 열어도 값 검증은 여기 일이 아니다", () => {
  // `auth.ts`는 '어떤 명령을 보낼 수 있나'만 본다. 범위 밖 온도나 없는 모드를 여기서
  // 막지 않는 건 구멍이 아니라, 기기 프로파일을 아는 쪽(`thinq/commands.ts`)이 자를 수
  // 있기 때문이다. 두 계층을 혼동해 여기에 min/max나 enum을 복사해 두면 기기가
  // 바뀔 때 조용히 어긋난다.
  assertAllowed("guest", "command", { command: "set_temp", value: 9999 });
  assertAllowed("guest", "command", { command: "set_mode", value: "NOT_A_MODE" });
});

Deno.test("admin은 무엇이든 통과한다", () => {
  assertAllowed("admin", "delete", {});
  assertAllowed("admin", "command", { command: "set_temp" });
  assertAllowed("admin", "camera_credentials", {});
});

Deno.test("손님 응답에서 기기 주소를 지운다", () => {
  const payload = {
    thinq_configured: true,
    devices: [{ id: "d1", name: "메인 조명", address: "light_main", capabilities: ["power"] }],
  };

  const forGuest = scrubDevices("guest", payload) as typeof payload;
  assertEquals("address" in forGuest.devices[0], false);
  assertEquals(forGuest.devices[0].name, "메인 조명");
  assertEquals(forGuest.thinq_configured, true);
  // 원본은 그대로다 — 응답 하나 손보려고 캐시를 변형하지 않는다.
  assertEquals(payload.devices[0].address, "light_main");

  assertEquals(scrubDevices("admin", payload), payload);
});
