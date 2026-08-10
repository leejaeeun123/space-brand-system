/**
 * 지원금 신청 검증 테스트. 암호화도 DB도 없이 전부 돈다.
 *
 * 가장 중요한 한 건은 **2020-10-06 이후 발급 주민번호를 거절하지 않는가**다.
 * 흔히 쓰는 체크섬 검증을 넣으면 정상 번호가 막히는데, 신청자는 왜 막혔는지 알 길이 없다.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { maskAccount, maskRrn, validate } from "./validate.ts";

const FULL = {
  name: "홍길동",
  phone: "010-1234-5678",
  email: "hong@example.com",
  bookingNo: "SC-20260801-001",
  usedOn: "2026-08-01",
  amount: 50000,
  bank: "국민은행",
  accountHolder: "홍길동",
  account: "123456-78-901234",
  rrn: "990101-1234567",
  reviewDone: true,
  consent: true,
};

Deno.test("리뷰 확인 없이는 통과하지 못한다 — 체크박스는 fetch로 그냥 빠진다", () => {
  assertEquals(validate({ ...FULL, reviewDone: undefined }).ok, false);
  assertEquals(validate({ ...FULL, reviewDone: false }).ok, false);
  // 문자열 "false"도 truthy라, `=== true`가 아니면 여기서 새어 나간다.
  assertEquals(validate({ ...FULL, reviewDone: "false" }).ok, false);
});

Deno.test("리뷰를 확인하면 그 사실이 값에 실린다", () => {
  const r = validate({ ...FULL });
  if (!r.ok || "spam" in r) throw new Error("통과했어야 한다");
  assertEquals(r.value.reviewDone, true);
});

Deno.test("정상 신청을 통과시키고 값을 정리한다", () => {
  const r = validate({ ...FULL });
  if (!r.ok || "spam" in r) throw new Error("통과했어야 한다");
  assertEquals(r.value.account, "12345678901234"); // 하이픈이 벗겨진다
  assertEquals(r.value.rrn, "990101-1234567");
  assertEquals(r.value.amount, 50000);
});

Deno.test("체크섬으로 거르지 않는다 — 2020-10 이후 발급분이 막히면 안 된다", () => {
  // 옛 검증식으로는 틀린 번호지만 실제로 발급될 수 있는 형태다.
  const r = validate({ ...FULL, rrn: "051231-3000000" });
  assertEquals(r.ok, true, "최근 발급 형식을 거절하면 안 된다");
});

Deno.test("하이픈이 없어도 받는다", () => {
  const r = validate({ ...FULL, rrn: "9901011234567" });
  if (!r.ok || "spam" in r) throw new Error("통과했어야 한다");
  assertEquals(r.value.rrn, "990101-1234567"); // 저장은 한 형태로 통일된다
});

Deno.test("말이 안 되는 주민번호는 거절한다", () => {
  for (const rrn of ["990101-9234567", "991301-1234567", "990230-1234567", "99010-1234567", "abcdef-1234567"]) {
    assertEquals(validate({ ...FULL, rrn }).ok, false, `통과하면 안 된다: ${rrn}`);
  }
});

Deno.test("성별코드로 세기를 갈라 생년월일을 본다", () => {
  // 2000년대생: 040229는 윤년이라 유효
  assertEquals(validate({ ...FULL, rrn: "040229-3234567" }).ok, true);
  // 1900년대생으로 읽으면 1904년도 윤년이라 유효
  assertEquals(validate({ ...FULL, rrn: "040229-1234567" }).ok, true);
  // 2001년은 윤년이 아니다
  assertEquals(validate({ ...FULL, rrn: "010229-3234567" }).ok, false);
});

Deno.test("동의 없이는 통과하지 못한다", () => {
  assertEquals(validate({ ...FULL, consent: undefined }).ok, false);
  assertEquals(validate({ ...FULL, consent: "true" }).ok, false);
});

Deno.test("금액은 양의 정수여야 한다", () => {
  for (const amount of [0, -1, 1.5, "오만원", 20_000_000]) {
    assertEquals(validate({ ...FULL, amount }).ok, false, `통과하면 안 된다: ${amount}`);
  }
});

Deno.test("아직 오지 않은 이용일은 청구할 수 없다", () => {
  const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assertEquals(validate({ ...FULL, usedOn: future }).ok, false);
});

Deno.test("예약번호는 없어도 된다 — 전화 예약은 번호가 없다", () => {
  const r = validate({ ...FULL, bookingNo: "" });
  if (!r.ok || "spam" in r) throw new Error("통과했어야 한다");
  assertEquals(r.value.bookingNo, null);
});

Deno.test("계좌번호 자릿수가 말이 안 되면 거절한다", () => {
  assertEquals(validate({ ...FULL, account: "123" }).ok, false);
  assertEquals(validate({ ...FULL, account: "1".repeat(25) }).ok, false);
});

Deno.test("덫에 걸린 요청은 스팸으로 표시하되 성공으로 답한다", () => {
  const r = validate({ ...FULL, website: "http://spam.example" });
  if (!r.ok) throw new Error("성공으로 답해야 한다");
  assertEquals("spam" in r, true);
});

Deno.test("마스킹은 뒷자리를 남기지 않는다 — 주민번호", () => {
  assertEquals(maskRrn("990101-1234567"), "990101-*******");
});

Deno.test("마스킹은 계좌 뒤 4자리만 남긴다", () => {
  assertEquals(maskAccount("12345678901234"), "**********1234");
  assertEquals(maskAccount("123"), "***");
});
