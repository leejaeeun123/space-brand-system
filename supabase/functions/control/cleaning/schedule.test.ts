/**
 * 청소 안내 발송 시각 판정 테스트 — 경계가 전부다.
 *
 * 여기가 틀리면 새벽에 담당자 폰이 울리거나, 아침 문자가 아예 안 나간다. 특히 **KST 00:00~09:00
 * 구간**을 못 박는다 — 런타임이 UTC라 그 시간대에 날짜가 하루 밀리기 쉽고, 개발 맥(KST)에서는
 * 우연히 맞게 나와 테스트로도 안 잡히는 종류의 버그다.
 *
 * 실행: `deno test supabase/functions/control/cleaning/schedule.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { digestDueAt, digestState, quietFrom, updateAllowed } from "./schedule.ts";

function kst(hhmm: string, date = "2026-08-09"): Date {
  return new Date(`${date}T${hhmm}:00+09:00`);
}

Deno.test("다이제스트 — 07:00부터 22:00 전까지 나간다", () => {
  assertEquals(digestState(kst("06:59")), "wait");
  assertEquals(digestState(kst("07:00")), "fire");
  assertEquals(digestState(kst("21:59")), "fire");
  assertEquals(digestState(kst("22:00")), "expired");
  assertEquals(digestState(kst("23:30")), "expired");
});

Deno.test("유예가 짧으면 안 되는 이유 — 늦은 다이제스트도 나가야 한다", () => {
  // 함수가 07:00~08:01 죽어 있다가 살아난 경우. 고정 60분 유예였다면 여기서 만료되고,
  // 변경 안내는 '다이제스트가 sent일 때만' 열리므로 그날 하루가 통째로 침묵했다.
  assertEquals(digestState(kst("08:02")), "fire");
  assertEquals(digestState(kst("15:00")), "fire");
});

Deno.test("변경 안내 — 다이제스트 시각 전과 22시 이후에는 억제된다", () => {
  assertEquals(updateAllowed(kst("06:59")), false);
  assertEquals(updateAllowed(kst("07:00")), true);
  assertEquals(updateAllowed(kst("21:59")), true);
  assertEquals(updateAllowed(kst("22:00")), false);
  assertEquals(updateAllowed(kst("03:00")), false); // 새벽에 폰이 울리지 않는다
});

Deno.test("KST 00:00~09:00 — UTC 런타임에서 날짜가 밀리지 않는다", () => {
  // 이 시각들은 UTC로는 전날이다. 날짜 계산이 UTC를 타면 due가 하루 어긋나 다이제스트가
  // 새벽에 나가거나 아예 안 나간다.
  for (const t of ["00:01", "03:00", "06:00", "08:59"]) {
    const due = digestDueAt(kst(t));
    assertEquals(due.toISOString(), new Date("2026-08-09T07:00:00+09:00").toISOString(), t);
  }
  assertEquals(digestState(kst("00:01")), "wait");
  assertEquals(digestState(kst("08:59")), "fire");
});

Deno.test("경계 시각은 그날 것이다 — 다음 날로 새지 않는다", () => {
  assertEquals(digestDueAt(kst("23:59")).toISOString(), kst("07:00").toISOString());
  assertEquals(quietFrom(kst("00:30")).toISOString(), kst("22:00").toISOString());
});

Deno.test("날짜가 바뀌면 판정도 새 날 기준이다", () => {
  // 8/9 23:30에는 만료, 8/10 07:00에는 다시 발송 — 하루 한 통의 리듬이 여기서 나온다.
  assertEquals(digestState(kst("23:30", "2026-08-09")), "expired");
  assertEquals(digestState(kst("07:00", "2026-08-10")), "fire");
});
