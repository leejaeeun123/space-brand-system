/**
 * 검증 규칙 테스트. `deno test supabase/functions/apply/` 로 돈다 — DB도 웹훅도 필요 없다.
 *
 * 여기서 지키려는 것은 형식이 아니라 **거절해야 할 것을 거절하는가**다. 통과시키면 안 되는
 * 입력이 통과하면 개인정보가 동의 없이 저장되거나 스팸이 채널을 채운다.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { normalizeInstagram, validate } from "./validate.ts";

const FULL = {
  name: "홍길동",
  phone: "010-1234-5678",
  email: "hong@example.com",
  instagram: "@typelounge",
  purpose: "작은 브랜드 팝업을 준비하고 있어요.",
  consent: true,
};

Deno.test("정상 신청을 통과시키고 값을 정리한다", () => {
  const r = validate({ ...FULL });
  assertEquals(r.ok, true);
  if (!r.ok || "spam" in r) throw new Error("통과했어야 한다");
  assertEquals(r.value.name, "홍길동");
  assertEquals(r.value.instagram, "typelounge"); // @가 벗겨진다
});

Deno.test("인스타그램은 없어도 접수된다", () => {
  const r = validate({ ...FULL, instagram: "" });
  if (!r.ok || "spam" in r) throw new Error("통과했어야 한다");
  assertEquals(r.value.instagram, null);
});

Deno.test("동의가 없으면 거절한다 — 체크박스 없이 fetch로 직접 부른 경우", () => {
  const r = validate({ ...FULL, consent: undefined });
  assertEquals(r.ok, false);
});

Deno.test("동의를 문자열 'true'로 보내도 통과하지 않는다", () => {
  // `=== true`가 아니라 truthy로 보면 "false"라는 문자열도 통과한다.
  const r = validate({ ...FULL, consent: "false" });
  assertEquals(r.ok, false);
});

Deno.test("필수 칸이 비면 거절한다", () => {
  for (const key of ["name", "phone", "email", "purpose"]) {
    const r = validate({ ...FULL, [key]: "   " });
    assertEquals(r.ok, false, `${key}가 비었는데 통과했다`);
  }
});

Deno.test("이메일 형식과 전화번호 자릿수를 본다", () => {
  assertEquals(validate({ ...FULL, email: "hong@example" }).ok, false);
  assertEquals(validate({ ...FULL, phone: "0101234" }).ok, false);
});

Deno.test("너무 긴 입력은 자르지 않고 거절한다", () => {
  const r = validate({ ...FULL, purpose: "가".repeat(1001) });
  assertEquals(r.ok, false);
});

Deno.test("덫에 걸린 요청은 스팸으로 표시하되 성공으로 답한다", () => {
  const r = validate({ ...FULL, website: "http://spam.example" });
  if (!r.ok) throw new Error("성공으로 답해야 한다");
  assertEquals("spam" in r, true);
});

Deno.test("덫이 다른 검증보다 먼저다 — 엉망인 봇 요청도 400을 안 준다", () => {
  const r = validate({ website: "x" });
  if (!r.ok) throw new Error("성공으로 답해야 한다");
  assertEquals("spam" in r, true);
});

Deno.test("인스타그램 입력을 핸들만 남긴다", () => {
  const cases: Array<[string, string]> = [
    ["@typelounge", "typelounge"],
    ["typelounge", "typelounge"],
    ["https://www.instagram.com/typelounge/", "typelounge"],
    ["instagram.com/typelounge?hl=ko", "typelounge"],
    ["  @typelounge  ", "typelounge"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(normalizeInstagram(input), expected, `입력: ${input}`);
  }
});
