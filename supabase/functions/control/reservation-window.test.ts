/**
 * `reservation-window.ts` 테스트.
 *
 * 여기가 틀리면 두 방향 다 나쁘다 — 열려야 할 때 닫히면(kstParts 시간대 계산 실수) 손님이
 * 자기 예약 시간에 조명도 못 켜고, DB 오류를 "열림"으로 잘못 해석하면 예약 없는 사람이
 * 기기를 만질 수 있다. 실행: `deno test --allow-env supabase/functions/control/reservation-window.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { kstParts, withinReservationWindow } from "./reservation-window.ts";

Deno.test("kstParts — UTC를 KST(UTC+9) 날짜·시각으로 바꾼다", () => {
  assertEquals(kstParts(new Date("2026-08-07T00:30:00Z")), { date: "2026-08-07", time: "09:30:00" });
});

Deno.test("kstParts — 자정을 넘기면 날짜도 넘어간다", () => {
  // UTC 16:00 = KST 다음날 01:00. 날짜 롤오버를 문자열 슬라이스로만 하면 놓치기 쉬운 경계.
  assertEquals(kstParts(new Date("2026-08-06T16:00:00Z")), { date: "2026-08-07", time: "01:00:00" });
});

/** limit()에서 결과를 던지는 최소 체인 — 코드가 쓰는 from/select/eq/lte/gt/limit만 구현한다. */
function fakeClient(result: { data: unknown[] | null; error: unknown }): SupabaseClient {
  const builder = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    lte: () => builder,
    gt: () => builder,
    limit: () => Promise.resolve(result),
  };
  return builder as unknown as SupabaseClient;
}

Deno.test("예약 구간 안이면 true", async () => {
  const sb = fakeClient({ data: [{ id: "r1" }], error: null });
  assertEquals(await withinReservationWindow(sb, new Date("2026-08-07T07:00:00Z")), true);
});

Deno.test("일치하는 예약이 없으면 false", async () => {
  const sb = fakeClient({ data: [], error: null });
  assertEquals(await withinReservationWindow(sb, new Date("2026-08-07T07:00:00Z")), false);
});

Deno.test("조회 실패는 열림이 아니라 닫힘이다 — fail closed", async () => {
  const sb = fakeClient({ data: null, error: new Error("DB 다운") });
  assertEquals(await withinReservationWindow(sb, new Date("2026-08-07T07:00:00Z")), false);
});
