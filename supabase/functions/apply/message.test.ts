/**
 * 알림 조립 테스트. 웹훅 없이 전부 돈다.
 *
 * 핵심은 모양이 아니라 **신청자가 친 글자가 알림의 구조를 못 바꾸는가**다.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildMessage } from "./message.ts";
import type { Application } from "./validate.ts";

const AT = new Date("2026-08-10T05:32:00Z"); // KST 14:32

const APP: Application = {
  name: "홍길동",
  phone: "010-1234-5678",
  email: "hong@example.com",
  instagram: "typelounge",
  purpose: "작은 브랜드 팝업을 준비하고 있어요.",
};

Deno.test("제목·시각·표·목적이 모두 들어간다", () => {
  const msg = buildMessage(APP, AT);
  assertStringIncludes(msg, "**공간 지원 프로그램 신청**");
  assertStringIncludes(msg, "2026. 08. 10. 14:32"); // KST로 찍힌다
  assertStringIncludes(msg, "| 이름 | 홍길동 |");
  assertStringIncludes(msg, "[@typelounge](https://instagram.com/typelounge)");
  assertStringIncludes(msg, "> 작은 브랜드 팝업을 준비하고 있어요.");
});

Deno.test("인스타그램이 없으면 빈 칸 대신 —", () => {
  assertStringIncludes(buildMessage({ ...APP, instagram: null }, AT), "| 인스타그램 | — |");
});

Deno.test("이상한 핸들은 링크로 만들지 않는다", () => {
  const msg = buildMessage({ ...APP, instagram: "a](x)b" }, AT);
  assertEquals(msg.includes("https://instagram.com/a](x)b"), false);
});

Deno.test("이름에 파이프를 넣어도 표가 안 깨진다", () => {
  const msg = buildMessage({ ...APP, name: "홍|길|동" }, AT);
  assertStringIncludes(msg, "| 이름 | 홍\\|길\\|동 |");
  // 표 부분의 줄 수가 그대로여야 한다 — 칸이 쪼개졌으면 여기서 드러난다.
  const tableLines = msg.split("\n").filter((l) => l.startsWith("| "));
  assertEquals(tableLines.length, 5); // 헤더 + 4행
});

Deno.test("칸에 줄바꿈이 와도 표를 끝내지 않는다", () => {
  const msg = buildMessage({ ...APP, name: "홍길동\n악의적인 줄" }, AT);
  assertStringIncludes(msg, "| 이름 | 홍길동 악의적인 줄 |");
});

Deno.test("활용 목적은 여러 줄이 그대로 인용된다", () => {
  const msg = buildMessage({ ...APP, purpose: "첫 줄\n둘째 줄" }, AT);
  assertStringIncludes(msg, "> 첫 줄\n> 둘째 줄");
});
