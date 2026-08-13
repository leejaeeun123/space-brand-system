/**
 * 시도 제한과 상수 시간 비교 테스트.
 *
 * 여기가 틀리면 두 방향 모두 조용하다 — 너무 헐거우면 대입 공격이 그대로 통과하고,
 * 너무 빡빡하면 1분마다 오는 `automate`가 스스로 문을 잠가 무인 공간의 자동화가 죽는다
 * (#44·#70에서 실제로 두 번 일어난 실패 모드다). 그래서 **무엇을 세고 무엇을 안 세는지**를
 * 명시적으로 고정한다.
 *
 * 실행: `deno test supabase/functions/_shared/throttle.test.ts`
 */

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { constantTimeEqual } from "./secret.ts";
import { clientIp, isThrottled, recordFailure } from "./throttle.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ── 상수 시간 비교 ────────────────────────────────────────────────────────

Deno.test("같은 값은 참, 다른 값은 거짓", () => {
  assert(constantTimeEqual("hunter2", "hunter2"));
  assertFalse(constantTimeEqual("hunter2", "hunter3"));
});

Deno.test("길이가 달라도 판정이 정확하다", () => {
  // 예전 구현은 길이가 다르면 즉시 false를 돌려줬다. 판정 자체는 맞지만 길이를 재는
  // 채널이 열린다 — 지금은 긴 쪽만큼 항상 돌고, 결과는 여전히 정확해야 한다.
  assertFalse(constantTimeEqual("short", "muchlongerpassword"));
  assertFalse(constantTimeEqual("muchlongerpassword", "short"));
  assertFalse(constantTimeEqual("", "x"));
  assert(constantTimeEqual("", ""));
});

Deno.test("접두사가 같아도 나머지가 다르면 거짓", () => {
  // 조기 반환이 남아 있으면 이런 쌍에서 판정이 갈린다.
  // (실제 비밀번호를 예시로 쓰지 않는다 — 테스트 픽스처도 결국 레포에 남는 평문이다.)
  assertFalse(constantTimeEqual("0000000000", "0000000001"));
  assertFalse(constantTimeEqual("0000000000", "00000000000"));
});

Deno.test("한글·유니코드도 정확히 비교한다", () => {
  assert(constantTimeEqual("비밀번호", "비밀번호"));
  assertFalse(constantTimeEqual("비밀번호", "비밀번효"));
});

// ── 시도 제한 ─────────────────────────────────────────────────────────────

/**
 * `auth_attempts` 조회만 흉내 내는 최소 스텁.
 *
 * 실제 DB를 붙이지 않는 이유는 이 테스트가 검증하려는 것이 SQL이 아니라 **판정 규칙**이라서다
 * — 몇 건부터 막는가, 오류가 나면 어느 쪽으로 기우는가.
 */
function stubClient(
  result: { count?: number; error?: { message: string } },
  onInsert?: (row: Record<string, unknown>) => void,
): SupabaseClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                gte: () => Promise.resolve(result),
              };
            },
          };
        },
        insert(row: Record<string, unknown>) {
          onInsert?.(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
}

Deno.test("상한 미만이면 통과한다", async () => {
  assertFalse(await isThrottled(stubClient({ count: 9 }), "1.2.3.4"));
});

Deno.test("상한에 닿으면 막는다", async () => {
  assert(await isThrottled(stubClient({ count: 10 }), "1.2.3.4"));
  assert(await isThrottled(stubClient({ count: 99 }), "1.2.3.4"));
});

Deno.test("실패 기록이 없으면(count 0) 통과한다", async () => {
  assertFalse(await isThrottled(stubClient({ count: 0 }), "1.2.3.4"));
});

Deno.test("조회가 실패하면 막지 않는다(fail-open)", async () => {
  // 판정 테이블을 못 읽는 상황에서 잠그면 DB 장애가 곧 '어드민 잠김 + 자동화 정지'가 된다.
  // 무인 공간에서 그 대가가 대입 공격의 기대 피해보다 크다는 판단이다(throttle.ts 주석).
  assertFalse(await isThrottled(stubClient({ error: { message: "boom" } }), "1.2.3.4"));
});

Deno.test("실패 기록은 IP와 함수 이름을 남긴다", async () => {
  let saved: Record<string, unknown> | null = null;
  await recordFailure(stubClient({ count: 0 }, (row) => saved = row), "9.9.9.9", "claim");
  assertEquals(saved, { ip: "9.9.9.9", fn: "claim" });
});

// ── 요청자 IP ─────────────────────────────────────────────────────────────

Deno.test("x-forwarded-for의 첫 항목이 원 클라이언트다", () => {
  const req = new Request("https://example.test", {
    headers: { "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" },
  });
  assertEquals(clientIp(req), "203.0.113.7");
});

Deno.test("헤더가 없으면 빈 문자열 — 그래도 판정은 돈다", () => {
  // 헤더 없는 요청이 전부 한 바구니에 담겨 함께 제한될 뿐이라 오히려 보수적이다.
  assertEquals(clientIp(new Request("https://example.test")), "");
});
