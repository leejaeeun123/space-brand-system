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

Deno.test("손님은 목록 조회와 켜기/끄기만 가능하다", () => {
  assertAllowed("guest", "list", {});
  assertAllowed("guest", "command", { command: "power_on" });
  assertAllowed("guest", "command", { command: "power_off" });
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
    assertThrows(() => assertAllowed("guest", action, {}), HandlerError, "켜기/끄기");
  }
});

Deno.test("command action을 열어주는 것만으로는 부족하다 — 명령까지 검사한다", () => {
  // 같은 action이 온도·모드·풍량도 태운다. 손님 화면에 버튼이 없어도 직접 부를 수 있다.
  for (const command of ["set_temp", "set_mode", "set_wind", "", "power_toggle"]) {
    assertThrows(() => assertAllowed("guest", "command", { command }), HandlerError);
  }
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
