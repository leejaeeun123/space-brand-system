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
  withEnv({ ADMIN_PASSWORD: null, GUEST_PASSWORD: "123100" }, () => {
    // 손님 비밀번호가 있어도 열리면 안 된다 — 서버가 반쯤 설정된 상태다.
    assertThrows(() => resolveRole("123100"), HandlerError, "서버 설정");
  });
});

Deno.test("GUEST_PASSWORD 미설정은 손님 경로만 닫는다", () => {
  withEnv({ ADMIN_PASSWORD: "adminpw", GUEST_PASSWORD: null }, () => {
    assertEquals(resolveRole("adminpw"), "admin");
    assertEquals(resolveRole("123100"), null);
  });
});

Deno.test("두 비밀번호가 같으면 손님 경로를 닫는다", () => {
  // 같으면 손님 페이지가 admin 비밀번호를 들고 있다는 뜻 = 예약 개인정보가 공개된 것과 같다.
  withEnv({ ADMIN_PASSWORD: "same", GUEST_PASSWORD: "same" }, () => {
    assertEquals(resolveRole("same"), "admin");
  });
});

Deno.test("역할 판정", () => {
  withEnv({ ADMIN_PASSWORD: "adminpw", GUEST_PASSWORD: "123100" }, () => {
    assertEquals(resolveRole("adminpw"), "admin");
    assertEquals(resolveRole("123100"), "guest");
    assertEquals(resolveRole("틀린값"), null);
    assertEquals(resolveRole(""), null);
  });
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
