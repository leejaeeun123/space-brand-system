/**
 * 결과 안내 문구 테스트. 발송 없이 전부 돈다.
 *
 * 여기서 지키려는 것은 문장의 아름다움이 아니라 **약속한 정보가 빠지지 않는가**다.
 * 링크 하나가 빠지면 선정자는 예약도 페이백도 못 한다.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { APPLICATION_SMS_KINDS, render } from "./templates.ts";

/** LMS 상한. 넘으면 벤더가 거절하거나 SMS로 떨어져 잘린다. */
const LMS_LIMIT = 2000;

function eucKrBytes(s: string): number {
  // Deno에 euc-kr 인코더가 없다. 한글 2바이트 + 그 외 1바이트로 센다 —
  // 실제 EUC-KR과 같은 값이 나오는 근사이고, 상한 판정에는 충분하다.
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0)! > 0x7f ? 2 : 1;
  return n;
}

Deno.test("선정 문구에 4단계와 링크가 모두 있다", () => {
  const m = render("selected");
  assertStringIncludes(m, "선정되셨습니다");
  assertStringIncludes(m, "https://www.spacecloud.kr/space/80401");
  assertStringIncludes(m, "https://typelounge.vercel.app/payback");
  assertStringIncludes(m, "리뷰");
  assertStringIncludes(m, "3.3%");
  // 순서가 뒤집히면 안 된다 — 예약이 리뷰보다 먼저다.
  assertEquals(m.indexOf("spacecloud.kr") < m.indexOf("리뷰"), true);
  assertEquals(m.indexOf("리뷰") < m.indexOf("payback"), true);
});

Deno.test("선정 문구가 12시간 상한을 알린다", () => {
  const m = render("selected");
  assertStringIncludes(m, "12시간");
  // '한 번에 다 써야 하나'로 읽히지 않게 하는 문장.
  assertStringIncludes(m, "나눠서");
});

Deno.test("선정 문구가 '결제 후 환급' 구조를 밝힌다", () => {
  // 이 문장이 없으면 "지원인데 왜 내가 결제하지?"로 문의가 몰린다.
  assertStringIncludes(render("selected"), "결제하신 금액을 이용 후 돌려드리는");
});

Deno.test("보류 문구가 대기임을 알리고 재신청을 막는다", () => {
  const m = render("held");
  assertStringIncludes(m, "대기");
  assertStringIncludes(m, "연락드릴게요");
  assertStringIncludes(m, "다시 신청하지 않으셔도");
});

Deno.test("보류 문구에 예약·페이백 링크가 없다 — 아직 이용할 수 없다", () => {
  const m = render("held");
  assertEquals(m.includes("spacecloud.kr"), false);
  assertEquals(m.includes("payback"), false);
});

Deno.test("두 문구 모두 후원 크레딧을 담는다", () => {
  for (const kind of APPLICATION_SMS_KINDS) {
    assertStringIncludes(render(kind), "ANTIEGG와 NMWC의 공동 후원");
  }
});

Deno.test("두 문구 모두 발신 주체와 연락처를 밝힌다", () => {
  for (const kind of APPLICATION_SMS_KINDS) {
    const m = render(kind);
    // 발신 주체는 타입라운지다 — 후원사가 아니라.
    assertEquals(m.startsWith("[타입라운지]"), true, `${kind}: 첫 줄이 발신 주체여야 한다`);
    assertStringIncludes(m, "010-4810-9142");
    // 후원 크레딧이 연락처보다 앞에 온다 — 맨 앞에 두면 누가 보낸 문자인지 흐려진다.
    assertEquals(m.indexOf("공동 후원") < m.indexOf("010-4810-9142"), true);
  }
});

Deno.test("두 문구 모두 LMS 상한 안에 들어간다", () => {
  for (const kind of APPLICATION_SMS_KINDS) {
    const bytes = eucKrBytes(render(kind));
    assertEquals(bytes < LMS_LIMIT, true, `${kind}: ${bytes}바이트로 상한을 넘었다`);
  }
});
