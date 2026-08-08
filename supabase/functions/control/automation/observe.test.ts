/**
 * `observe.ts`의 순수 부분 — 관측 공백 판정만 본다.
 *
 * 이게 테스트할 값어치가 있는 이유: 이 함수가 참이면 그 기기의 현장 조작 판정이 **통째로**
 * 건너뛰어진다. 너무 좁으면 재연결이 '사람이 만졌다'로 나가고(2026-08-08 11:34에 실제로
 * 그랬다), 너무 넓으면 진짜 현장 조작이 조용히 묻힌다.
 *
 * 실행: `deno test supabase/functions/control/automation/observe.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { isContactGap } from "./observe.ts";

const base = new Date("2026-08-08T00:00:00.000Z");
const after = (seconds: number) => new Date(base.getTime() + seconds * 1000);

Deno.test("이용 중 관측 주기(1분)는 공백이 아니다", () => {
  assertEquals(isContactGap(base, after(60)), false);
});

Deno.test("빈 시간의 ThinQ 폴링 주기(600초)도 공백이 아니다", () => {
  // 여기서 참이 되면 빈 시간의 현장 조작이 매번 묻힌다 — 경계를 600초에 딱 붙이면 안 되는 이유.
  assertEquals(isContactGap(base, after(600)), false);
  assertEquals(isContactGap(base, after(1200)), false);
});

Deno.test("1200초를 넘기면 공백이다 — 주기로는 설명이 안 된다", () => {
  assertEquals(isContactGap(base, after(1201)), true);
});

Deno.test("몇 시간 끊긴 기기는 확실히 공백이다", () => {
  // 2026-08-08 아침 바닥 조명 두 대가 이 경우였다. 재연결하며 보고한 자기 상태(ON)가
  // 기준선(OFF)과 달라 둘 다 '현장 조작'으로 나갔다.
  assertEquals(isContactGap(base, after(3 * 3600)), true);
});

Deno.test("판독값이 기준선보다 이르면 공백이 아니다", () => {
  // 캐시가 갱신되지 않아 같은 판독값을 다시 읽는 틱에서는 두 시각이 같다. 음수 간격을
  // 공백으로 치면 매 틱 현장 조작 판정이 통째로 꺼진다.
  assertEquals(isContactGap(base, base), false);
  assertEquals(isContactGap(base, after(-30)), false);
});
