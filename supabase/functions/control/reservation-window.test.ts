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

/**
 * 마지막 eq()에서 결과를 던지는 최소 체인 — 코드가 쓰는 from/select/in/eq만 구현한다.
 *
 * **행을 그대로 돌려준다.** 예전 구현은 SQL이 걸러준 개수만 셌기 때문에 가짜 클라이언트가
 * `[{id}]` 하나만 줘도 테스트가 통과했고, 그래서 자정을 넘기는 예약이 통째로 뒤집히는 것을
 * 테스트가 못 잡았다. 이제 판정이 TS에 있으니 픽스처도 진짜 예약 행이어야 의미가 있다.
 */
function fakeClient(result: { data: unknown[] | null; error: unknown }): SupabaseClient {
  const builder = {
    from: () => builder,
    select: () => builder,
    in: () => builder,
    eq: () => Promise.resolve(result),
  };
  return builder as unknown as SupabaseClient;
}

function rows(...rs: { date: string; start_time: string; end_time: string }[]) {
  return fakeClient({ data: rs, error: null });
}

Deno.test("예약 구간 안이면 true", async () => {
  const sb = rows({ date: "2026-08-07", start_time: "15:00:00", end_time: "18:00:00" });
  // UTC 07:00 = KST 16:00 — 구간 한가운데.
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

Deno.test("시작 시각은 포함, 종료 시각은 제외 — [시작, 종료)", async () => {
  const r = { date: "2026-08-07", start_time: "15:00:00", end_time: "18:00:00" };
  // KST 15:00 정각 = UTC 06:00 — 열려야 한다.
  assertEquals(await withinReservationWindow(rows(r), new Date("2026-08-07T06:00:00Z")), true);
  // KST 18:00 정각 = UTC 09:00 — end_time은 배타적 상한이라 닫혀야 한다.
  assertEquals(await withinReservationWindow(rows(r), new Date("2026-08-07T09:00:00Z")), false);
});

/**
 * 2026-08-11 한승주 예약(19:00~00:00)이 실제로 깨진 경로다. `end_time`을 같은 날로 읽으면
 * 종료가 시작보다 19시간 이르게 나와, 예약이 진행 중인 내내 게이트가 닫혀 있었다.
 */
Deno.test("자정을 넘기는 예약 — 진행 중이면 열린다", async () => {
  const r = { date: "2026-08-11", start_time: "19:00:00", end_time: "00:00:00" };
  // KST 19:11 = UTC 10:11 — 예약 시작 11분 뒤.
  assertEquals(await withinReservationWindow(rows(r), new Date("2026-08-11T10:11:00Z")), true);
  // KST 23:59 = UTC 14:59 — 아직 예약 중.
  assertEquals(await withinReservationWindow(rows(r), new Date("2026-08-11T14:59:00Z")), true);
  // KST 다음날 00:00 = UTC 15:00 — 종료 정각이라 닫힌다.
  assertEquals(await withinReservationWindow(rows(r), new Date("2026-08-11T15:00:00Z")), false);
});

Deno.test("자정을 넘긴 예약은 어제 날짜인 채로 오늘 새벽까지 열려 있다", async () => {
  // 8/11 22:00~02:00 예약을 8/12 01:00(KST)에 판정한다. 오늘 날짜만 읽으면 이 행을 못 봐서
  // 손님이 자기 예약 중인데도 페이지가 닫힌다.
  const r = { date: "2026-08-11", start_time: "22:00:00", end_time: "02:00:00" };
  assertEquals(await withinReservationWindow(rows(r), new Date("2026-08-11T16:00:00Z")), true);
});

Deno.test("여러 예약 중 하나만 걸려도 열린다", async () => {
  const sb = rows(
    { date: "2026-08-07", start_time: "09:00:00", end_time: "11:00:00" },
    { date: "2026-08-07", start_time: "15:00:00", end_time: "18:00:00" },
  );
  assertEquals(await withinReservationWindow(sb, new Date("2026-08-07T07:00:00Z")), true);
});
