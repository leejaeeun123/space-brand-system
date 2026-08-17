/**
 * `reservation-window.ts` 테스트.
 *
 * 여기가 틀리면 두 방향 다 나쁘다 — 열려야 할 때 닫히면(kstParts 시간대 계산 실수) 손님이
 * 자기 예약 시간에 조명도 못 켜고, DB 오류를 "열림"으로 잘못 해석하면 예약 없는 사람이
 * 기기를 만질 수 있다. 실행: `deno test --allow-env supabase/functions/control/reservation-window.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { kstParts, withinGuideWindow, withinReservationWindow } from "./reservation-window.ts";

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
 *
 * ⚠️ **`.in("date", days)`를 실제로 적용한다.** 예전 fake는 인자를 버리고 행을 전부 돌려줬다.
 * 그러면 조회 **범위**의 버그가 테스트에 아예 보이지 않는다 — 판정 함수는 어떤 행이든 받으면
 * 시각만 비교해 맞는 답을 내므로, 실제로는 그 행을 못 읽는 상황이 통과로 위장된다.
 * 리드타임이 붙은 뒤 이 사각지대에서 진짜 버그가 나왔다(전날 23:50 / `00:00` 시작 예약).
 */
function fakeClient(result: { data: unknown[] | null; error: unknown }): SupabaseClient {
  let days: string[] = [];
  const builder = {
    from: () => builder,
    select: () => builder,
    in: (_col: string, values: string[]) => {
      days = values;
      return builder;
    },
    eq: () =>
      Promise.resolve(
        result.data === null
          ? result
          : {
            ...result,
            data: result.data.filter((r) => days.includes((r as { date: string }).date)),
          },
      ),
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

// ── 이용 안내 페이지 게이트(withinGuideWindow) — 입실 안내 문자와 같은 시각(10분 전)에 열린다 ──

Deno.test("안내 페이지는 입실 10분 전에 열린다 — 제어는 아직 닫혀 있다", async () => {
  const r = { date: "2026-08-07", start_time: "15:00:00", end_time: "18:00:00" };
  // KST 14:50 = UTC 05:50 — 입실 안내 문자가 나가는 시각 정각.
  const at1450 = new Date("2026-08-07T05:50:00Z");
  assertEquals(await withinGuideWindow(rows(r), at1450), true);
  assertEquals(await withinReservationWindow(rows(r), at1450), false);
});

/**
 * 게이트가 문자 스케줄(`checkinNoticeAt`)을 보는지 확인하는 케이스.
 *
 * 기기 준비 시각(입실 15분 전)을 그대로 쓰면 이 시각에 열려버린다 — 문자는 아직 안 나갔는데
 * 페이지가 먼저 열리는 상태이고, 두 숫자가 갈라졌다는 신호다.
 */
Deno.test("입실 15분 전은 아직 닫혀 있다 — 기기 준비 시각이 아니라 문자 시각을 본다", async () => {
  const r = { date: "2026-08-07", start_time: "15:00:00", end_time: "18:00:00" };
  // KST 14:45 = UTC 05:45 — 냉난방·조명 준비가 시작되는 시각.
  assertEquals(await withinGuideWindow(rows(r), new Date("2026-08-07T05:45:00Z")), false);
  // KST 14:49 = UTC 05:49 — 문자 시각 1분 전.
  assertEquals(await withinGuideWindow(rows(r), new Date("2026-08-07T05:49:00Z")), false);
});

Deno.test("안내 페이지도 퇴실 시각에 닫힌다 — 상한은 제어와 같다", async () => {
  const r = { date: "2026-08-07", start_time: "15:00:00", end_time: "18:00:00" };
  // KST 17:59 = UTC 08:59 — 아직 이용 중.
  assertEquals(await withinGuideWindow(rows(r), new Date("2026-08-07T08:59:00Z")), true);
  // KST 18:00 정각 = UTC 09:00 — end_time은 배타적 상한.
  assertEquals(await withinGuideWindow(rows(r), new Date("2026-08-07T09:00:00Z")), false);
});

/**
 * 리드타임이 붙으면서 새로 생긴 경계 — **열리는 시각이 예약 날짜보다 앞선다.**
 *
 * `00:00` 시작 예약은 전날 23:50에 열려야 하는데, 그 시각의 `kstDay(now)`는 아직 전날이다.
 * 조회 범위가 [어제, 오늘]뿐이면 예약 행(내일 날짜)을 못 읽어 게이트가 10분 내내 닫힌다.
 * 0분 리드였던 시절엔 시작 정각에 이미 날짜가 넘어가 있어 드러나지 않았다.
 */
Deno.test("자정 시작 예약은 전날 23:50에 열린다 — 내일 날짜까지 읽어야 한다", async () => {
  const r = { date: "2026-08-08", start_time: "00:00:00", end_time: "04:00:00" };
  // KST 8/7 23:50 = UTC 8/7 14:50 — 입실 10분 전. 판정 시점의 KST 날짜는 아직 8/7이다.
  assertEquals(await withinGuideWindow(rows(r), new Date("2026-08-07T14:50:00Z")), true);
  // KST 8/7 23:49 = UTC 8/7 14:49 — 1분 이르므로 닫혀 있어야 한다(범위를 넓힌 것 자체로
  // 열리지 않는다는 확인).
  assertEquals(await withinGuideWindow(rows(r), new Date("2026-08-07T14:49:00Z")), false);
});

Deno.test("자정을 넘긴 예약은 어제 날짜인 채로 새벽까지 열려 있다", async () => {
  const r = { date: "2026-08-11", start_time: "22:00:00", end_time: "02:00:00" };
  // KST 8/12 01:00 = UTC 8/11 16:00.
  assertEquals(await withinGuideWindow(rows(r), new Date("2026-08-11T16:00:00Z")), true);
});

Deno.test("안내 페이지 게이트도 조회 실패는 닫힘이다 — fail closed", async () => {
  const sb = fakeClient({ data: null, error: new Error("DB 다운") });
  assertEquals(await withinGuideWindow(sb, new Date("2026-08-07T07:00:00Z")), false);
});

Deno.test("예약이 없으면 닫혀 있다", async () => {
  const sb = fakeClient({ data: [], error: null });
  assertEquals(await withinGuideWindow(sb, new Date("2026-08-07T07:00:00Z")), false);
});
