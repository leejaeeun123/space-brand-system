/**
 * SOLAPI 클라이언트 테스트 — 네트워크 없이 고정할 수 있는 두 가지만 다룬다.
 *
 * **서명**: 틀리면 벤더가 401만 주고 어디가 틀렸는지는 말해주지 않는다. 알려진 벡터로 박아둔다.
 * **번호 정규화**: 여기가 느슨하면 남의 전화기에 남의 예약 정보가 간다. 경계값을 전부 적는다.
 *
 * 실행: `deno test supabase/functions/control/sms/solapi.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { isoDate, normalizePhone, sign } from "./solapi.ts";

Deno.test("sign — RFC 알려진 벡터와 일치한다", async () => {
  // HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
  // date+salt를 이어붙인 것이 곧 msg이므로 둘로 쪼개 넣어도 같은 값이 나와야 한다.
  const expected = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";
  assertEquals(await sign("key", "The quick brown fox ", "jumps over the lazy dog"), expected);
});

Deno.test("sign — date와 salt는 이어붙인 순서대로 서명된다", async () => {
  // 순서를 바꾸면 다른 서명이 나와야 한다. 같다면 이어붙이지 않고 있다는 뜻이다.
  const a = await sign("secret", "2026-08-08T00:00:00Z", "abc");
  const b = await sign("secret", "abc", "2026-08-08T00:00:00Z");
  assertEquals(a === b, false);
});

Deno.test("isoDate — 밀리초를 떼고 Z로 끝낸다", () => {
  assertEquals(isoDate(new Date("2026-08-08T03:34:56.123Z")), "2026-08-08T03:34:56Z");
});

Deno.test("normalizePhone — 사람이 적는 형태를 전부 받는다", () => {
  const cases: Array<[string, string]> = [
    ["010-4810-9142", "01048109142"],
    ["01048109142", "01048109142"],
    ["010 4810 9142", "01048109142"],
    [" 010.4810.9142 ", "01048109142"],
    ["+82-10-4810-9142", "01048109142"],
    ["+821048109142", "01048109142"],
    ["011-123-4567", "0111234567"], // 10자리 구형 번호는 지금도 유효하다
    ["016-1234-5678", "01612345678"],
  ];
  for (const [raw, expected] of cases) {
    assertEquals(normalizePhone(raw), expected, `입력: ${raw}`);
  }
});

Deno.test("normalizePhone — 문자를 못 받는 번호는 전부 null", () => {
  const rejected = [
    "",
    null,
    undefined,
    "02-1234-5678", // 유선
    "0507-1234-5678", // 안심번호
    "050712345678",
    "0212345678",
    "0104810914", // 자릿수 부족
    "010481091423", // 자릿수 초과
    "013-1234-5678", // 없는 국번
    "+1-415-555-2671", // 해외
    "abc",
    "예약자 연락처 없음",
  ];
  for (const raw of rejected) {
    assertEquals(normalizePhone(raw), null, `입력: ${raw}`);
  }
});
